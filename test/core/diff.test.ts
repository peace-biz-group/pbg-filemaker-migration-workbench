import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeRun, listRuns } from '../../src/core/pipeline-runner.js';
import { buildRunDiffSummaryV1, findComparableRun } from '../../src/core/run-diff-summary.js';
import { loadConfig } from '../../src/config/defaults.js';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';

const OUTPUT = join(import.meta.dirname, '..', 'output-diff-test');
const F = join(import.meta.dirname, '..', 'fixtures');

describe('run diff', () => {
  let config: ReturnType<typeof loadConfig>;

  beforeAll(() => {
    config = loadConfig();
    config.outputDir = OUTPUT;
    mkdirSync(OUTPUT, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(OUTPUT)) rmSync(OUTPUT, { recursive: true, force: true });
  });

  it('second run of same file produces run-diff.json', async () => {
    const file = join(F, 'utf8.csv');

    const r1 = await executeRun('run-all', [file], config);
    expect(r1.status).toBe('completed');
    expect(r1.sourceBatchId).toBeTruthy();
    expect(r1.logicalSourceKey).toBeTruthy();

    const r2 = await executeRun('run-all', [file], config);
    expect(r2.status).toBe('completed');
    expect(r2.previousRunId).toBe(r1.id);

    const diffPath = join(r2.outputDir, 'run-diff.json');
    expect(existsSync(diffPath)).toBe(true);

    const diff = JSON.parse(readFileSync(diffPath, 'utf-8'));
    expect(diff.previousRunId).toBe(r1.id);
    expect(diff.currentRunId).toBe(r2.id);
    expect(diff.totals.recordCountDelta).toBe(0); // same file
  });

  it('ingest-diagnoses.json is written', async () => {
    const runs = listRuns(OUTPUT);
    const diagPath = join(runs[0]!.outputDir, 'ingest-diagnoses.json');
    expect(existsSync(diagPath)).toBe(true);
    const diag = JSON.parse(readFileSync(diagPath, 'utf-8'));
    expect(Object.keys(diag).length).toBeGreaterThan(0);
  });
});

describe('buildRunDiffSummaryV1', () => {
  const OUTPUT2 = join(import.meta.dirname, '..', 'output-diff-v1-test');
  let config2: ReturnType<typeof loadConfig>;

  beforeAll(() => {
    config2 = loadConfig();
    config2.outputDir = OUTPUT2;
    mkdirSync(OUTPUT2, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(OUTPUT2)) rmSync(OUTPUT2, { recursive: true, force: true });
  });

  it('comparable previous run がない場合は run-diff.json が存在しないか no_comparable になる', async () => {
    const file = join(F, 'utf8.csv');
    const r = await executeRun('run-all', [file], config2);
    expect(r.status).toBe('completed');
    const diffPath = join(r.outputDir, 'run-diff.json');
    if (existsSync(diffPath)) {
      const diff = JSON.parse(readFileSync(diffPath, 'utf-8'));
      expect(diff.classification).toBe('no_comparable');
    }
    // findComparableRun も null を返す
    const comparable = findComparableRun(OUTPUT2, r);
    expect(comparable).toBeNull();
  });

  it('同じファイルを2回実行すると sameRawFingerprint=true かつ same_content になる', async () => {
    const file = join(F, 'utf8.csv');
    await executeRun('run-all', [file], config2); // 1回目（comparable として使われる）
    const r2 = await executeRun('run-all', [file], config2); // 2回目
    expect(r2.status).toBe('completed');
    expect(r2.previousRunId).toBeTruthy(); // 前回 run が見つかること

    const diffPath = join(r2.outputDir, 'run-diff.json');
    expect(existsSync(diffPath)).toBe(true);
    const diff = JSON.parse(readFileSync(diffPath, 'utf-8'));

    expect(diff.version).toBe(1);
    expect(diff.currentRunId).toBe(r2.id);
    expect(diff.previousRunId).toBeTruthy();
    expect(diff.sameRawFingerprint).toBe(true);
    expect(diff.sameSchemaFingerprint).toBe(true);
    expect(diff.classification).toBe('same_content');
    expect(diff.classificationLabel).toBe('前回と同じ内容');
    expect(diff.totals.recordCountDelta).toBe(0);
  });

  it('findComparableRun は profileId が一致する run を優先する', async () => {
    const file = join(F, 'utf8.csv');
    // profileId を設定した run を作成
    const r1 = await executeRun('run-all', [file], config2, undefined, { profileId: 'unique-test-profile' });
    const r2 = await executeRun('run-all', [file], config2, undefined, { profileId: 'unique-test-profile' });
    expect(r2.profileId).toBe('unique-test-profile');

    const comparable = findComparableRun(OUTPUT2, r2);
    // profileId 一致の run が返り、その profileId が一致している
    expect(comparable).not.toBeNull();
    const comparablePid = comparable!.profileId ?? comparable!.fastPathProfileId;
    expect(comparablePid).toBe('unique-test-profile');
    // r1 か r1 以前の profileId 一致 run を返す（少なくとも r1 を含む）
    expect([r1.id]).toContain(comparable!.id);
  });

  it('buildRunDiffSummaryV1 は previousRunId が設定された run で V1 summary を返す', async () => {
    const file = join(F, 'utf8.csv');
    await executeRun('run-all', [file], config2); // warmup
    const r = await executeRun('run-all', [file], config2);
    expect(r.previousRunId).toBeTruthy();

    const summary = buildRunDiffSummaryV1(OUTPUT2, r);
    expect(summary).not.toBeNull();
    expect(summary!.version).toBe(1);
    expect(summary!.currentRunId).toBe(r.id);
    expect(summary!.classification).toBeDefined();
    expect(summary!.classificationLabel).toBeTruthy();
    expect(Array.isArray(summary!.addedColumns)).toBe(true);
    expect(Array.isArray(summary!.removedColumns)).toBe(true);
  });
});
