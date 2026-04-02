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
});
