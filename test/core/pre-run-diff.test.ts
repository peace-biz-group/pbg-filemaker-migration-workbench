import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildPreRunDiffPreview, buildColumnsDriftContext } from '../../src/core/pre-run-diff.js';
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
      filename: 'never_seen_xyz_file_abc.csv',
      columnCount: 5,
    });
    expect(result.classification).toBe('first_import');
    expect(result.classificationLabel).toBe('初めての取り込みです');
    expect(result.previousRunId).toBeNull();
    expect(result.sameRawFingerprint).toBeNull();
    expect(result.duplicateWarning).toBe(false);
  });

  it('同じ sourceFileHash の run がある場合は same_file かつ duplicateWarning=true を返す', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], config);
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
    expect(result.duplicateWarning).toBe(true);
  });

  it('sourceFileHash が異なる場合は duplicate warning にならない', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], config);
    expect(r1.status).toBe('completed');

    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: 'different-hash-value-does-not-match',
      columnCount: r1.summary?.columnCount ?? 1,
    });
    // comparable run は見つかるが raw fingerprint は違う
    expect(result.previousRunId).toBe(r1.id);
    expect(result.sameRawFingerprint).toBe(false);
    expect(result.duplicateWarning).toBe(false);
  });

  it('列数が変わっていると column_changed を返す', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], config);
    expect(r1.status).toBe('completed');
    const prevCols = r1.summary?.columnCount ?? 1;

    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: 'different-hash',
      columnCount: prevCols + 3,
    });
    expect(result.classification).toBe('column_changed');
    expect(result.classificationLabel).toBe('列の形が変わっています');
    expect(result.columnCountDelta).toBe(3);
    expect(result.duplicateWarning).toBe(false);
  });

  it('必須フィールドが常に揃っている（API shape 安定）', () => {
    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'test.csv',
      columnCount: 3,
    });
    expect(result.version).toBe(1);
    expect(result).toHaveProperty('previousRunId');
    expect(result).toHaveProperty('sameRawFingerprint');
    expect(result).toHaveProperty('sameSchemaFingerprint');
    expect(result).toHaveProperty('columnCountCurr');
    expect(result).toHaveProperty('classification');
    expect(result).toHaveProperty('classificationLabel');
    expect(result).toHaveProperty('duplicateWarning');
    expect(result).toHaveProperty('schemaDriftGuard');
  });

  // ---- schema drift guard tests ----

  it('column_changed のとき schemaDriftGuard が true になる', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], config);
    expect(r1.status).toBe('completed');
    const prevCols = r1.summary?.columnCount ?? 1;

    // 列数を変えて渡す → column_changed → schemaDriftGuard = true
    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: 'different-hash',
      columnCount: prevCols + 2,
    });
    expect(result.classification).toBe('column_changed');
    expect(result.schemaDriftGuard).toBe(true);
  });

  it('duplicate warning のみで schema drift がない場合は schemaDriftGuard が false', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], config);
    expect(r1.status).toBe('completed');

    const hash = Object.values(r1.sourceFileHashes ?? {})[0]!;
    // 同じ raw hash + 同じ列数 → same_file（duplicate warning あり、schema drift なし）
    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: hash,
      columnCount: r1.summary?.columnCount ?? 1,
    });
    expect(result.classification).toBe('same_file');
    expect(result.duplicateWarning).toBe(true);
    expect(result.schemaDriftGuard).toBe(false);
  });

  it('schema drift guard なし（row_changed）では schemaDriftGuard が false', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], config);
    expect(r1.status).toBe('completed');
    const prevCols = r1.summary?.columnCount ?? 1;

    // 同じ列数・hash 不一致 → row_changed
    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: 'different-hash',
      columnCount: prevCols,
    });
    expect(result.classification).toBe('row_changed');
    expect(result.schemaDriftGuard).toBe(false);
  });

  it('schemaDriftGuard が出た run で schema drift 系フィールドが run meta に記録される', async () => {
    const file = join(F, 'utf8.csv');
    const meta = await executeRun('profile', [file], {
      ...config,
      outputDir: OUTPUT,
    }, undefined, {
      schemaDriftWarningShown: true,
      schemaDriftOverride: true,
    });

    expect(meta.status).toBe('completed');
    expect(meta.schemaDriftWarningShown).toBe(true);
    expect(meta.schemaDriftOverride).toBe(true);

    // run-meta.json に永続化されていることを確認
    const { readFileSync } = await import('node:fs');
    const saved = JSON.parse(readFileSync(`${meta.outputDir}/run-meta.json`, 'utf-8'));
    expect(saved.schemaDriftWarningShown).toBe(true);
    expect(saved.schemaDriftOverride).toBe(true);
  });

  it('schema drift なしの通常実行では schemaDrift 系フィールドが undefined になる', async () => {
    const file = join(F, 'utf8.csv');
    const meta = await executeRun('profile', [file], {
      ...config,
      outputDir: OUTPUT,
    });

    expect(meta.schemaDriftWarningShown).toBeUndefined();
    expect(meta.schemaDriftOverride).toBeUndefined();
  });

  it('first_import でも schemaDriftGuard は false', () => {
    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'completely_new_file_xyz_no_history.csv',
      columnCount: 5,
    });
    expect(result.classification).toBe('first_import');
    expect(result.schemaDriftGuard).toBe(false);
  });

  it('duplicate warning を表示した上で override 実行すると run meta に記録される', async () => {
    const file = join(F, 'utf8.csv');
    const meta = await executeRun('profile', [file], {
      ...config,
      outputDir: OUTPUT,
    }, undefined, {
      duplicateWarningShown: true,
      duplicateOverride: true,
    });

    expect(meta.status).toBe('completed');
    expect(meta.duplicateWarningShown).toBe(true);
    expect(meta.duplicateOverride).toBe(true);

    // run-meta.json に永続化されていることを確認
    const { readFileSync } = await import('node:fs');
    const saved = JSON.parse(readFileSync(`${meta.outputDir}/run-meta.json`, 'utf-8'));
    expect(saved.duplicateWarningShown).toBe(true);
    expect(saved.duplicateOverride).toBe(true);
  });

  it('duplicateWarning なしの通常実行では duplicate フィールドが undefined になる', async () => {
    const file = join(F, 'utf8.csv');
    const meta = await executeRun('profile', [file], {
      ...config,
      outputDir: OUTPUT,
    });

    expect(meta.duplicateWarningShown).toBeUndefined();
    expect(meta.duplicateOverride).toBeUndefined();
  });

  it('built-in profile と candidate profile で logicalSourceKey が一致し comparable run が見つかる', async () => {
    // utf8.csv で実行
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], { ...config, outputDir: OUTPUT });
    expect(r1.status).toBe('completed');

    // 同じ filename で pre-run preview → comparable run が見つかるはず
    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',  // basename が同じ → logicalSourceKey が一致
      columnCount: r1.summary?.columnCount ?? 1,
    });
    expect(result.previousRunId).not.toBeNull();
  });
});

