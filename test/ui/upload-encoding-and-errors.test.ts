import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/ui/server.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';

let server: Server;
let baseUrl: string;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ui-upload-err-test-'));
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

describe('upload filename / csv parse error handling', () => {
  it('UTF-8 日本語ファイル名が文字化けしない', async () => {
    const p = join(dir, '太陽光顧客管理.csv');
    writeFileSync(p, 'name,phone\n山田,090\n');

    const form = new FormData();
    form.append('file', new Blob([readFileSync(p)]), '太陽光顧客管理.csv');
    const res = await fetch(`${baseUrl}/api/upload-identify`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filename).toBe('太陽光顧客管理.csv');
  });

  it('quote 崩れ CSV は fallback で読み、診断に最終 mode を残す', async () => {
    const malformed = join(dir, 'bad.csv');
    writeFileSync(malformed, 'name,comment\n"abc,"bad"\n');
    const res = await fetch(`${baseUrl}/api/preview?file=${encodeURIComponent(malformed)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parseErrorHelp).toBeNull();
    expect(body.diagnosis.appliedQuoteMode).toBe('literal');
  });
});
