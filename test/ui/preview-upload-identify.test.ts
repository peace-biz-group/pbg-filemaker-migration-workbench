import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/ui/server.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import * as XLSX from 'xlsx';

let server: Server;
let baseUrl: string;
let dir: string;
let csvPath: string;
let xlsxPath: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ui-preview-identify-test-'));

  const rows = [
    ['name', 'phone'],
    ['山田太郎', '090-1111-2222'],
  ];

  csvPath = join(dir, 'sample.csv');
  writeFileSync(csvPath, rows.map((r) => r.join(',')).join('\n') + '\n');

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  xlsxPath = join(dir, 'sample.xlsx');
  writeFileSync(xlsxPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

  const app = createApp(dir);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('preview/upload-identify (csv/xlsx)', () => {
  it('CSV/XLSX ともに /api/preview が通る', async () => {
    const csvRes = await fetch(`${baseUrl}/api/preview?file=${encodeURIComponent(csvPath)}&rows=5`);
    expect(csvRes.status).toBe(200);
    const csvBody = await csvRes.json();
    expect(csvBody.diagnosis.format).toBe('csv');

    const xlsxRes = await fetch(`${baseUrl}/api/preview?file=${encodeURIComponent(xlsxPath)}&rows=5`);
    expect(xlsxRes.status).toBe(200);
    const xlsxBody = await xlsxRes.json();
    expect(xlsxBody.diagnosis.format).toBe('xlsx');
    expect(xlsxBody.columns).toEqual(csvBody.columns);
  });

  it('CSV/XLSX ともに /api/upload-identify が通る', async () => {
    const csvForm = new FormData();
    csvForm.append('file', new Blob([readFileSync(csvPath)]), 'sample.csv');
    const csvRes = await fetch(`${baseUrl}/api/upload-identify`, { method: 'POST', body: csvForm });
    expect(csvRes.status).toBe(200);
    const csvBody = await csvRes.json();
    expect(csvBody.diagnosis.format).toBe('csv');

    const xlsxForm = new FormData();
    xlsxForm.append('file', new Blob([readFileSync(xlsxPath)]), 'sample.xlsx');
    const xlsxRes = await fetch(`${baseUrl}/api/upload-identify`, { method: 'POST', body: xlsxForm });
    expect(xlsxRes.status).toBe(200);
    const xlsxBody = await xlsxRes.json();
    expect(xlsxBody.diagnosis.format).toBe('xlsx');
    expect(xlsxBody.columns).toEqual(csvBody.columns);
  });
});
