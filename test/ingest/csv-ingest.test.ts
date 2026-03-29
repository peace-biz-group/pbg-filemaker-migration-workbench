import { describe, it, expect } from 'vitest';
import { ingestCsv } from '../../src/ingest/csv-ingest.js';
import type { CsvIngestDiagnosis, RawRecord } from '../../src/types/index.js';
import { join } from 'node:path';

const F = join(import.meta.dirname, '..', 'fixtures');

async function collectRecords(result: Awaited<ReturnType<typeof ingestCsv>>): Promise<RawRecord[]> {
  const rows: RawRecord[] = [];
  for await (const chunk of result.records) rows.push(...chunk);
  return rows;
}

describe('ingestCsv', () => {
  it('reads UTF-8 CSV with header', async () => {
    const r = await ingestCsv(join(F, 'utf8.csv'));
    const rows = await collectRecords(r);
    expect(r.columns).toEqual(['name', 'phone', 'email']);
    expect(rows.length).toBe(3);
    expect(rows[0]!['name']).toBe('山田太郎');
    expect(rows[0]!['_row_fingerprint']).toHaveLength(64);
    expect((r.diagnosis as CsvIngestDiagnosis).appliedEncoding).toBe('utf8');
  });

  it('reads UTF-8 BOM CSV without BOM in column names', async () => {
    const r = await ingestCsv(join(F, 'utf8-bom.csv'));
    expect((r.diagnosis as CsvIngestDiagnosis).detectedEncoding).toBe('utf8bom');
    expect(r.columns[0]).toBe('name'); // no BOM prefix
    const rows = await collectRecords(r);
    expect(rows.length).toBe(3);
  });

  it('reads Shift-JIS CSV correctly (no replacement chars)', async () => {
    const r = await ingestCsv(join(F, 'shiftjis.csv'));
    expect((r.diagnosis as CsvIngestDiagnosis).detectedEncoding).toBe('cp932');
    const rows = await collectRecords(r);
    expect(rows.length).toBe(3);
    const allValues = rows.flatMap(row => Object.values(row));
    expect(allValues.some(v => v.includes('\uFFFD'))).toBe(false);
    expect(rows[0]!['name']).toBe('山田太郎');
  });

  it('reads tab-delimited file', async () => {
    const r = await ingestCsv(join(F, 'tab-delimited.tsv'));
    expect((r.diagnosis as CsvIngestDiagnosis).appliedDelimiter).toBe('\t');
    const rows = await collectRecords(r);
    expect(rows.length).toBeGreaterThan(0);
    expect(r.columns).toContain('name');
  });

  it('generates c0..cn for header-less CSV', async () => {
    const r = await ingestCsv(join(F, 'no-header.csv'), { hasHeader: false });
    expect(r.columns).toEqual(['c0', 'c1', 'c2']);
    const rows = await collectRecords(r);
    expect(rows[0]).toHaveProperty('c0');
    expect(rows[0]).toHaveProperty('c1');
  });

  it('captures column misalignment as parse failure', async () => {
    const r = await ingestCsv(join(F, 'malformed.csv'));
    const rows = await collectRecords(r);
    expect(r.parseFailures.length).toBeGreaterThan(0);
    expect(r.parseFailures[0]!.reason).toBe('COLUMN_MISALIGNMENT');
    expect(r.parseFailures[0]!.rawLineHash).toHaveLength(64);
    // Non-malformed rows should still be processed
    expect(rows.length).toBeGreaterThan(0);
  });

  it('respects previewRows', async () => {
    const r = await ingestCsv(join(F, 'utf8.csv'), { previewRows: 1 });
    const rows = await collectRecords(r);
    expect(rows.length).toBe(1);
  });

  it('applies encoding override', async () => {
    const r = await ingestCsv(join(F, 'shiftjis.csv'), { encoding: 'cp932' });
    expect((r.diagnosis as CsvIngestDiagnosis).appliedEncoding).toBe('cp932');
    const rows = await collectRecords(r);
    expect(rows[0]!['name']).toBe('山田太郎');
  });

  it('produces stable sourceFileHash', async () => {
    const r1 = await ingestCsv(join(F, 'utf8.csv'));
    await collectRecords(r1);
    const r2 = await ingestCsv(join(F, 'utf8.csv'));
    await collectRecords(r2);
    expect(r1.sourceFileHash).toBe(r2.sourceFileHash);
    expect(r1.sourceFileHash).toHaveLength(64);
  });

  it('schemaFingerprint is same for same columns', async () => {
    const r1 = await ingestCsv(join(F, 'utf8.csv'));
    await collectRecords(r1);
    const r2 = await ingestCsv(join(F, 'utf8.csv'));
    await collectRecords(r2);
    expect(r1.schemaFingerprint).toBe(r2.schemaFingerprint);
  });
});
