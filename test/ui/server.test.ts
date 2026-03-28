import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/ui/server.js';
import { executeRun } from '../../src/core/pipeline-runner.js';
import { loadConfig } from '../../src/config/defaults.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const APO_LIST = join(FIXTURES, 'apo_list_2024.csv');
const CONFIG_PATH = join(FIXTURES, 'test-batch.config.json');
const OUTPUT = join(import.meta.dirname, '..', 'output-ui-test');

let server: Server;
let baseUrl: string;

describe('UI Server API', () => {
  beforeAll(async () => {
    mkdirSync(OUTPUT, { recursive: true });

    // Create a test run first
    const config = loadConfig(CONFIG_PATH);
    config.outputDir = OUTPUT;
    await executeRun('run-all', [APO_LIST], config, CONFIG_PATH);

    const app = createApp(OUTPUT);
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
    if (existsSync(OUTPUT)) rmSync(OUTPUT, { recursive: true, force: true });
  });

  it('serves index.html at /', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('FileMaker Data Workbench');
  });

  it('GET /api/runs returns run list', async () => {
    const res = await fetch(`${baseUrl}/api/runs`);
    expect(res.status).toBe(200);
    const runs = await res.json();
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/runs/:id returns run detail', async () => {
    const runsRes = await fetch(`${baseUrl}/api/runs`);
    const runs = await runsRes.json();
    const run = runs[0];

    const res = await fetch(`${baseUrl}/api/runs/${run.id}`);
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail.id).toBe(run.id);
    expect(detail.summary).toBeDefined();
  });

  it('GET /api/runs/:id/files returns file list', async () => {
    const runsRes = await fetch(`${baseUrl}/api/runs`);
    const runs = await runsRes.json();

    const res = await fetch(`${baseUrl}/api/runs/${runs[0].id}/files`);
    expect(res.status).toBe(200);
    const files = await res.json();
    expect(files).toContain('normalized.csv');
  });

  it('GET /api/runs/:id/data/:file returns paginated CSV data', async () => {
    const runsRes = await fetch(`${baseUrl}/api/runs`);
    const runs = await runsRes.json();

    const res = await fetch(`${baseUrl}/api/runs/${runs[0].id}/data/normalized.csv?offset=0&limit=5`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.columns).toBeDefined();
    expect(data.rows.length).toBeLessThanOrEqual(5);
    expect(data.totalCount).toBeGreaterThan(0);
  });

  it('GET /api/configs returns available configs', async () => {
    const res = await fetch(`${baseUrl}/api/configs`);
    expect(res.status).toBe(200);
    const configs = await res.json();
    expect(Array.isArray(configs)).toBe(true);
  });

  it('POST /api/runs creates a new run', async () => {
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'profile',
        filePaths: [APO_LIST],
        configPath: CONFIG_PATH,
      }),
    });
    expect(res.status).toBe(200);
    const run = await res.json();
    expect(run.status).toBe('completed');
    expect(run.id).toBeTruthy();
  });

  it('returns 404 for non-existent run', async () => {
    const res = await fetch(`${baseUrl}/api/runs/nonexistent`);
    expect(res.status).toBe(404);
  });

  it('GET /api/runs/:id/source-data returns original input data', async () => {
    const runsRes = await fetch(`${baseUrl}/api/runs`);
    const runs = await runsRes.json();

    const res = await fetch(`${baseUrl}/api/runs/${runs[0].id}/source-data?offset=0&limit=5`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.columns).toBeDefined();
    expect(data.rows.length).toBeLessThanOrEqual(5);
    expect(data.totalCount).toBeGreaterThan(0);
  });

  it('GET /api/runs/:id/duplicates returns grouped duplicates', async () => {
    const runsRes = await fetch(`${baseUrl}/api/runs`);
    const runs = await runsRes.json();

    const res = await fetch(`${baseUrl}/api/runs/${runs[0].id}/duplicates`);
    // May be 200 or 404 depending on whether duplicates.csv exists
    if (res.status === 200) {
      const data = await res.json();
      expect(data.totalGroups).toBeDefined();
      expect(Array.isArray(data.groups)).toBe(true);
    } else {
      expect(res.status).toBe(404);
    }
  });

  it('POST /api/runs/:id/rerun creates a new run from existing', async () => {
    const runsRes = await fetch(`${baseUrl}/api/runs`);
    const runs = await runsRes.json();
    const originalId = runs[0].id;

    const res = await fetch(`${baseUrl}/api/runs/${originalId}/rerun`, { method: 'POST' });
    expect(res.status).toBe(200);
    const newRun = await res.json();
    expect(newRun.id).toBeTruthy();
    expect(newRun.id).not.toBe(originalId);
    expect(newRun.status).toBe('completed');
  });

  it('DELETE /api/runs/:id deletes a run', async () => {
    // Create a throwaway run to delete
    const createRes = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'profile',
        filePaths: [APO_LIST],
        configPath: CONFIG_PATH,
      }),
    });
    const created = await createRes.json();

    const delRes = await fetch(`${baseUrl}/api/runs/${created.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/api/runs/${created.id}`);
    expect(getRes.status).toBe(404);
  });

  it('GET /api/runs/:id/progress returns SSE stream', async () => {
    const res = await fetch(`${baseUrl}/api/runs/nonexistent/progress`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data:');
  });
});
