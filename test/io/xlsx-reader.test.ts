import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as XLSX from 'xlsx';
import { readXlsxColumns, readXlsxInChunks } from '../../src/io/xlsx-reader.js';

function createTempXlsx(rows: (string | number)[][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-reader-test-'));
  const filePath = join(dir, 'sample.xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const data = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  writeFileSync(filePath, data);
  return filePath;
}

describe('xlsx-reader', () => {
  it('reads xlsx in chunks and columns via read(buffer) path', async () => {
    const filePath = createTempXlsx([
      ['name', 'email'],
      ['A', 'a@example.com'],
      ['B', 'b@example.com'],
      ['C', 'c@example.com'],
    ]);

    try {
      const columns = readXlsxColumns(filePath);
      expect(columns).toEqual(['name', 'email']);

      const counts = await readXlsxInChunks(filePath, { chunkSize: 2 }, async (chunk, chunkIndex) => {
        if (chunkIndex === 0) {
          expect(chunk[0]!['name']).toBe('A');
        }
        return chunk.length;
      });

      expect(counts).toEqual([2, 1]);
    } finally {
      rmSync(dirname(filePath), { recursive: true, force: true });
    }
  });
});
