import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/ui/server.js';
import { executeRun } from '../../src/core/pipeline-runner.js';
import { loadConfig } from '../../src/config/defaults.js';
import { mkdirSync, rmSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import * as XLSX from 'xlsx';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const APO_LIST = join(FIXTURES, 'apo_list_2024.csv');
const CONFIG_PATH = join(FIXTURES, 'test-batch.config.json');
const OUTPUT = join(import.meta.dirname, '..', 'output-ui-test');

function createTempXlsx(rows: (string | number)[][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ui-server-xlsx-'));
  const filePath = join(dir, 'sample.xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  writeFileSync(filePath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return filePath;
}

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

  // ===== Review API tests =====

  describe('Review API', () => {
    let reviewId: string;

    it('POST /api/reviews creates a review from a run', async () => {
      const runsRes = await fetch(`${baseUrl}/api/runs`);
      const runs = await runsRes.json();
      const runId = runs[0].id;

      const res = await fetch(`${baseUrl}/api/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      });
      expect(res.status).toBe(200);
      const review = await res.json();
      expect(review.id).toMatch(/^rev_/);
      expect(review.reviewStatus).toBe('draft');
      expect(review.columns.length).toBeGreaterThan(0);
      reviewId = review.id;
    });

    it('GET /api/reviews lists reviews', async () => {
      const res = await fetch(`${baseUrl}/api/reviews`);
      expect(res.status).toBe(200);
      const reviews = await res.json();
      expect(Array.isArray(reviews)).toBe(true);
      expect(reviews.length).toBeGreaterThan(0);
    });

    it('GET /api/reviews/:id returns review detail', async () => {
      const res = await fetch(`${baseUrl}/api/reviews/${reviewId}`);
      expect(res.status).toBe(200);
      const review = await res.json();
      expect(review.id).toBe(reviewId);
      expect(review.columns).toBeDefined();
    });

    it('PUT /api/reviews/:id/columns updates column decisions', async () => {
      const revRes = await fetch(`${baseUrl}/api/reviews/${reviewId}`);
      const review = await revRes.json();
      const firstCol = review.columns[0].sourceColumn;

      const res = await fetch(`${baseUrl}/api/reviews/${reviewId}/columns`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{
          sourceColumn: firstCol,
          humanSemanticField: 'customer_name',
          humanFieldFamily: 'identity',
          humanSection: 'basic_info',
          decision: 'accepted',
        }]),
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      const col = updated.columns.find((c: { sourceColumn: string }) => c.sourceColumn === firstCol);
      expect(col.humanSemanticField).toBe('customer_name');
      expect(col.decision).toBe('accepted');
    });

    it('PUT /api/reviews/:id/summary updates file metadata', async () => {
      const res = await fetch(`${baseUrl}/api/reviews/${reviewId}/summary`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          primaryFileType: 'apo_list',
          reviewer: 'テスト',
          reviewStatus: 'reviewed',
        }),
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.primaryFileType).toBe('apo_list');
      expect(updated.reviewer).toBe('テスト');
    });

    it('POST /api/reviews/:id/finalize generates bundle and saves to submitted', async () => {
      const res = await fetch(`${baseUrl}/api/reviews/${reviewId}/finalize`, { method: 'POST' });
      expect(res.status).toBe(200);
      const result = await res.json();
      expect(result.files).toContain('human-review.json');
      expect(result.files).toContain('mapping-proposal.json');
      expect(result.files).toContain('section-layout-proposal.json');
      expect(result.files).toContain('summary.md');
      expect(result.savedTo).toBeTruthy();
      expect(result.savedTo).toContain('submitted');
    });

    it('GET /api/reviews/:id/files lists bundle files', async () => {
      const res = await fetch(`${baseUrl}/api/reviews/${reviewId}/files`);
      expect(res.status).toBe(200);
      const files = await res.json();
      expect(files).toContain('mapping-proposal.json');
    });

    it('GET /api/reviews/:id/raw/:filename downloads bundle file', async () => {
      const res = await fetch(`${baseUrl}/api/reviews/${reviewId}/raw/summary.md`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Review Summary');
    });

    it('DELETE /api/reviews/:id deletes a review', async () => {
      // Create throwaway
      const runsRes = await fetch(`${baseUrl}/api/runs`);
      const runs = await runsRes.json();
      const createRes = await fetch(`${baseUrl}/api/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: runs[0].id }),
      });
      const created = await createRes.json();

      const delRes = await fetch(`${baseUrl}/api/reviews/${created.id}`, { method: 'DELETE' });
      expect(delRes.status).toBe(200);

      const getRes = await fetch(`${baseUrl}/api/reviews/${created.id}`);
      expect(getRes.status).toBe(404);
    });

    it('returns 404 for non-existent review', async () => {
      const res = await fetch(`${baseUrl}/api/reviews/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  it('GET /api/server-info returns bundle directory info', async () => {
    const res = await fetch(`${baseUrl}/api/server-info`);
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info.bundleDir).toBeTruthy();
    expect(info.submittedDir).toContain('submitted');
    expect(info.checkedDir).toContain('checked');
    expect(info.reworkDir).toContain('rework');
  });

  // ===== Column Status API tests =====

  it('GET /api/runs/:id/column-status returns empty entries when no review saved', async () => {
    const runsRes = await fetch(`${baseUrl}/api/runs`);
    const runs = await runsRes.json();
    const run = runs[0];

    const res = await fetch(`${baseUrl}/api/runs/${run.id}/column-status`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toBeDefined();
    expect(Array.isArray(data.entries)).toBe(true);
    // No review saved for this test run → empty
    expect(data.entries.length).toBe(0);
  });

  it('GET /api/runs/:id/column-status returns entry after saving a column review', async () => {
    const runsRes = await fetch(`${baseUrl}/api/runs`);
    const runs = await runsRes.json();
    const run = runs[0];
    const runId = run.id;
    const profileId = 'new';

    // Save a column review first
    const reviews = [
      { position: 0, label: '顧客名', key: 'customer_name', meaning: '顧客名', inUse: 'yes', required: 'yes', rule: '' },
      { position: 1, label: '電話番号', key: 'phone', meaning: '電話番号', inUse: 'no', required: 'no', rule: '' },
    ];
    const saveRes = await fetch(`${baseUrl}/api/column-reviews/${runId}/${profileId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviews }),
    });
    expect(saveRes.status).toBe(200);

    // Now check column-status
    const res = await fetch(`${baseUrl}/api/runs/${runId}/column-status`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries.length).toBeGreaterThanOrEqual(1);
    const entry = data.entries.find((e: { profileId: string }) => e.profileId === profileId);
    expect(entry).toBeDefined();
    expect(entry.profileName).toBe('新規ファイル');
    expect(entry.activeCount).toBe(1);
    expect(entry.unusedCount).toBe(1);
    expect(entry.pendingCount).toBe(0);
    expect(Array.isArray(entry.columns)).toBe(true);
  });

  it('危険な列レビュー payload を保存しても safe mapping に補正され、rerun-with-review で再発しない', async () => {
    const xlsxPath = createTempXlsx([
      ['<テーブルが見つかりません>', '日付', '時刻', '担当者', '電話番号【検索】', '内容', '日時', 'お客様担当'],
      ['', '2026/04/01', '09:00', '山田', '090-1111-2222', '折返し希望', '2026/04/01 09:00', '佐藤'],
      ['', '2026/04/02', '10:30', '田中', '090-3333-4444', '不在', '2026/04/02 10:30', '鈴木'],
    ]);

    try {
      const createRes = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'profile',
          filePaths: [xlsxPath],
          configPath: CONFIG_PATH,
        }),
      });
      expect(createRes.status).toBe(200);
      const run = await createRes.json();

      const badReviews = [
        { position: 0, label: '<テーブルが見つかりません>', key: 'call_datetime', meaning: '日時', inUse: 'yes', required: 'yes', rule: '' },
        { position: 1, label: '日付', key: 'phone', meaning: '電話番号', inUse: 'yes', required: 'yes', rule: '' },
        { position: 2, label: '時刻', key: 'company_name', meaning: '会社名', inUse: 'yes', required: 'yes', rule: '' },
        { position: 3, label: '担当者', key: 'contact_name', meaning: '担当者名', inUse: 'yes', required: 'yes', rule: '' },
        { position: 4, label: '電話番号【検索】', key: 'result', meaning: '結果', inUse: 'yes', required: 'yes', rule: '' },
        { position: 5, label: '内容', key: 'notes', meaning: '備考', inUse: 'yes', required: 'yes', rule: '' },
        { position: 6, label: '日時', key: '', meaning: '', inUse: 'yes', required: 'yes', rule: '' },
        { position: 7, label: 'お客様担当', key: '', meaning: '担当者名', inUse: 'yes', required: 'yes', rule: '' },
      ];
      const saveRes = await fetch(`${baseUrl}/api/column-reviews/${run.id}/call-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviews: badReviews }),
      });
      expect(saveRes.status).toBe(200);
      const saveBody = await saveRes.json();
      expect(saveBody.effectiveSummary.pendingCount).toBe(4);

      const effectiveRes = await fetch(`${baseUrl}/api/column-reviews/${run.id}/call-history/effective`);
      expect(effectiveRes.status).toBe(200);
      const effective = await effectiveRes.json();
      expect(effective.mapping['<テーブルが見つかりません>']).toBeUndefined();
      expect(effective.mapping['日付']).toBeUndefined();
      expect(effective.mapping['時刻']).toBeUndefined();
      expect(effective.mapping['担当者']).toBe('contact_name');
      expect(effective.mapping['電話番号【検索】']).toBe('phone');
      expect(effective.mapping['内容']).toBe('notes');
      expect(effective.mapping['日時']).toBe('call_datetime');
      expect(effective.mapping['お客様担当']).toBeUndefined();

      const rerunRes = await fetch(`${baseUrl}/api/runs/${run.id}/rerun-with-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'call-history' }),
      });
      expect(rerunRes.status).toBe(200);
      const rerun = await rerunRes.json();
      expect(rerun.summary.recordCount).toBe(2);
      expect(rerun.summary.columnCount).toBe(8);
      expect(rerun.summary.normalizedCount + rerun.summary.quarantineCount).toBe(2);
    } finally {
      rmSync(dirname(xlsxPath), { recursive: true, force: true });
    }
  });

  // ===== save-candidate-profile API tests =====

  describe('POST /api/runs/:id/save-candidate-profile', () => {
    it('returns 400 when profileId is missing', async () => {
      const runsRes = await fetch(`${baseUrl}/api/runs`);
      const runs = await runsRes.json();
      const runId = runs[0].id;

      const res = await fetch(`${baseUrl}/api/runs/${runId}/save-candidate-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });

    it('returns 404 when run does not exist', async () => {
      const res = await fetch(`${baseUrl}/api/runs/nonexistent-run/save-candidate-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'new' }),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });

    it('returns 404 when effective mapping does not exist for the run', async () => {
      // Use a fresh run that has no column review saved
      const createRes = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'profile',
          filePaths: [APO_LIST],
          configPath: CONFIG_PATH,
        }),
      });
      const freshRun = await createRes.json();

      const res = await fetch(`${baseUrl}/api/runs/${freshRun.id}/save-candidate-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'new' }),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });

    it('returns 200 with { id, label, saved: true } when run and effective mapping exist', async () => {
      const runsRes = await fetch(`${baseUrl}/api/runs`);
      const runs = await runsRes.json();
      const runId = runs[0].id;
      const profileId = 'new';

      // Save a column review first (also saves effective mapping)
      const reviews = [
        { position: 0, label: '顧客名', key: 'customer_name', meaning: '顧客名', inUse: 'yes', required: 'yes', rule: '' },
        { position: 1, label: '電話番号', key: 'phone', meaning: '電話番号', inUse: 'no', required: 'no', rule: '' },
      ];
      const saveReviewRes = await fetch(`${baseUrl}/api/column-reviews/${runId}/${profileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviews }),
      });
      expect(saveReviewRes.status).toBe(200);

      // Now save candidate profile
      const res = await fetch(`${baseUrl}/api/runs/${runId}/save-candidate-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, label: 'テスト顧客マスタ' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBeTruthy();
      expect(body.label).toBeTruthy();
      expect(body.saved).toBe(true);
    });
  });

  // ===== fast-path API tests =====

  describe('POST /api/runs/:id/fast-path', () => {
    it('returns 400 when profileId is missing', async () => {
      const runsRes = await fetch(`${baseUrl}/api/runs`);
      const runs = await runsRes.json();
      const runId = runs[0].id;

      const res = await fetch(`${baseUrl}/api/runs/${runId}/fast-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns: [] }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });

    it('returns 404 when run does not exist', async () => {
      const res = await fetch(`${baseUrl}/api/runs/nonexistent-run/fast-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'apo-list', columns: [] }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 400 when profileId is "new" (no profile for fast path)', async () => {
      const runsRes = await fetch(`${baseUrl}/api/runs`);
      const runs = await runsRes.json();
      const runId = runs[0].id;

      const res = await fetch(`${baseUrl}/api/runs/${runId}/fast-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'new', columns: [] }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });

    it('returns 200 with runId for valid known profile (apo-list)', async () => {
      // apo-list profile の列定義に合わせた列名（先頭 6 列分）
      const columns = ['顧客名', '電話番号', 'メールアドレス', '会社名', '住所', '担当者名'];

      // Create a fresh run with APO_LIST
      const createRes = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'normalize',
          filePaths: [APO_LIST],
          configPath: CONFIG_PATH,
        }),
      });
      expect(createRes.status).toBe(200);
      const run = await createRes.json();
      const runId = run.id;

      const res = await fetch(`${baseUrl}/api/runs/${runId}/fast-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'apo-list', columns }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.runId).toBeTruthy();
      expect(body.effectiveSummary).toBeDefined();
      expect(body.effectiveSummary.activeCount).toBeGreaterThan(0);
      expect(body.effectiveSummary.pendingCount).toBeGreaterThanOrEqual(0);
    });

    it('fast path で進んだ run には usedFastPath フラグが記録される', async () => {
      const columns = ['顧客名', '電話番号', 'メールアドレス', '会社名', '住所', '担当者名'];

      // Create a fresh run
      const createRes = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'normalize',
          filePaths: [APO_LIST],
          configPath: CONFIG_PATH,
        }),
      });
      const run = await createRes.json();
      const runId = run.id;

      await fetch(`${baseUrl}/api/runs/${runId}/fast-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'apo-list', columns }),
      });

      // 元の run meta に usedFastPath が記録されていること
      const metaRes = await fetch(`${baseUrl}/api/runs/${runId}`);
      const meta = await metaRes.json();
      expect(meta.usedFastPath).toBe(true);
      expect(meta.fastPathProfileId).toBe('apo-list');
      expect(meta.skippedColumnReview).toBe(true);
    });

    it('new file では fast path を使えない（profile が必要）', async () => {
      const runsRes = await fetch(`${baseUrl}/api/runs`);
      const runs = await runsRes.json();
      const runId = runs[0].id;

      const res = await fetch(`${baseUrl}/api/runs/${runId}/fast-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'new', columns: ['列A', '列B'] }),
      });
      // new profile は fast path 不可
      expect(res.status).toBe(400);
    });

    it('fast path 後も既存の normalize / rerun 導線が動く（fast path run の column-status が存在する）', async () => {
      const columns = ['顧客名', '電話番号', 'メールアドレス', '会社名', '住所', '担当者名'];

      const createRes = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'normalize',
          filePaths: [APO_LIST],
          configPath: CONFIG_PATH,
        }),
      });
      const run = await createRes.json();
      const runId = run.id;

      await fetch(`${baseUrl}/api/runs/${runId}/fast-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'apo-list', columns }),
      });

      // column-status が存在することを確認（fast path でも review が保存されている）
      const statusRes = await fetch(`${baseUrl}/api/runs/${runId}/column-status`);
      expect(statusRes.status).toBe(200);
      const statusData = await statusRes.json();
      expect(statusData.entries.length).toBeGreaterThanOrEqual(1);
      const entry = statusData.entries.find((e: { profileId: string }) => e.profileId === 'apo-list');
      expect(entry).toBeDefined();
      expect(entry.activeCount).toBeGreaterThan(0);
      expect(entry.pendingCount).toBeGreaterThanOrEqual(0);
    });
  });
});
