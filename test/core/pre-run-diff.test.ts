import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildPreRunDiffPreview } from '../../src/core/pre-run-diff.js';
import { executeRun } from '../../src/core/pipeline-runner.js';
import { loadConfig } from '../../src/config/defaults.js';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

const OUTPUT = join(import.meta.dirname, '..', 'output-pre-run-diff-test');
const F = join(import.meta.dirname, '..', 'fixtures');

describe('buildPreRunDiffPreview', () => {
  let config: ReturnType<typeof loadConfig>;

  beforeAll(() => {
    config = loadConfig();
    config.outputDir = OUTPUT;
    mkdirSync(OUTPUT, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(OUTPUT)) rmSync(OUTPUT, { recursive: true, force: true });
  });

  it('comparable run がない場合は first_import を返す', () => {
    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'never_seen_file_xyz.csv',
      columnCount: 5,
    });
    expect(result.classification).toBe('first_import');
    expect(result.classificationLabel).toBe('初めての取り込みです');
    expect(result.previousRunId).toBeNull();
    expect(result.fastPathRecommended).toBe(false);
    expect(result.columnReviewRecommended).toBe(false);
  });

  it('同じ sourceFileHash の run がある場合は same_file を返す', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('run-all', [file], config);
    expect(r1.status).toBe('completed');

    const hash = Object.values(r1.sourceFileHashes ?? {})[0]!;
    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: hash,
      columnCount: r1.summary?.columnCount ?? 1,
    });
    expect(result.classification).toBe('same_file');
    expect(result.classificationLabel).toBe('前回とほぼ同じです');
    expect(result.previousRunId).toBe(r1.id);
    expect(result.sameRawFingerprint).toBe(true);
    expect(result.fastPathRecommended).toBe(false); // profileId なしなので
  });

  it('profileId が一致する場合 fastPathRecommended=true になる', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('run-all', [file], config, undefined, { profileId: 'test-profile-fp' });
    const hash = Object.values(r1.sourceFileHashes ?? {})[0]!;

    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: hash,
      columnCount: r1.summary?.columnCount ?? 1,
      profileId: 'test-profile-fp',
    });
    expect(result.classification).toBe('same_file');
    expect(result.fastPathRecommended).toBe(true);
  });

  it('列数が変わっていると column_changed を返す', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('run-all', [file], config);
    expect(r1.status).toBe('completed');
    const prevCols = r1.summary?.columnCount ?? 1;

    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: 'different-hash-does-not-match',
      columnCount: prevCols + 3,
    });
    expect(result.classification).toBe('column_changed');
    expect(result.classificationLabel).toBe('列の形が変わっています');
    expect(result.columnReviewRecommended).toBe(true);
    expect(result.columnCountDelta).toBe(3);
  });

  it('profileId が一致する run のみを比較対象にする（built-in / candidate 両対応）', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('run-all', [file], config, undefined, { profileId: 'candidate-profile-001' });
    const hash = Object.values(r1.sourceFileHashes ?? {})[0]!;
    const cols = r1.summary?.columnCount ?? 1;

    // 一致しない profileId → first_import（異なるプロファイルの run で誤比較しない）
    const resultNoMatch = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: hash,
      columnCount: cols,
      profileId: 'some-other-profile-never-run',
    });
    expect(resultNoMatch.previousRunId).toBeNull();
    expect(resultNoMatch.classification).toBe('first_import');

    // 一致する candidate profileId → r1 を比較対象として返す
    const resultCandidate = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: hash,
      columnCount: cols,
      profileId: 'candidate-profile-001',
    });
    expect(resultCandidate.previousRunId).toBe(r1.id);
    expect(resultCandidate.classification).toBe('same_file');
  });

  it('confirm 向け API shape が安定して返る（必須フィールド）', () => {
    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'test.csv',
      columnCount: 3,
    });
    expect(result.version).toBe(1);
    expect(result).toHaveProperty('previousRunId');
    expect(result).toHaveProperty('profileId');
    expect(result).toHaveProperty('sameRawFingerprint');
    expect(result).toHaveProperty('sameSchemaFingerprint');
    expect(result).toHaveProperty('columnCountCurr');
    expect(result).toHaveProperty('classification');
    expect(result).toHaveProperty('classificationLabel');
    expect(result).toHaveProperty('fastPathRecommended');
    expect(result).toHaveProperty('columnReviewRecommended');
  });
});
