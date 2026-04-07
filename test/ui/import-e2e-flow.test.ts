// test/ui/import-e2e-flow.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../../src/ui/server.js';
import {
  computeFileShapeFingerprint,
  loadRegistry as loadFamilyRegistry,
  registerFingerprint,
  saveRegistry as saveFamilyRegistry,
} from '../../src/core/family-registry.js';

// --- Fixture 定義 ---
const CUSTOMER_COLS  = ['電話番号', '氏名', '業種【小分類】'];
const CALL_COLS      = ['通話日', '架電結果', '業種【小分類】'];
const CUSTOMER2_COLS = ['電話番号', '氏名', '商品名', '備考'];

function makeCSV(headers: string[], rows: string[][]): Blob {
  const lines = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))];
  return new Blob([lines.join('\n')], { type: 'text/csv' });
}

async function importPreview(baseUrl: string, blob: Blob, filename: string) {
  const form = new FormData();
  form.append('file', blob, filename);
  const res = await fetch(`${baseUrl}/api/import-preview`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`import-preview failed: ${await res.text()}`);
  return res.json() as Promise<{
    autoApplyResult: {
      familyId: string;
      appliedDecisions: Array<{ sourceColumn: string; canonicalField: string | null; source: string }>;
      unresolvedColumns: string[];
    };
    totalRows: number;
    isSampled: boolean;
  }>;
}

async function saveResolution(baseUrl: string, record: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/api/decisions/resolutions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
  if (!res.ok) throw new Error(`saveResolution failed: ${await res.text()}`);
  return res.json();
}

function makeCanonicalRecord(col: string, familyId: string, decision: string) {
  return {
    resolution_id: randomUUID(),
    resolution_type: 'column_canonical',
    context_key: `column:${col}`,
    family_id: familyId,
    decision,
    decision_detail: { canonical_field: decision, decided_via: 'test' },
    certainty: 'confirmed',
    scope: 'family',
    decided_at: new Date().toISOString(),
    decided_by: 'human',
    auto_apply_condition: 'always',
    source_batch_ids: [],
  };
}

// --- テストスイート ---
let outputDir: string;
let baseUrl: string;
let server: Server;

beforeEach(async () => {
  outputDir = mkdtempSync(join(tmpdir(), 'import-e2e-test-'));

  // family registry を決定論的に初期化
  const customerFp  = computeFileShapeFingerprint(CUSTOMER_COLS,  'utf-8', true);
  const callFp      = computeFileShapeFingerprint(CALL_COLS,      'utf-8', true);
  const customer2Fp = computeFileShapeFingerprint(CUSTOMER2_COLS, 'utf-8', true);

  let registry = loadFamilyRegistry(outputDir);
  for (const [fp, familyId, cols, sampleName] of [
    [customerFp,  'customer_master', CUSTOMER_COLS,  'customer.csv'],
    [callFp,      'call_history',    CALL_COLS,      'call.csv'],
    [customer2Fp, 'customer_master', CUSTOMER2_COLS, 'customer2.csv'],
  ] as [string, string, string[], string][]) {
    registry = registerFingerprint({
      fingerprint: fp,
      family_id: familyId as 'customer_master' | 'call_history',
      certainty: 'confirmed',
      confirmed_at: null,
      column_count: cols.length,
      encoding: 'utf-8',
      has_header: true,
      sample_filename: sampleName,
      matched_template_id: null,
    }, registry);
  }
  saveFamilyRegistry(registry, outputDir);

  // NOTE: family registry uses computeFileShapeFingerprint (sorted-comma + encoding + hasHeader).
  // MappingTemplate seeding requires ir.schemaFingerprint (sorted-pipe, from src/ingest/fingerprint.ts).
  // These are different algorithms — seed each registry with the correct fingerprint variant.

  // サーバー起動
  const expressApp = createApp(outputDir);
  await new Promise<void>((resolve) => {
    server = expressApp.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(outputDir, { recursive: true, force: true });
});

describe('TC-1: template 保存 → 再 upload で auto-apply が効く', () => {
  it('保存した column_canonical が次回 import-preview で appliedDecisions に出る', async () => {
    const blob = makeCSV(CUSTOMER_COLS, [['090-0001-0001', '田中太郎', '製造業']]);

    // 初回: '業種【小分類】' が unresolved
    const first = await importPreview(baseUrl, blob, 'customer.csv');
    expect(first.autoApplyResult.familyId).toBe('customer_master');
    expect(first.autoApplyResult.unresolvedColumns).toContain('業種【小分類】');

    // 保存
    await saveResolution(baseUrl, makeCanonicalRecord('業種【小分類】', 'customer_master', 'industry_subcategory'));

    // 再 import-preview: auto-apply される
    const second = await importPreview(baseUrl, blob, 'customer.csv');
    const resolved = second.autoApplyResult.appliedDecisions.find(d => d.sourceColumn === '業種【小分類】');
    expect(resolved).toBeDefined();
    expect(resolved!.canonicalField).toBe('industry_subcategory');
    expect(resolved!.source).toBe('memory');
    expect(second.autoApplyResult.unresolvedColumns).not.toContain('業種【小分類】');
  });
});
