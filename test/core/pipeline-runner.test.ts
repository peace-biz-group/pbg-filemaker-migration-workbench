import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeRun, listRuns, getRun, getRunOutputFiles } from '../../src/core/pipeline-runner.js';
import { loadConfig } from '../../src/config/defaults.js';
import { mkdirSync, rmSync, existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as XLSX from 'xlsx';
import { parse as parseCsvSync } from 'csv-parse/sync';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const APO_LIST = join(FIXTURES, 'apo_list_2024.csv');
const PRODUCT_CUSTOMERS = join(FIXTURES, 'product_a_customers.csv');
const CONFIG_PATH = join(FIXTURES, 'test-batch.config.json');
const OUTPUT = join(import.meta.dirname, '..', 'output-runner-test');

function createTempXlsx(rows: (string | number)[][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'runner-xlsx-'));
  const filePath = join(dir, `sample-${Math.random().toString(36).slice(2, 8)}.xlsx`);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  writeFileSync(filePath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return filePath;
}

describe('Pipeline runner', () => {
  let config: ReturnType<typeof loadConfig>;

  beforeAll(() => {
    config = loadConfig(CONFIG_PATH);
    config.outputDir = OUTPUT;
    mkdirSync(OUTPUT, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(OUTPUT)) {
      rmSync(OUTPUT, { recursive: true, force: true });
    }
  });

  it('executes run-all and creates run metadata', async () => {
    const meta = await executeRun('run-all', [APO_LIST], config, CONFIG_PATH);
    expect(meta.status).toBe('completed');
    expect(meta.id).toBeTruthy();
    expect(meta.summary).toBeDefined();
    expect(meta.summary!.recordCount).toBeGreaterThan(0);
    expect(existsSync(join(meta.outputDir, 'run-meta.json'))).toBe(true);
    expect(existsSync(join(meta.outputDir, 'normalized.csv'))).toBe(true);
    expect(meta.sourceBatchId).toBeTruthy();
    expect(meta.logicalSourceKey).toBeTruthy();
  });

  it('executes run-batch with multiple files', async () => {
    const meta = await executeRun('run-batch', [APO_LIST, PRODUCT_CUSTOMERS], config, CONFIG_PATH);
    expect(meta.status).toBe('completed');
    expect(meta.summary!.normalizedCount).toBeGreaterThan(0);
    expect(meta.summary!.duplicateGroupCount).toBeGreaterThan(0);
  });

  it('lists runs', async () => {
    const runs = listRuns(OUTPUT);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs[0].id).toBeTruthy();
  });

  it('gets single run', async () => {
    const runs = listRuns(OUTPUT);
    const run = getRun(OUTPUT, runs[0].id);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
  });

  it('gets run output files', async () => {
    const runs = listRuns(OUTPUT);
    const files = getRunOutputFiles(OUTPUT, runs[0].id);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('normalized.csv');
  });

  it('handles missing file gracefully', async () => {
    const meta = await executeRun('profile', ['/nonexistent/file.csv'], config);
    expect(meta.status).toBe('failed');
    expect(meta.error).toBeTruthy();
  });

  it('executeRun 後の run meta に columnNames が保存される', async () => {
    const file = join(FIXTURES, 'utf8.csv');
    const meta = await executeRun('profile', [file], config);
    expect(meta.status).toBe('completed');
    expect(meta.columnNames).toBeDefined();
    expect(Array.isArray(meta.columnNames)).toBe(true);
    expect(meta.columnNames!.length).toBeGreaterThan(0);

    // run-meta.json に永続化されていること
    const { readFileSync } = await import('node:fs');
    const saved = JSON.parse(readFileSync(`${meta.outputDir}/run-meta.json`, 'utf-8'));
    expect(saved.columnNames).toEqual(meta.columnNames);
  });

  it('normalize の XLSX 実行でも rows があれば summary と ingest diagnosis が 0 固定にならない', async () => {
    const xlsxPath = createTempXlsx([
      ['電話番号【検索】', '内容', '担当者'],
      ['090-1111-2222', '折返し希望', '山田'],
      ['090-3333-4444', '不在', '佐藤'],
    ]);

    try {
      const meta = await executeRun('normalize', [xlsxPath], config);
      const saved = JSON.parse(readFileSync(`${meta.outputDir}/run-meta.json`, 'utf-8'));
      const diagnosis = JSON.parse(readFileSync(join(meta.outputDir, 'ingest-diagnoses.json'), 'utf-8'));

      expect(meta.status).toBe('completed');
      expect(saved.summary.recordCount).toBe(2);
      expect(saved.summary.columnCount).toBe(3);
      expect(saved.summary.normalizedCount + saved.summary.quarantineCount).toBe(2);
      expect(diagnosis[xlsxPath].totalRowsRead).toBe(2);
    } finally {
      rmSync(dirname(xlsxPath), { recursive: true, force: true });
    }
  });

  it('mixed parent-child customer export は safe parent だけ mainline 候補へ進める', async () => {
    const xlsxPath = createTempXlsx([
      ['お客様ID', '契約者', '住所', '電話番号', '営業担当', 'ｺｰﾙ履歴::日付', 'ｺｰﾙ履歴::時刻', 'ｺｰﾙ履歴::担当者', 'ｺｰﾙ履歴::内容'],
      ['RC001', '田中太郎', '東京都新宿区1-1-1', '090-1111-2222', '久保田', '2024/03/01', '09:00:00', '佐藤', '初回連絡'],
      ['', '', '', '', '', '2024/03/02', '10:00:00', '佐藤', '追い架電'],
      ['RC002', '佐藤花子', '大阪府大阪市2-2-2', '090-3333-4444', '古賀', '', '', '', ''],
      ['', '山本次郎', '', '', '', '2024/03/04', '12:00:00', '古賀', '判定保留'],
    ]);

    try {
      const meta = await executeRun('run-all', [xlsxPath], config);
      const saved = JSON.parse(readFileSync(`${meta.outputDir}/run-meta.json`, 'utf-8'));
      const sourceBatches = JSON.parse(readFileSync(join(meta.outputDir, 'source-batches.json'), 'utf-8'));
      const extraction = JSON.parse(readFileSync(join(meta.outputDir, 'parent-extraction-diagnostics.json'), 'utf-8'));
      const routing = JSON.parse(readFileSync(join(meta.outputDir, 'source-routing.json'), 'utf-8'));
      const diagnosis = JSON.parse(readFileSync(join(meta.outputDir, 'ingest-diagnoses.json'), 'utf-8'));
      const handoff = JSON.parse(readFileSync(join(meta.outputDir, 'handoff-summary.json'), 'utf-8'));
      const rows = parseCsvSync(readFileSync(join(meta.outputDir, 'normalized.csv'), 'utf-8'), { columns: true, skip_empty_lines: true, bom: true }) as Array<Record<string, string>>;
      const quarantineRows = parseCsvSync(readFileSync(join(meta.outputDir, 'quarantine.csv'), 'utf-8'), { columns: true, skip_empty_lines: true, bom: true }) as Array<Record<string, string>>;

      expect(meta.status).toBe('completed');
      expect(saved.sourceModes[xlsxPath]).toBe('mainline');
      expect(saved.sourceRouting[xlsxPath].mixedParentChildExport).toBe(true);
      expect(routing[xlsxPath].matchedProfileId).toBe('customer-list');
      expect(sourceBatches[0].mode).toBe('mainline');
      expect(String(sourceBatches[0].notes)).toContain('mainline');
      expect(diagnosis[xlsxPath].totalRowsRead).toBe(4);

      expect(saved.summary.recordCount).toBe(4);
      expect(saved.summary.normalizedCount).toBe(3);
      expect(saved.summary.quarantineCount).toBe(1);
      expect(saved.summary.totalRecordCount).toBe(3);
      expect(saved.summary.mainlineReadyCount).toBe(2);
      expect(saved.summary.reviewCount).toBe(1);
      expect(saved.summary.archiveOnlyCount).toBe(0);
      expect(saved.summary.reviewReasonBreakdown.mixed_parent_child_ambiguous).toBe(1);
      expect(saved.summary.skippedArchiveCount).toBe(0);
      expect(saved.summary.skippedReviewCount).toBe(1);
      expect(saved.summary.insertedCount).toBe(2);
      expect(saved.summary.sourceRecordFlows[xlsxPath]).toMatchObject({
        inputRowCount: 4,
        normalizedRowCount: 3,
        quarantineRowCount: 1,
        parentCandidateRowCount: 2,
        ambiguousParentRowCount: 1,
        childOnlyContinuationRowCount: 1,
        mixedParentChildRowCount: 2,
      });
      expect(saved.summary.parentExtractionSummaries[xlsxPath]).toMatchObject({
        extractedParentCount: 2,
        ambiguousParentCount: 1,
        childContinuationCount: 1,
      });
      expect(extraction[xlsxPath].classificationBreakdown.parent_candidate).toBe(2);
      expect(extraction[xlsxPath].classificationBreakdown.ambiguous_parent).toBe(1);
      expect(extraction[xlsxPath].classificationBreakdown.child_continuation).toBe(1);

      expect(rows).toHaveLength(3);
      expect(rows.filter((row) => row._merge_eligibility === 'mainline_ready')).toHaveLength(2);
      expect(rows.filter((row) => row._review_reason === 'mixed_parent_child_ambiguous')).toHaveLength(1);
      expect(rows.filter((row) => row._final_disposition === 'inserted')).toHaveLength(2);
      expect(rows.find((row) => row.customer_id === 'RC001')?._parent_extraction_classification).toBe('parent_candidate');
      expect(rows.find((row) => row.customer_id === 'RC002')?._parent_extraction_classification).toBe('parent_candidate');
      expect(rows.find((row) => row.customer_name === '山本次郎')?._merge_eligibility).toBe('review');
      expect(rows.find((row) => row.customer_name === '山本次郎')?._review_reason).toBe('mixed_parent_child_ambiguous');
      expect(quarantineRows).toHaveLength(1);
      expect(quarantineRows[0]?._quarantine_reason).toBe('CHILD_CONTINUATION');
      expect(quarantineRows[0]?._final_disposition).toBe('quarantine');
      expect(saved.summary.countReconciliation.unaccountedRowCount).toBe(0);
      expect(saved.summary.handoffBundle.counts.opsCoreReady).toBe(2);
      expect(saved.summary.handoffBundle.counts.reviewPack).toBe(1);
      expect(saved.summary.handoffBundle.counts.quarantinePack).toBe(1);
      expect(saved.summary.handoffBundle.artifacts.reviewPack.finalDispositionBreakdown.review).toBe(1);
      expect(saved.summary.handoffBundle.artifacts.reviewPack.finalDispositionBreakdown.archive_only).toBe(0);
      expect(saved.summary.nextActionView.artifacts[0].file).toBe('review-pack.csv');
      expect(saved.summary.nextActionView.artifacts[2].file).toBe('mainline-handoff.csv');
      expect(handoff.integrity.matchesReconciliation).toBe(true);
    } finally {
      rmSync(dirname(xlsxPath), { recursive: true, force: true });
    }
  });

  it('count reconciliation で parent extraction から final disposition まで説明できる', async () => {
    const xlsxPath = createTempXlsx([
      ['お客様ID', '契約者', '会社名', '設置住所', '住所', '電話番号', 'ｺｰﾙ履歴::日付', 'ｺｰﾙ履歴::内容'],
      ['RC100', '田中太郎', '', '', '東京都千代田区1-1', '090-1111-2222', '2024/03/01', '初回'],
      ['RC100', '田中太郎', '', '', '東京都千代田区1-1', '090-1111-2222', '2024/03/01', '初回'],
      ['RC101', '', '', '', '', '', '2024/03/02', 'ID only'],
      ['', '山本次郎', '', '', '', '', '2024/03/03', 'name only'],
      ['', '', 'テスト商事', '大阪市北区1-1', '', '', '2024/03/04', 'ambiguous A'],
      ['', '', 'テスト商事', '大阪市北区2-2', '', '', '2024/03/05', 'ambiguous B'],
      ['', '', '', '', '', '', '2024/03/06', 'child only'],
    ]);

    try {
      const meta = await executeRun('run-all', [xlsxPath], config);
      const saved = JSON.parse(readFileSync(`${meta.outputDir}/run-meta.json`, 'utf-8'));
      const reconciliation = JSON.parse(readFileSync(join(meta.outputDir, 'count-reconciliation.json'), 'utf-8'));
      const handoff = JSON.parse(readFileSync(join(meta.outputDir, 'handoff-summary.json'), 'utf-8'));
      const rows = parseCsvSync(readFileSync(join(meta.outputDir, 'normalized.csv'), 'utf-8'), { columns: true, skip_empty_lines: true, bom: true }) as Array<Record<string, string>>;
      const quarantineRows = parseCsvSync(readFileSync(join(meta.outputDir, 'quarantine.csv'), 'utf-8'), { columns: true, skip_empty_lines: true, bom: true }) as Array<Record<string, string>>;

      expect(meta.status).toBe('completed');
      expect(saved.summary.normalizedCount).toBe(5);
      expect(saved.summary.quarantineCount).toBe(2);
      expect(saved.summary.totalRecordCount).toBe(5);
      expect(saved.summary.mainlineReadyCount).toBe(2);
      expect(saved.summary.reviewCount).toBe(3);
      expect(saved.summary.insertedCount).toBe(1);
      expect(saved.summary.duplicateCount).toBe(1);
      expect(saved.summary.reviewReasonBreakdown.mixed_parent_child_ambiguous).toBe(1);
      expect(saved.summary.reviewReasonBreakdown.deterministic_collision).toBe(2);
      expect(saved.summary.countReconciliation.inputRowCount).toBe(7);
      expect(saved.summary.countReconciliation.accountedRowCount).toBe(7);
      expect(saved.summary.countReconciliation.unaccountedRowCount).toBe(0);
      expect(saved.summary.countReconciliation.parentExtractionBreakdown.parent_candidate).toBe(3);
      expect(saved.summary.countReconciliation.parentExtractionBreakdown.ambiguous_parent).toBe(3);
      expect(saved.summary.countReconciliation.parentExtractionBreakdown.child_continuation).toBe(1);
      expect(saved.summary.countReconciliation.extractionToDisposition.parent_candidate.inserted).toBe(1);
      expect(saved.summary.countReconciliation.extractionToDisposition.parent_candidate.duplicate).toBe(1);
      expect(saved.summary.countReconciliation.extractionToDisposition.parent_candidate.quarantine).toBe(1);
      expect(saved.summary.countReconciliation.extractionToDisposition.ambiguous_parent.review).toBe(3);
      expect(saved.summary.countReconciliation.extractionToDisposition.child_continuation.quarantine).toBe(1);
      expect(saved.summary.countReconciliation.eligibilityToDisposition.mainline_ready.inserted).toBe(1);
      expect(saved.summary.countReconciliation.eligibilityToDisposition.mainline_ready.duplicate).toBe(1);
      expect(saved.summary.countReconciliation.dispositionReasonByFinalDisposition.review.mixed_parent_child_ambiguous).toBe(1);
      expect(saved.summary.countReconciliation.dispositionReasonByFinalDisposition.review.deterministic_collision).toBe(2);
      expect(saved.summary.countReconciliation.dispositionReasonByFinalDisposition.quarantine.BUSINESS_KEY_EMPTY).toBe(1);
      expect(saved.summary.countReconciliation.dispositionReasonByFinalDisposition.quarantine.CHILD_CONTINUATION).toBe(1);
      expect(reconciliation.unaccountedRowCount).toBe(0);
      expect(handoff.counts.opsCoreReady).toBe(2);
      expect(handoff.counts.reviewPack).toBe(3);
      expect(handoff.counts.quarantinePack).toBe(2);
      expect(handoff.artifacts.reviewPack.finalDispositionBreakdown.review).toBe(3);
      expect(handoff.artifacts.reviewPack.finalDispositionBreakdown.archive_only).toBe(0);
      expect(saved.nextActionView.artifacts.map((artifact: { file: string }) => artifact.file)).toEqual([
        'review-pack.csv',
        'quarantine-pack.csv',
        'mainline-handoff.csv',
      ]);

      expect(rows.filter((row) => row._final_disposition === 'inserted')).toHaveLength(1);
      expect(rows.filter((row) => row._final_disposition === 'duplicate')).toHaveLength(1);
      expect(rows.filter((row) => row._final_disposition === 'review')).toHaveLength(3);
      expect(quarantineRows.filter((row) => row._final_disposition === 'quarantine')).toHaveLength(2);
      expect(quarantineRows.some((row) => row._quarantine_reason === 'BUSINESS_KEY_EMPTY')).toBe(true);
      expect(quarantineRows.some((row) => row._quarantine_reason === 'CHILD_CONTINUATION')).toBe(true);
    } finally {
      rmSync(dirname(xlsxPath), { recursive: true, force: true });
    }
  });
});
