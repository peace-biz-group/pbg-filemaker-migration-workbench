import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as XLSX from 'xlsx';
import { ingestToCanonical } from '../../src/ingest/canonical-ingest.js';
import { loadConfig } from '../../src/config/defaults.js';
import { normalizeFile } from '../../src/core/normalizer.js';

function createTempFiles(): { csvPath: string; xlsxPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'canonical-ingest-test-'));
  const rows = [
    ['name', 'phone', 'email'],
    ['山田太郎', '090-1111-2222', 'yamada@example.com'],
    ['佐藤花子', '090-3333-4444', 'sato@example.com'],
  ];

  const csvPath = join(dir, 'sample.csv');
  const csv = rows.map((r) => r.join(',')).join('\n') + '\n';
  writeFileSync(csvPath, csv);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const xlsxPath = join(dir, 'sample.xlsx');
  writeFileSync(xlsxPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

  return { csvPath, xlsxPath, dir };
}

async function collectCount(filePath: string): Promise<number> {
  const canonical = await ingestToCanonical(filePath, {}, 2);
  let count = 0;
  for await (const chunk of canonical.records) count += chunk.length;
  return count;
}

describe('canonical ingest adapters', () => {
  it('CSV/XLSX を canonical table model に取り込みできる', async () => {
    const { csvPath, xlsxPath, dir } = createTempFiles();
    try {
      const csv = await ingestToCanonical(csvPath, {}, 2);
      const xlsx = await ingestToCanonical(xlsxPath, {}, 2);

      expect(csv.columns).toEqual(['name', 'phone', 'email']);
      expect(xlsx.columns).toEqual(['name', 'phone', 'email']);
      expect(csv.schemaFingerprint).toBe(xlsx.schemaFingerprint);
      expect(await collectCount(csvPath)).toBe(2);
      expect(await collectCount(xlsxPath)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('canonical 化後の normalize が CSV/XLSX で同等に完走する', async () => {
    const { csvPath, xlsxPath, dir } = createTempFiles();
    const baseConfig = loadConfig();
    try {
      const csvOut = join(dir, 'out-csv');
      const xlsxOut = join(dir, 'out-xlsx');

      const csvConfig = { ...baseConfig, outputDir: csvOut };
      const xlsxConfig = { ...baseConfig, outputDir: xlsxOut };

      const csvResult = await normalizeFile(csvPath, csvConfig);
      const xlsxResult = await normalizeFile(xlsxPath, xlsxConfig);

      expect(csvResult.normalizedCount).toBe(xlsxResult.normalizedCount);
      expect(csvResult.quarantineCount).toBe(xlsxResult.quarantineCount);
      expect(csvResult.parseFailCount).toBe(xlsxResult.parseFailCount);
      expect(csvResult.schemaFingerprint).toBe(xlsxResult.schemaFingerprint);
    } finally {
      rmSync(dirname(csvPath), { recursive: true, force: true });
    }
  });
});
