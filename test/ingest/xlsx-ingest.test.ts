import { describe, it, expect } from 'vitest';
import { ingestXlsx } from '../../src/ingest/xlsx-ingest.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as XLSX from 'xlsx';
import type { RawRecord } from '../../src/types/index.js';

function createTempXlsx(rows: (string | number)[][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-ingest-test-'));
  const filePath = join(dir, 'sample.xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const data = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  writeFileSync(filePath, data);
  return filePath;
}

async function collectRecords(result: Awaited<ReturnType<typeof ingestXlsx>>): Promise<RawRecord[]> {
  const rows: RawRecord[] = [];
  for await (const chunk of result.records) rows.push(...chunk);
  return rows;
}

describe('ingestXlsx', () => {
  it('reads xlsx in ESM-safe path without XLSX.readFile helper', async () => {
    const filePath = createTempXlsx([
      ['name', 'phone'],
      ['山田太郎', '090-1111-2222'],
      ['佐藤花子', '090-3333-4444'],
    ]);

    try {
      const result = await ingestXlsx(filePath);
      const rows = await collectRecords(result);

      expect(result.diagnosis.format).toBe('xlsx');
      expect(result.columns).toEqual(['name', 'phone']);
      expect(rows).toHaveLength(2);
      expect(rows[0]!['name']).toBe('山田太郎');
      expect(rows[0]!['_row_fingerprint']).toHaveLength(64);
    } finally {
      rmSync(dirname(filePath), { recursive: true, force: true });
    }
  });
});
