// test/ui/import-preview-api.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../src/ui/server.js';
import type { Server } from 'node:http';

let server: Server;
let baseUrl: string;
let outputDir: string;

beforeAll(async () => {
  outputDir = mkdtempSync(join(tmpdir(), 'import-preview-api-test-'));
  const app = createApp(outputDir);
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
  rmSync(outputDir, { recursive: true, force: true });
});

describe('POST /api/import-preview', () => {
  it('returns autoApplyResult and columnSamples for CSV upload', async () => {
    const csvContent = '職業,氏名\n会社員,田中\n農業,鈴木\n会社員,佐藤\n';
    const form = new FormData();
    form.append('file', new Blob([csvContent], { type: 'text/csv' }), 'test.csv');

    const res = await fetch(`${baseUrl}/api/import-preview`, { method: 'POST', body: form });
    expect(res.status).toBe(200);

    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('autoApplyResult');
    expect(data).toHaveProperty('columnSamples');
    expect(data).toHaveProperty('totalRows');
    expect(data).toHaveProperty('fileName');
    expect(data.totalRows).toBe(3);
    expect(data.fileName).toBe('test.csv');

    const samples = data.columnSamples as Record<string, { nonEmptyCount: number; topValues: { value: string; count: number }[] }>;
    expect(samples['職業'].topValues[0].value).toBe('会社員');
    expect(samples['職業'].topValues[0].count).toBe(2);

    const autoApply = data.autoApplyResult as { unresolvedColumns: string[] };
    expect(Array.isArray(autoApply.unresolvedColumns)).toBe(true);
  });

  it('returns 400 when no file is provided', async () => {
    const res = await fetch(`${baseUrl}/api/import-preview`, {
      method: 'POST',
      body: new FormData(),
    });
    expect(res.status).toBe(400);
  });
});
