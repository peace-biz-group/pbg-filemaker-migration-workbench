// test/ui/auto-apply-api.test.ts
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
  outputDir = mkdtempSync(join(tmpdir(), 'auto-apply-api-test-'));
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

describe('POST /api/auto-apply-preview', () => {
  it('returns AutoApplyPreviewResult for known columns', async () => {
    const res = await fetch(`${baseUrl}/api/auto-apply-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        columns: ['氏名', '電話番号', '住所'],
        encoding: 'cp932',
        hasHeader: true,
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('familyId');
    expect(data).toHaveProperty('familyCertainty');
    expect(data).toHaveProperty('templateId');
    expect(data).toHaveProperty('autoApplyEligibility');
    expect(Array.isArray(data.appliedDecisions)).toBe(true);
    expect(Array.isArray(data.unresolvedColumns)).toBe(true);
    // No template seeded → all columns unresolved
    expect(data.templateId).toBeNull();
    expect((data.unresolvedColumns as string[])).toContain('氏名');
  });

  it('returns 400 when columns is missing', async () => {
    const res = await fetch(`${baseUrl}/api/auto-apply-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encoding: 'cp932' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when columns is not an array', async () => {
    const res = await fetch(`${baseUrl}/api/auto-apply-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columns: '氏名,電話番号', encoding: 'cp932' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/decisions/resolutions', () => {
  it('saves a resolution record and returns resolutionId', async () => {
    const record = {
      resolution_id: 'test_res_001',
      resolution_type: 'column_ignore',
      context_key: 'column:備考',
      family_id: null,
      decision: 'unused',
      decision_detail: {},
      certainty: 'confirmed',
      scope: 'global',
      decided_at: new Date().toISOString(),
      decided_by: 'human',
      auto_apply_condition: 'exact_match:column_name',
      source_batch_ids: [],
    };
    const res = await fetch(`${baseUrl}/api/decisions/resolutions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.resolutionId).toBe('test_res_001');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await fetch(`${baseUrl}/api/decisions/resolutions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution_type: 'column_ignore' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when resolution_type is not in the valid list', async () => {
    const record = {
      resolution_id: 'test_res_invalid',
      resolution_type: 'invalid_type',
      context_key: 'column:備考',
      family_id: null,
      decision: 'unused',
      decision_detail: {},
      certainty: 'confirmed',
      scope: 'global',
      decided_at: new Date().toISOString(),
      decided_by: 'human',
      auto_apply_condition: 'exact_match:column_name',
      source_batch_ids: [],
    };
    const res = await fetch(`${baseUrl}/api/decisions/resolutions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    expect(res.status).toBe(400);
  });
});
