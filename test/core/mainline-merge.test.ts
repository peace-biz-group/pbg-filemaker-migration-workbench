import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeCsv } from '../../src/io/csv-writer.js';
import { mergeMainlineRows } from '../../src/core/mainline-merge.js';
import { loadConfig } from '../../src/config/defaults.js';
import { executeRun } from '../../src/core/pipeline-runner.js';
import { defaultStatePath, readState, type MergeLedgerEntry } from '../../src/core/import-state.js';

function baseConfig(outputDir: string) {
  const cfg = loadConfig();
  cfg.outputDir = outputDir;
  cfg.diffKeys = {
    '*.csv': {
      recordIdField: 'fm_record_id',
      updatedAtField: 'updated_at',
      naturalKeyFields: ['customer_name', 'phone'],
      fingerprintFields: ['customer_name', 'phone', 'note'],
      mode: 'mainline',
    },
  };
  return cfg;
}

describe('mainline merge ledger', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wb-merge-'));
  });

  it('同一ファイル再投入でも duplicate として扱い二重化しない', async () => {
    const normalized = join(dir, 'normalized.csv');
    await writeCsv(normalized, [
      { _source_key: 'apolist', _source_file: 'apo.csv', _row_fingerprint: 'f1', fm_record_id: '1', updated_at: '2026-01-01', customer_name: 'A', phone: '0901', note: 'x' },
    ]);

    const ledger: Record<string, MergeLedgerEntry> = {};
    const config = baseConfig(dir);
    const first = await mergeMainlineRows({
      normalizedPath: normalized,
      sourceBatchBySourceKey: { apolist: 'b1' },
      modeBySourceKey: { apolist: 'mainline' },
      importRunId: 'r1',
      config,
      ledger,
    });
    const second = await mergeMainlineRows({
      normalizedPath: normalized,
      sourceBatchBySourceKey: { apolist: 'b1' },
      modeBySourceKey: { apolist: 'mainline' },
      importRunId: 'r2',
      config,
      ledger,
    });

    expect(first.inserted).toBe(1);
    expect(second.duplicate).toBe(1);
    expect(Object.keys(ledger)).toHaveLength(1);
  });

  it('同一record id + 新しいupdated_atは updated 扱い', async () => {
    const normalized = join(dir, 'normalized.csv');
    await writeCsv(normalized, [
      { _source_key: 'apolist', _source_file: 'apo.csv', _row_fingerprint: 'f1', fm_record_id: '1', updated_at: '2026-01-01', customer_name: 'A', phone: '0901', note: 'x' },
    ]);

    const ledger: Record<string, MergeLedgerEntry> = {};
    const config = baseConfig(dir);
    const res = await mergeMainlineRows({
      normalizedPath: normalized,
      sourceBatchBySourceKey: { apolist: 'b2' },
      modeBySourceKey: { apolist: 'mainline' },
      importRunId: 'r3',
      config,
      ledger,
    });

    expect(res.inserted).toBe(1);
    expect(res.updated).toBe(0);

    const normalized2 = join(dir, 'normalized2.csv');
    await writeCsv(normalized2, [
      { _source_key: 'apolist', _source_file: 'apo.csv', _row_fingerprint: 'f3', fm_record_id: '1', updated_at: '2026-01-02', customer_name: 'A', phone: '0901', note: 'changed again' },
    ]);
    const res2 = await mergeMainlineRows({
      normalizedPath: normalized2,
      sourceBatchBySourceKey: { apolist: 'b3' },
      modeBySourceKey: { apolist: 'mainline' },
      importRunId: 'r4',
      config,
      ledger,
    });
    expect(res2.updated).toBe(1);
  });

  it('record id なしでも natural key / fingerprint fallback で安定', async () => {
    const normalized = join(dir, 'normalized.csv');
    await writeCsv(normalized, [
      { _source_key: 'cust', _source_file: 'cust.csv', _row_fingerprint: 'nf1', customer_name: 'Tanaka', phone: '031234', note: 'memo' },
      { _source_key: 'cust', _source_file: 'cust.csv', _row_fingerprint: 'nf1', customer_name: 'Tanaka', phone: '031234', note: 'memo' },
    ]);

    const ledger: Record<string, MergeLedgerEntry> = {};
    const config = baseConfig(dir);
    const res = await mergeMainlineRows({
      normalizedPath: normalized,
      sourceBatchBySourceKey: { cust: 'b1' },
      modeBySourceKey: { cust: 'mainline' },
      importRunId: 'r1',
      config,
      ledger,
    });

    expect(res.inserted).toBe(1);
    expect(res.duplicate).toBe(1);
  });

  it('archive mode は mainline merge 対象外', async () => {
    const normalized = join(dir, 'normalized.csv');
    await writeCsv(normalized, [
      { _source_key: 'legacy', _source_file: 'legacy.csv', _row_fingerprint: 'a1', fm_record_id: '9', updated_at: '2026-01-01', customer_name: 'Old', phone: '000' },
    ]);
    const ledger: Record<string, MergeLedgerEntry> = {};
    const config = baseConfig(dir);
    const res = await mergeMainlineRows({
      normalizedPath: normalized,
      sourceBatchBySourceKey: { legacy: 'ba' },
      modeBySourceKey: { legacy: 'archive' },
      importRunId: 'r1',
      config,
      ledger,
    });

    expect(res.skipped_archive).toBe(1);
    expect(Object.keys(ledger)).toHaveLength(0);
  });

  it('merge_eligibility=review は mainline merge しない', async () => {
    const normalized = join(dir, 'normalized.csv');
    await writeCsv(normalized, [
      { _source_key: 'cust', _source_file: 'cust.csv', _merge_eligibility: 'review', _source_record_key: 'rk1', _structural_fingerprint: 'sf1', fm_record_id: '1' },
    ]);
    const ledger: Record<string, MergeLedgerEntry> = {};
    const config = baseConfig(dir);
    const res = await mergeMainlineRows({
      normalizedPath: normalized,
      sourceBatchBySourceKey: { cust: 'b1' },
      modeBySourceKey: { cust: 'mainline' },
      importRunId: 'r1',
      config,
      ledger,
    });
    expect(res.skipped_review).toBe(1);
    expect(Object.keys(ledger)).toHaveLength(0);
  });

  it('non-mainline列だけ変わる場合は mainline update しない', async () => {
    const normalized = join(dir, 'normalized.csv');
    await writeCsv(normalized, [
      {
        _source_key: 'cust', _source_file: 'customer.csv', _merge_eligibility: 'mainline_ready',
        _source_record_key: 'rk1', _structural_fingerprint_full: 'full1', _structural_fingerprint_mainline: 'main1',
        internal_note: 'A', customer_name: '田中', phone: '0311112222',
      },
    ]);
    const normalized2 = join(dir, 'normalized2.csv');
    await writeCsv(normalized2, [
      {
        _source_key: 'cust', _source_file: 'customer.csv', _merge_eligibility: 'mainline_ready',
        _source_record_key: 'rk1', _structural_fingerprint_full: 'full2', _structural_fingerprint_mainline: 'main1',
        internal_note: 'B', customer_name: '田中', phone: '0311112222',
      },
    ]);
    const ledger: Record<string, MergeLedgerEntry> = {};
    const config = baseConfig(dir);
    await mergeMainlineRows({
      normalizedPath: normalized,
      sourceBatchBySourceKey: { cust: 'b1' },
      modeBySourceKey: { cust: 'mainline' },
      importRunId: 'r1',
      config,
      ledger,
    });
    const res2 = await mergeMainlineRows({
      normalizedPath: normalized2,
      sourceBatchBySourceKey: { cust: 'b2' },
      modeBySourceKey: { cust: 'mainline' },
      importRunId: 'r2',
      config,
      ledger,
    });
    expect(res2.updated).toBe(0);
    expect(res2.unchanged).toBe(1);
  });

  it('source_batch/import_run が state に永続化される', async () => {
    const fixtures = join(import.meta.dirname, '..', 'fixtures');
    const file = join(fixtures, 'apo_list_2024.csv');
    const config = baseConfig(dir);
    config.inputs = [{ path: file, label: 'apo', sourceKey: 'apolist', mode: 'mainline' }];

    const meta = await executeRun('run-all', [file], config);
    expect(meta.status).toBe('completed');

    const statePath = defaultStatePath(dir);
    expect(existsSync(statePath)).toBe(true);
    const state = readState(statePath);
    expect(state.source_batches.length).toBeGreaterThan(0);
    expect(state.import_runs.some((r) => r.import_run_id === meta.id)).toBe(true);
    expect(existsSync(join(meta.outputDir, 'source-batches.json'))).toBe(true);
    expect(existsSync(join(meta.outputDir, 'import-run.json'))).toBe(true);
    expect(existsSync(join(meta.outputDir, 'merge-summary.json'))).toBe(true);

    const importRun = JSON.parse(readFileSync(join(meta.outputDir, 'import-run.json'), 'utf-8')) as { status: string };
    expect(importRun.status).toBe('completed');

    rmSync(dir, { recursive: true, force: true });
  });

  it('deterministic collision は review_reason=deterministic_collision になる', async () => {
    const fixtures = join(import.meta.dirname, '..', 'fixtures', 'identity');
    const file = join(fixtures, 'customer_collision.csv');
    const config = baseConfig(dir);
    config.identityStrategies = {
      '*.csv': {
        recordFamily: 'customer_master_like',
        deterministicFields: ['customer_name', 'company_name', 'phone'],
        mainlineFingerprintFields: ['customer_name', 'company_name', 'phone', 'email'],
      },
    };
    config.inputs = [{ path: file, label: 'collision', sourceKey: 'cust', mode: 'mainline' }];

    const meta = await executeRun('run-all', [file], config);
    expect(meta.status).toBe('completed');

    const normalizedPath = join(meta.outputDir, 'normalized.csv');
    const { parse: parseCsvSync } = await import('csv-parse/sync');
    const rows = parseCsvSync(readFileSync(normalizedPath, 'utf-8'), { columns: true, skip_empty_lines: true, bom: true }) as Array<Record<string, string>>;
    expect(rows.every(r => r._merge_eligibility === 'review')).toBe(true);
    expect(rows.every(r => r._review_reason === 'deterministic_collision')).toBe(true);
    expect(existsSync(join(meta.outputDir, 'deterministic-collisions.json'))).toBe(true);
    expect((meta.summary?.identityWarningCount ?? 0)).toBeGreaterThan(0);
  });

  it('activity deterministic collision でも review_reason=deterministic_collision になる', async () => {
    const fixtures = join(import.meta.dirname, '..', 'fixtures', 'identity', 'activity');
    const file = join(fixtures, 'call_activity_collision.csv');
    const config = baseConfig(dir);
    config.identityStrategies = {
      '*.csv': {
        recordFamily: 'call_activity',
        deterministicFields: ['customer_name', 'phone', 'activity_date', 'operator', 'result_code'],
        mainlineFingerprintFields: ['customer_name', 'phone', 'activity_date', 'operator', 'result_code', 'note'],
      },
    };
    config.inputs = [{ path: file, label: 'call-collision', sourceKey: 'call', mode: 'mainline' }];

    const meta = await executeRun('run-all', [file], config);
    const normalizedPath = join(meta.outputDir, 'normalized.csv');
    const { parse: parseCsvSync } = await import('csv-parse/sync');
    const rows = parseCsvSync(readFileSync(normalizedPath, 'utf-8'), { columns: true, skip_empty_lines: true, bom: true }) as Array<Record<string, string>>;
    expect(rows.every(r => r._review_reason === 'deterministic_collision')).toBe(true);
    expect(rows.every(r => r._merge_eligibility === 'review')).toBe(true);
  });

  it('apo_list 非 mainline 列変更は merge update にならない', async () => {
    const fixtures = join(import.meta.dirname, '..', 'fixtures', 'identity', 'activity');
    const fileA = join(fixtures, 'apo_list_col_a.csv');
    const fileB = join(fixtures, 'apo_list_non_mainline_changed.csv');
    const config = baseConfig(dir);
    config.identityStrategies = {
      '*.csv': {
        recordFamily: 'apo_list',
        deterministicFields: ['customer_name', 'phone', 'activity_date', 'activity_type'],
        mainlineFingerprintFields: ['customer_name', 'phone', 'activity_date', 'activity_type', 'note'],
      },
    };
    config.inputs = [{ path: fileA, label: 'apo-a', sourceKey: 'apo', mode: 'mainline' }];
    const first = await executeRun('run-all', [fileA], config);
    expect((first.summary?.insertedCount ?? 0)).toBeGreaterThan(0);

    config.inputs = [{ path: fileB, label: 'apo-b', sourceKey: 'apo', mode: 'mainline' }];
    const second = await executeRun('run-all', [fileB], config);
    expect(second.summary?.updatedCount ?? 0).toBe(0);
    expect((second.summary?.unchangedCount ?? 0) + (second.summary?.duplicateCount ?? 0)).toBeGreaterThan(0);
  });
});