describe('buildColumnsDriftContext', () => {
  let config: ReturnType<typeof loadConfig>;

  beforeAll(() => {
    config = loadConfig();
    config.outputDir = OUTPUT;
    mkdirSync(OUTPUT, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(OUTPUT)) rmSync(OUTPUT, { recursive: true, force: true });
  });

  it('previousRunId がない run では null を返す', () => {
    const result = buildColumnsDriftContext(OUTPUT, 'nonexistent-run-id');
    expect(result).toBeNull();
  });

  it('comparable previous run がある場合に drift context を返す', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], config);
    expect(r1.status).toBe('completed');

    const r2 = await executeRun('profile', [file], config);
    expect(r2.status).toBe('completed');
    expect(r2.previousRunId).toBe(r1.id);

    const ctx = buildColumnsDriftContext(OUTPUT, r2.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.version).toBe(1);
    expect(ctx!.previousRunId).toBe(r1.id);
    expect(Array.isArray(ctx!.currentColumnNames)).toBe(true);
  });

  it('列が変わっていない場合 addedColumns と removedColumns が空', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], config);
    const r2 = await executeRun('profile', [file], config);

    const ctx = buildColumnsDriftContext(OUTPUT, r2.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.addedColumns).toHaveLength(0);
    expect(ctx!.removedColumns).toHaveLength(0);
  });

  it('addedColumns / removedColumns が正しく計算される（columnNames を直接書き換えて検証）', async () => {
    const { writeFileSync } = await import('node:fs');
    const file = join(F, 'utf8.csv');

    const r1 = await executeRun('profile', [file], config);
    const r1Meta = { ...r1, columnNames: ['氏名', '電話番号', '住所'] };
    writeFileSync(`${r1.outputDir}/run-meta.json`, JSON.stringify(r1Meta, null, 2), 'utf-8');

    const r2 = await executeRun('profile', [file], config);
    const r2Meta = { ...r2, previousRunId: r1.id, columnNames: ['氏名', '電話番号', '会社名'] };
    writeFileSync(`${r2.outputDir}/run-meta.json`, JSON.stringify(r2Meta, null, 2), 'utf-8');

    const ctx = buildColumnsDriftContext(OUTPUT, r2.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.addedColumns).toEqual(['会社名']);
    expect(ctx!.removedColumns).toEqual(['住所']);
  });

  it('comparable previous run はあるが columnNames が未保存の場合 addedColumns / removedColumns は空', async () => {
    const { writeFileSync } = await import('node:fs');
    const file = join(F, 'utf8.csv');

    // r1 を作成して columnNames を削除（古い run を模倣）
    const r1 = await executeRun('profile', [file], config);
    const r1Meta = { ...r1 };
    delete (r1Meta as Partial<typeof r1Meta>).columnNames;
    writeFileSync(`${r1.outputDir}/run-meta.json`, JSON.stringify(r1Meta, null, 2), 'utf-8');

    // r2 を作成して previousRunId を r1 に明示的に設定（タイムスタンプ衝突対策）
    const r2 = await executeRun('profile', [file], config);
    const r2Meta = { ...r2, previousRunId: r1.id };
    writeFileSync(`${r2.outputDir}/run-meta.json`, JSON.stringify(r2Meta, null, 2), 'utf-8');

    const ctx = buildColumnsDriftContext(OUTPUT, r2.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.previousColumnNames).toBeNull();
    expect(ctx!.addedColumns).toHaveLength(0);
    expect(ctx!.removedColumns).toHaveLength(0);
  });

  it('schema drift warning が表示された場合 schemaDriftWarningShown が true', async () => {
    const { writeFileSync } = await import('node:fs');
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], config);
    const r2 = await executeRun('profile', [file], config, undefined, {
      schemaDriftWarningShown: true,
    });
    // previousRunId が r1 を指すよう明示的に設定（タイムスタンプ衝突対策）
    const r2Meta = { ...r2, previousRunId: r1.id };
    writeFileSync(`${r2.outputDir}/run-meta.json`, JSON.stringify(r2Meta, null, 2), 'utf-8');

    const ctx = buildColumnsDriftContext(OUTPUT, r2.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.schemaDriftWarningShown).toBe(true);
  });

  it('schema drift warning がない場合 schemaDriftWarningShown が false', async () => {
    const file = join(F, 'utf8.csv');
    await executeRun('profile', [file], config);
    const r2 = await executeRun('profile', [file], config);

    const ctx = buildColumnsDriftContext(OUTPUT, r2.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.schemaDriftWarningShown).toBe(false);
  });
});
