import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeRun, listRuns, getRun, getRunOutputFiles } from '../../src/core/pipeline-runner.js';
import { loadConfig } from '../../src/config/defaults.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const APO_LIST = join(FIXTURES, 'apo_list_2024.csv');
const PRODUCT_CUSTOMERS = join(FIXTURES, 'product_a_customers.csv');
const CONFIG_PATH = join(FIXTURES, 'test-batch.config.json');
const OUTPUT = join(import.meta.dirname, '..', 'output-runner-test');

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
});
