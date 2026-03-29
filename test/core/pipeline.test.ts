import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { profileFile } from '../../src/core/profiler.js';
import { normalizeFile } from '../../src/core/normalizer.js';
import { detectDuplicates } from '../../src/core/duplicate-detector.js';
import { classifyFile } from '../../src/core/classifier.js';
import { loadConfig } from '../../src/config/defaults.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'sample.csv');
const OUTPUT = join(import.meta.dirname, '..', 'output-test');

describe('Pipeline integration', () => {
  let config: ReturnType<typeof loadConfig>;

  beforeAll(() => {
    config = loadConfig();
    config.outputDir = OUTPUT;
    config.chunkSize = 3;
    mkdirSync(OUTPUT, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(OUTPUT)) {
      rmSync(OUTPUT, { recursive: true, force: true });
    }
  });

  it('profiles the sample file', async () => {
    const result = await profileFile(FIXTURE, config);
    // 7 records profiled (1 misaligned row is a parse failure, not included in profile)
    expect(result.recordCount).toBe(7);
    expect(result.columnCount).toBe(11);
    expect(result.columns.length).toBe(11);
    expect(result.anomalies.length).toBeGreaterThan(0);
  });

  it('normalizes the sample file', async () => {
    const result = await normalizeFile(FIXTURE, config, { sourceBatchId: 'test', importRunId: 'test', sourceKey: 'test' });
    // 7 good records (1 misaligned → parse failure, not in normalized+quarantine sum)
    expect(result.normalizedCount + result.quarantineCount).toBe(7);
    expect(result.quarantineCount).toBeGreaterThanOrEqual(1); // empty row
    expect(existsSync(result.normalizedPath)).toBe(true);
    expect(existsSync(result.quarantinePath)).toBe(true);
  });

  it('detects duplicates', async () => {
    const normResult = await normalizeFile(FIXTURE, config, { sourceBatchId: 'test', importRunId: 'test', sourceKey: 'test' });
    const result = await detectDuplicates(normResult.normalizedPath, config);
    // 田中太郎 and 山田次郎 share phone 0312345678
    expect(result.groups.length).toBeGreaterThan(0);
    const phoneGroups = result.groups.filter((g) => g.matchType === 'phone');
    expect(phoneGroups.length).toBeGreaterThanOrEqual(1);
  });

  it('classifies records', async () => {
    const normResult = await normalizeFile(FIXTURE, config, { sourceBatchId: 'test', importRunId: 'test', sourceKey: 'test' });
    const result = await classifyFile(normResult.normalizedPath, config);
    const total = Object.values(result.breakdown).reduce((a, b) => a + b, 0);
    expect(total).toBe(normResult.normalizedCount);
    expect(existsSync(result.outputPath)).toBe(true);
  });
});
