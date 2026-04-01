import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCandidateProfile,
  saveCandidateProfile,
  loadAllCandidateProfiles,
  isCandidateProfile,
} from '../../src/file-profiles/candidate-profile.js';
import type { EffectiveMappingResult } from '../../src/core/effective-mapping.js';

const TMP_DIR = join(import.meta.dirname, '..', 'output-candidate-profile-test');

const sampleEffectiveMapping: EffectiveMappingResult = {
  runId: 'run-001',
  profileId: 'customer-list',
  generatedAt: '2026-04-01T00:00:00.000Z',
  mapping: { '会社名': 'company_name', '電話番号': 'phone' },
  activeCount: 2,
  unusedCount: 1,
  pendingCount: 0,
  columns: [
    { position: 0, sourceHeader: '会社名', canonicalKey: 'company_name', label: '取引先', status: 'active', required: 'yes' },
    { position: 1, sourceHeader: '電話番号', canonicalKey: 'phone', label: '電話番号', status: 'active', required: 'no' },
    { position: 2, sourceHeader: '旧フラグ', canonicalKey: 'old_flag', label: '旧フラグ', status: 'unused', required: 'no' },
  ],
};

describe('buildCandidateProfile', () => {
  it('effective mapping から candidate profile を生成できる', () => {
    const candidate = buildCandidateProfile(
      'run-001',
      '顧客一覧_2024.csv',
      sampleEffectiveMapping,
      { label: '顧客一覧（仮）', defaultEncoding: 'cp932', defaultHasHeader: true },
    );

    expect(candidate.id).toBe('candidate-run-001-customer-list');
    expect(candidate.candidate).toBe(true);
    expect(candidate.provisional).toBe(true);
    expect(candidate.generatedFromRunId).toBe('run-001');
    expect(candidate.sourceFilename).toBe('顧客一覧_2024.csv');
    expect(candidate.label).toBe('顧客一覧（仮）');
    expect(candidate.defaultEncoding).toBe('cp932');
    expect(candidate.defaultHasHeader).toBe(true);
    expect(candidate.category).toBe('生成された設定');
  });

  it('全列（active/unused/pending）が columns に含まれる', () => {
    const candidate = buildCandidateProfile('run-001', '顧客一覧.csv', sampleEffectiveMapping, {});
    expect(candidate.columns).toHaveLength(3);
  });

  it('active 列の position が previewColumns に含まれる（最大4件）', () => {
    const candidate = buildCandidateProfile('run-001', 'test.csv', sampleEffectiveMapping, {});
    expect(candidate.previewColumns).toContain(0);
    expect(candidate.previewColumns).toContain(1);
    expect(candidate.previewColumns).not.toContain(2);
    expect(candidate.previewColumns.length).toBeLessThanOrEqual(4);
  });

  it('sourceHeader が ColumnDef.headerHints に含まれる', () => {
    const candidate = buildCandidateProfile('run-001', 'test.csv', sampleEffectiveMapping, {});
    const col0 = candidate.columns.find(c => c.position === 0)!;
    expect(col0.headerHints).toContain('会社名');
    expect(col0.key).toBe('company_name');
    expect(col0.label).toBe('取引先');
    expect(col0.required).toBe(true);
  });

  it('ファイル名からファイル名ヒントを生成する', () => {
    const candidate = buildCandidateProfile('run-001', '顧客一覧_2024.csv', sampleEffectiveMapping, {});
    expect(candidate.filenameHints.some(h => h.includes('顧客一覧_2024'))).toBe(true);
  });

  it('label 未指定の場合は sourceFilename のステムを使う', () => {
    const candidate = buildCandidateProfile('run-001', '顧客一覧.csv', sampleEffectiveMapping, {});
    expect(candidate.label).toBe('顧客一覧');
  });

  it('columnCount が em.columns.length と一致する', () => {
    const candidate = buildCandidateProfile('run-001', 'test.csv', sampleEffectiveMapping, {});
    // sampleEffectiveMapping.columns.length === 3
    expect(candidate.columnCount).toBe(3);
  });

  it('headerlessSuitable を override で指定できる', () => {
    const candidate = buildCandidateProfile(
      'run-001',
      'test.csv',
      sampleEffectiveMapping,
      { headerlessSuitable: true },
    );
    expect(candidate.headerlessSuitable).toBe(true);
  });

  it('defaultHasHeader: false のとき headerlessSuitable が自動で true になる', () => {
    const candidate = buildCandidateProfile(
      'run-001',
      'test.csv',
      sampleEffectiveMapping,
      { defaultHasHeader: false },
    );
    expect(candidate.headerlessSuitable).toBe(true);
  });

  it('headerlessSuitable: true かつ defaultHasHeader: true は共存できる', () => {
    const candidate = buildCandidateProfile(
      'run-001',
      'test.csv',
      sampleEffectiveMapping,
      { headerlessSuitable: true, defaultHasHeader: true },
    );
    expect(candidate.headerlessSuitable).toBe(true);
    expect(candidate.defaultHasHeader).toBe(true);
  });
});

describe('isCandidateProfile', () => {
  it('candidate: true のプロファイルを判定できる', () => {
    const candidate = buildCandidateProfile('run-001', 'test.csv', sampleEffectiveMapping, {});
    expect(isCandidateProfile(candidate)).toBe(true);
  });

  it('seed profile（candidate フィールドなし）は false を返す', () => {
    const seed = {
      id: 'customer-list',
      label: '顧客一覧',
      filenameHints: [],
      defaultEncoding: 'cp932' as const,
      defaultHasHeader: true,
      columns: [],
      previewColumns: [],
      category: '顧客管理系',
      provisional: true,
    };
    expect(isCandidateProfile(seed)).toBe(false);
  });
});

describe('candidate profile persistence', () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('保存して loadAllCandidateProfiles で読み込める', () => {
    const candidate = buildCandidateProfile('run-save-01', 'test.csv', sampleEffectiveMapping, {});
    saveCandidateProfile(TMP_DIR, candidate);

    const all = loadAllCandidateProfiles(TMP_DIR);
    expect(all.length).toBeGreaterThanOrEqual(1);
    const found = all.find(p => p.id === candidate.id);
    expect(found).toBeDefined();
    expect(found!.candidate).toBe(true);
    expect(found!.generatedFromRunId).toBe('run-save-01');
  });

  it('ディレクトリが存在しない場合は空配列を返す', () => {
    const result = loadAllCandidateProfiles('/tmp/nonexistent-candidate-test-dir-xyz');
    expect(result).toEqual([]);
  });

  it('複数の candidate を保存して全件取得できる', () => {
    const mapping2: EffectiveMappingResult = {
      ...sampleEffectiveMapping,
      runId: 'run-002',
      profileId: 'apo-list',
    };
    const c1 = buildCandidateProfile('run-002a', 'file-a.csv', sampleEffectiveMapping, {});
    const c2 = buildCandidateProfile('run-002b', 'file-b.csv', mapping2, {});
    saveCandidateProfile(TMP_DIR, c1);
    saveCandidateProfile(TMP_DIR, c2);

    const all = loadAllCandidateProfiles(TMP_DIR);
    const ids = all.map(p => p.id);
    expect(ids).toContain(c1.id);
    expect(ids).toContain(c2.id);
  });
});
