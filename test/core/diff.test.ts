import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeRun, listRuns } from '../../src/core/pipeline-runner.js';
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
