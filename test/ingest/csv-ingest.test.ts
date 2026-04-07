import { afterEach, describe, it, expect } from 'vitest';
import { ingestCsv } from '../../src/ingest/csv-ingest.js';
import type { CsvIngestDiagnosis, RawRecord } from '../../src/types/index.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const F = join(import.meta.dirname, '..', 'fixtures');
const TEMP_DIRS: string[] = [];

async function collectRecords(result: Awaited<ReturnType<typeof ingestCsv>>): Promise<RawRecord[]> {
  const rows: RawRecord[] = [];
  for await (const chunk of result.records) rows.push(...chunk);
  return rows;
}

async function collectChunkSizes(
  result: Awaited<ReturnType<typeof ingestCsv>>,
): Promise<number[]> {
  const sizes: number[] = [];
  for await (const chunk of result.records) sizes.push(chunk.length);
  return sizes;
}

function writeTempCsv(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'csv-ingest-test-'));
  TEMP_DIRS.push(dir);
  const filePath = join(dir, name);
  writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

function buildQuotedRow(values: string[]): string {
  return values.map((value) => `"${value.replace(/"/g, '""')}"`).join(',');
}

function buildLongCommaCsvWithLiteralFallback(rowCount: number): string {
  const columns = Array.from({ length: 89 }, (_, index) => `col${index}`);
  const lines = [buildQuotedRow(columns)];

  for (let rowIndex = 1; rowIndex <= rowCount; rowIndex++) {
    const values = Array.from({ length: 89 }, (_, index) => `r${rowIndex}-v${index}`);
    if (rowIndex === 1) {
      values[10] = '11:00-21:00\t\t';
    }
    lines.push(values.map((value, index) => {
      if (rowIndex === Math.ceil(rowCount / 2) && index === 20) {
        return '"途中で閉じない';
      }
      return `"${value.replace(/"/g, '""')}"`;
    }).join(','));
  }

  return lines.join('\n') + '\n';
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

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

  it('falls back to relaxed quotes when header row has malformed quote', async () => {
    const filePath = writeTempCsv(
      'header-malformed.csv',
      'na"me,phone,email\n山田太郎,090-1111-2222,yamada@example.com\n',
    );

    const result = await ingestCsv(filePath);
    const rows = await collectRecords(result);

    expect(result.columns).toEqual(['na"me', 'phone', 'email']);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['na"me']).toBe('山田太郎');
    expect((result.diagnosis as CsvIngestDiagnosis).appliedQuoteMode).toBe('relaxed');
  });

  it('falls back in peekColumns for first row when header is disabled', async () => {
    const filePath = writeTempCsv(
      'first-row-malformed.csv',
      '山"田太郎,090-1111-2222,yamada@example.com\n佐藤花子,080-3333-4444,sato@example.com\n',
    );

    const result = await ingestCsv(filePath, { hasHeader: false });
    const rows = await collectRecords(result);

    expect(result.columns).toEqual(['c0', 'c1', 'c2']);
    expect(rows).toHaveLength(2);
    expect(rows[0]!['c0']).toBe('山"田太郎');
    expect((result.diagnosis as CsvIngestDiagnosis).appliedQuoteMode).toBe('relaxed');
  });

  it('falls back in body parser when malformed quote appears in data rows', async () => {
    const filePath = writeTempCsv(
      'body-malformed.csv',
      'name,phone,email\n山"田太郎,090-1111-2222,yamada@example.com\n佐藤花子,080-3333-4444,sato@example.com\n',
    );

    const result = await ingestCsv(filePath);
    const rows = await collectRecords(result);

    expect(rows).toHaveLength(2);
    expect(rows[0]!['name']).toBe('山"田太郎');
    expect((result.diagnosis as CsvIngestDiagnosis).appliedQuoteMode).toBe('relaxed');
  });

  it('fails in strict mode and succeeds in relaxed mode for malformed quotes', async () => {
    const filePath = writeTempCsv(
      'strict-vs-relaxed.csv',
      'na"me,phone,email\n山田太郎,090-1111-2222,yamada@example.com\n',
    );

    await expect(ingestCsv(filePath, { csvQuoteMode: 'strict' })).rejects.toThrow(/Quote/i);

    const result = await ingestCsv(filePath, { csvQuoteMode: 'relaxed' });
    const rows = await collectRecords(result);

    expect(rows).toHaveLength(1);
    expect((result.diagnosis as CsvIngestDiagnosis).appliedQuoteMode).toBe('relaxed');
  });

  it('falls back to literal mode when relaxed quotes still fail', async () => {
    const filePath = writeTempCsv(
      'literal-fallback.csv',
      'name,note\n山田太郎,"途中で閉じない\n佐藤花子,通常値\n',
    );

    const result = await ingestCsv(filePath);
    const rows = await collectRecords(result);

    expect(rows).toHaveLength(2);
    expect(rows[0]!['name']).toBe('山田太郎');
    expect(rows[0]!['note']).toBe('"途中で閉じない');
    expect((result.diagnosis as CsvIngestDiagnosis).appliedQuoteMode).toBe('literal');
  });

  it('keeps chunked streaming behavior after quote fallback', async () => {
    const filePath = writeTempCsv(
      'literal-chunking.csv',
      [
        'name,note',
        'r1,ok1',
        'r2,ok2',
        'r3,"quote never closes',
        'r4,ok4',
        'r5,ok5',
      ].join('\n') + '\n',
    );

    const result = await ingestCsv(filePath, {}, 2);
    const chunkSizes = await collectChunkSizes(result);

    expect(chunkSizes).toEqual([2, 2, 1]);
    expect((result.diagnosis as CsvIngestDiagnosis).appliedQuoteMode).toBe('literal');
  });

  it('keeps comma delimiter and row counting correct after literal fallback on long truncated samples', async () => {
    const filePath = writeTempCsv(
      'long-comma-literal.csv',
      buildLongCommaCsvWithLiteralFallback(6),
    );

    const result = await ingestCsv(filePath);
    const rows = await collectRecords(result);

    expect((result.diagnosis as CsvIngestDiagnosis).appliedDelimiter).toBe(',');
    expect((result.diagnosis as CsvIngestDiagnosis).appliedQuoteMode).toBe('literal');
    expect(rows).toHaveLength(6);
    expect(rows[0]!['col10']).toBe('"11:00-21:00\t\t"');
    expect(rows[2]!['col20']).toBe('"途中で閉じない');
  });

  it('treats weak first row with urls phones and dates as headerless data', async () => {
    const filePath = writeTempCsv(
      'filemaker-like-headerless.csv',
      [
        '"","","店舗A","https://example.com/a","090-1111-2222","田中","東京都千代田区1-1","2025/04/01"',
        '"","","店舗B","https://example.com/b","090-3333-4444","佐藤","東京都港区2-2","2025/04/02"',
        '"","","店舗C","https://example.com/c","090-5555-6666","鈴木","東京都渋谷区3-3","2025/04/03"',
      ].join('\n') + '\n',
    );

    const result = await ingestCsv(filePath);
    const rows = await collectRecords(result);

    expect((result.diagnosis as CsvIngestDiagnosis).headerApplied).toBe(false);
    expect(result.columns).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
    expect(rows).toHaveLength(3);
    expect(rows[0]!['c2']).toBe('店舗A');
    expect(rows[0]!['c4']).toBe('090-1111-2222');
  });
});
