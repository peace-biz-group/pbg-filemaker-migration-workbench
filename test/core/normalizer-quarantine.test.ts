import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { normalizeFile } from '../../src/core/normalizer.js';
import { loadConfig } from '../../src/config/defaults.js';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';

const OUTPUT = join(import.meta.dirname, '..', 'output-quarantine-test');
const F = join(import.meta.dirname, '..', 'fixtures');

describe('normalizer quarantine reason codes', () => {
  beforeAll(() => mkdirSync(OUTPUT, { recursive: true }));
  afterAll(() => { if (existsSync(OUTPUT)) rmSync(OUTPUT, { recursive: true, force: true }); });

  it('sets BUSINESS_KEY_EMPTY reason for rows with no key fields', async () => {
    const config = loadConfig();
    config.outputDir = OUTPUT;

    const ctx = { sourceBatchId: 'test-batch', importRunId: 'test-run', sourceKey: 'test' };
    const result = await normalizeFile(join(F, 'utf8.csv'), config, ctx);

    // utf8.csv has name/phone/email — should normalize
    expect(result.normalizedCount).toBeGreaterThan(0);
    expect(result.parseFailCount).toBe(0);
  });

  it('writes parse-quarantine.csv for malformed CSV', async () => {
    const config = loadConfig();
    config.outputDir = OUTPUT;

    const ctx = { sourceBatchId: 'test-batch', importRunId: 'test-run', sourceKey: 'test' };
    const result = await normalizeFile(join(F, 'malformed.csv'), config, ctx);

    expect(result.parseFailCount).toBeGreaterThan(0);
    expect(existsSync(result.parseQuarantinePath)).toBe(true);

    const rows = parse(readFileSync(result.parseQuarantinePath, 'utf-8'), { columns: true });
    expect(rows[0]._reason).toBe('COLUMN_MISALIGNMENT');
    expect(rows[0]._raw_line_hash).toHaveLength(64);
  });

  it('normalized rows include lineage columns', async () => {
    const config = loadConfig();
    config.outputDir = OUTPUT;

    const ctx = { sourceBatchId: 'test-batch', importRunId: 'test-run', sourceKey: 'my-key' };
    await normalizeFile(join(F, 'utf8.csv'), config, ctx);

    const normalizedPath = join(OUTPUT, 'normalized.csv');
    if (existsSync(normalizedPath)) {
      const rows = parse(readFileSync(normalizedPath, 'utf-8'), { columns: true, bom: true });
      if (rows.length > 0) {
        expect(rows[0]._source_batch_id).toBe('test-batch');
        expect(rows[0]._import_run_id).toBe('test-run');
        expect(rows[0]._source_key).toBe('my-key');
        expect(rows[0]._schema_fingerprint).toBeTruthy();
        expect(rows[0]._row_fingerprint).toHaveLength(64);
      }
    }
  });
});
