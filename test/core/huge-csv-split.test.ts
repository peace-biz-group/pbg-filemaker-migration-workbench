import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { splitCsvFile } from '../../src/core/huge-csv-split.js';
import { ingestCsv } from '../../src/ingest/csv-ingest.js';

const TEMP_DIRS: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

function writeTempCsv(name: string, contents: string): string {
  const dir = makeTempDir('huge-split-src-');
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

async function collectNames(filePath: string): Promise<string[]> {
  const result = await ingestCsv(filePath);
  const names: string[] = [];
  for await (const chunk of result.records) {
    for (const row of chunk) names.push(row['name'] ?? row['c0'] ?? '');
  }
  return names;
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('splitCsvFile', () => {
  it('splits malformed quote CSV safely and records source diagnosis', async () => {
    const filePath = writeTempCsv(
      'malformed.csv',
      'name,comment\n"abc,"bad"\nfoo,bar\nbaz,qux\n',
    );
    const outputDir = makeTempDir('huge-split-out-');

    const manifest = await splitCsvFile(filePath, {
      outputDir,
      rowsPerPart: 2,
    });

    expect(manifest.sourceDiagnosis.appliedQuoteMode).toBe('literal');
    expect(manifest.totalParts).toBe(2);
    expect(readFileSync(manifest.parts[0]!.filePath, 'utf8')).toContain('name,comment');
  });

  it('writes header to every part and preserves all rows without duplication', async () => {
    const filePath = writeTempCsv(
      'rows.csv',
      [
        'name,comment',
        'r1,a',
        'r2,b',
        'r3,c',
        'r4,d',
        'r5,e',
      ].join('\n') + '\n',
    );
    const outputDir = makeTempDir('huge-split-out-');

    const manifest = await splitCsvFile(filePath, {
      outputDir,
      rowsPerPart: 2,
    });

    expect(manifest.totalParts).toBe(3);
    expect(readFileSync(manifest.parts[0]!.filePath, 'utf8').startsWith('name,comment\n')).toBe(true);
    expect(readFileSync(manifest.parts[1]!.filePath, 'utf8').startsWith('name,comment\n')).toBe(true);
    expect(readFileSync(manifest.parts[2]!.filePath, 'utf8').startsWith('name,comment\n')).toBe(true);

    const allNames = (
      await Promise.all(manifest.parts.map((part) => collectNames(part.filePath)))
    ).flat();
    expect(allNames).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
  });

  it('writes data-only parts when source ingest is headerless', async () => {
    const filePath = writeTempCsv(
      'headerless.csv',
      [
        '"","","店舗A","https://example.com/a","090-1111-2222"',
        '"","","店舗B","https://example.com/b","090-3333-4444"',
        '"","","店舗C","https://example.com/c","090-5555-6666"',
      ].join('\n') + '\n',
    );
    const outputDir = makeTempDir('huge-split-out-');

    const manifest = await splitCsvFile(filePath, {
      outputDir,
      rowsPerPart: 2,
    });

    expect(manifest.seed.originalHeaderApplied).toBe(false);
    expect(manifest.seed.partFilesIncludeHeaderRow).toBe(false);
    const raw = readFileSync(manifest.parts[0]!.filePath, 'utf8');
    expect(raw.startsWith('c0,')).toBe(false);
    expect(raw).toContain('店舗A');
    const result = await ingestCsv(manifest.parts[0]!.filePath, { hasHeader: false });
    expect(result.diagnosis.headerApplied).toBe(false);
    expect(result.columns.slice(0, 3)).toEqual(['c0', 'c1', 'c2']);
  });

  it('keeps splitting long comma CSVs after literal fallback without mis-detecting tab delimiter', async () => {
    const filePath = writeTempCsv(
      'long-comma-literal.csv',
      buildLongCommaCsvWithLiteralFallback(5),
    );
    const outputDir = makeTempDir('huge-split-out-');

    const manifest = await splitCsvFile(filePath, {
      outputDir,
      rowsPerPart: 2,
    });

    expect(manifest.sourceDiagnosis.appliedDelimiter).toBe(',');
    expect(manifest.sourceDiagnosis.appliedQuoteMode).toBe('literal');
    expect(manifest.totalRows).toBe(5);
    expect(manifest.totalParts).toBe(3);
  });
});
