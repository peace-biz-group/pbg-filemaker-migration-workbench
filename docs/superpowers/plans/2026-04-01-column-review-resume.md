# 列レビュー再開・run詳細可視化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pendingConfirmation なしでも保存済み列レビューから /runs/:id/columns を再開できるようにし、run 詳細に profile・列サマリを表示する。

**Architecture:** server.ts に GET /api/runs/:id/column-status エンドポイントを追加して effective mapping サマリを返す。app.js の renderColumnReview を resume モード対応に改修し、renderRunDetail に列確認カードを追加する。

**Tech Stack:** Express (server.ts), Vanilla JS SPA (app.js), Vitest (tests)

---

## ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `src/ui/server.ts` | `GET /api/runs/:id/column-status` 追加、`findEffectiveMappings` import 追加 |
| `src/ui/public/app.js` | `renderColumnReview` resume モード対応、`renderRunDetail` 列確認カード追加・ボタン修正 |
| `test/ui/server.test.ts` | 新エンドポイントのテスト追加 |

---

## Task 1: server.ts — GET /api/runs/:id/column-status エンドポイント追加

**Files:**
- Modify: `src/ui/server.ts`

- [ ] **Step 1: `findEffectiveMappings` を import に追加**

`src/ui/server.ts` の import ブロック（line 26–27 付近）を以下に変更:
```ts
import {
  buildEffectiveMapping,
  saveEffectiveMapping,
  loadEffectiveMapping,
  findEffectiveMappings,
} from '../core/effective-mapping.js';
```

- [ ] **Step 2: 新エンドポイントを追加**

`src/ui/server.ts` の `GET /api/column-reviews/:runId/:profileId/effective` ハンドラ（line 539–544）の直後に以下を挿入:

```ts
  // --- API: Get column review status for a run (all profiles) ---
  app.get('/api/runs/:id/column-status', (req, res) => {
    const runId = req.params.id;
    const mappings = findEffectiveMappings(baseOutputDir, runId);
    if (mappings.length === 0) return res.json({ entries: [] });

    const entries = mappings.map(m => {
      const profile = m.profileId !== 'new' ? getProfileById(m.profileId) : null;
      return {
        profileId: m.profileId,
        profileName: profile?.label ?? (m.profileId === 'new' ? '新規ファイル' : m.profileId),
        activeCount: m.activeCount,
        unusedCount: m.unusedCount,
        pendingCount: m.pendingCount,
        generatedAt: m.generatedAt,
        columns: m.columns,
      };
    });
    res.json({ entries });
  });
```

- [ ] **Step 3: ビルド確認（型エラーが出ないこと）**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx tsc --noEmit 2>&1 | grep -E "server\.ts" | head -20
```

既存エラー以外が増えていないこと。

- [ ] **Step 4: コミット**

```bash
git add src/ui/server.ts
git commit -m "feat: add GET /api/runs/:id/column-status endpoint"
```

---

## Task 2: server.test.ts — 新エンドポイントのテスト追加

**Files:**
- Modify: `test/ui/server.test.ts`

- [ ] **Step 1: テストを追加**

`test/ui/server.test.ts` の末尾（最後の `it(...)` の後）に以下を追加:

```ts
  it('GET /api/runs/:id/column-status returns empty entries when no review saved', async () => {
    const runsRes = await fetch(`${baseUrl}/api/runs`);
    const runs = await runsRes.json();
    const run = runs[0];

    const res = await fetch(`${baseUrl}/api/runs/${run.id}/column-status`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toBeDefined();
    expect(Array.isArray(data.entries)).toBe(true);
    // No review saved for test run → empty
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
      { position: 0, label: '会社名', key: 'company_name', meaning: '会社名', inUse: 'yes', required: 'yes', rule: '' },
      { position: 1, label: '担当者', key: 'contact', meaning: '担当者', inUse: 'no', required: 'no', rule: '' },
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
    expect(data.entries.length).toBe(1);
    const entry = data.entries[0];
    expect(entry.profileId).toBe(profileId);
    expect(entry.profileName).toBe('新規ファイル');
    expect(entry.activeCount).toBe(1);
    expect(entry.unusedCount).toBe(1);
    expect(entry.pendingCount).toBe(0);
    expect(Array.isArray(entry.columns)).toBe(true);
  });
```

- [ ] **Step 2: テスト実行**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx vitest run test/ui/server.test.ts 2>&1 | tail -30
```

期待: 新テストが PASS。既存テストが壊れていないこと。

- [ ] **Step 3: コミット**

```bash
git add test/ui/server.test.ts
git commit -m "test: add column-status endpoint tests"
```

---

## Task 3: app.js — renderColumnReview の resume モード対応

**Files:**
- Modify: `src/ui/public/app.js`

**変更の目的:**
`pendingConfirmation` が存在しない（またはこの runId 向けのデータではない）場合でも、保存済み effective mapping から列レビューを再開できるようにする。

- [ ] **Step 1: renderColumnReview を以下で置換**

`src/ui/public/app.js` の line 1395–1558 の `async function renderColumnReview(runId) { ... }` を以下に置換:

```js
async function renderColumnReview(runId) {
  app.innerHTML = '<div class="loading">読み込み中...</div>';

  // pendingConfirmation がこの runId 用かチェック
  const hasPending = pendingConfirmation && pendingConfirmation.runId === runId;
  const data = hasPending ? pendingConfirmation : {};

  let selectedProfileId = data.selectedProfileId ?? null;
  let columns = data.columns ? [...data.columns] : [];

  // pendingConfirmation がない場合は保存済みデータから resume
  if (!hasPending) {
    try {
      const status = await api(`/api/runs/${runId}/column-status`);
      if (status.entries && status.entries.length > 0) {
        const entry = status.entries[0]; // 先頭を使う（通常 1 件）
        selectedProfileId = entry.profileId;
        // columns を effective mapping の sourceHeader から復元
        if (entry.columns && entry.columns.length > 0) {
          columns = entry.columns.map(c => c.sourceHeader);
        }
      }
    } catch { /* ignore, proceed with empty */ }

    // それでも columns が空なら source-data から取得
    if (columns.length === 0) {
      try {
        const rd = await api(`/api/runs/${runId}/source-data?offset=0&limit=5`);
        if (rd.columns) columns = rd.columns;
      } catch { /* ignore */ }
    }
  }

  // Load profile if known
  let profile = null;
  if (selectedProfileId && selectedProfileId !== 'new') {
    try { profile = await api(`/api/profiles/${selectedProfileId}`); } catch { /* ignore */ }
  }

  // Load existing review
  let existingReview = null;
  const reviewProfileId = selectedProfileId || 'new';
  try {
    const r = await api(`/api/column-reviews/${runId}/${reviewProfileId}`);
    existingReview = r.reviews;
  } catch { /* ignore */ }

  // Load preview rows
  let previewRows = data.previewRows || [];
  if (previewRows.length === 0) {
    try {
      const rd = await api(`/api/runs/${runId}/source-data?offset=0&limit=5`);
      previewRows = rd.rows || [];
      if (columns.length === 0 && rd.columns) columns = rd.columns;
    } catch { /* ignore */ }
  }

  // columns が結局空 → 案内して終了
  if (columns.length === 0 && !existingReview) {
    app.innerHTML = `
      <div class="card">
        <h2>列情報が見つかりません</h2>
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">
          この Run の列情報がまだ保存されていません。<br>
          ファイルをアップロードして確認してから進めてください。
        </p>
        <a href="/" class="btn">ダッシュボードに戻る</a>
      </div>
    `;
    return;
  }

  // Build column entries
  const entries = columns.map((col, i) => {
    const profileCol = profile?.columns?.find(c => c.position === i);
    const existing = existingReview?.find(r => r.position === i);
    const samples = previewRows.slice(0, 5).map(r => r[col]).filter(Boolean);

    return {
      position: i,
      headerName: col,
      profileLabel: profileCol?.label || '',
      profileKey: profileCol?.key || '',
      profileRequired: profileCol?.required ?? false,
      profileRule: profileCol?.rule || '',
      samples,
      meaning: existing?.meaning ?? profileCol?.label ?? '',
      inUse: existing?.inUse ?? 'unknown',
      required: existing?.required ?? (profileCol?.required ? 'yes' : 'unknown'),
      rule: existing?.rule ?? profileCol?.rule ?? '',
    };
  });

  const isResume = !hasPending && existingReview;
  let html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">列の確認</h2>
      <div class="btn-group">
        <button class="btn btn-primary" id="save-review-btn">保存</button>
        <a href="/runs/${escapeHtml(runId)}" class="btn">あとで続ける</a>
      </div>
    </div>

    <div class="card">
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">
        ${profile ? `「<strong>${escapeHtml(profile.label)}</strong>」の列を確認してください。` : '各列の意味を教えてください。'}
        ${profile?.provisional ? '<span class="badge badge-warning">仮の定義です — 確認をお願いします</span>' : ''}
        ${isResume ? '<span class="badge badge-info">保存済みの回答から続きを表示しています</span>' : ''}
      </p>
      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:16px">
        わからない場合は、そのままで大丈夫です。あとから修正できます。
      </p>
  `;

  for (const entry of entries) {
    html += `
      <div class="column-review-item" data-position="${entry.position}">
        <div class="column-review-header">
          <span class="badge badge-info">${entry.position + 1}列目</span>
          <strong>${escapeHtml(entry.headerName)}</strong>
          ${entry.profileLabel ? `<span style="font-size:12px;color:var(--text-secondary)">（候補: ${escapeHtml(entry.profileLabel)}）</span>` : ''}
        </div>

        ${entry.samples.length > 0 ? `
          <div style="margin:6px 0 8px 0;font-size:12px;color:var(--text-secondary)">
            例: ${entry.samples.slice(0, 3).map(s => `<code style="background:var(--bg);padding:1px 4px;border-radius:2px">${escapeHtml(truncate(s, 30))}</code>`).join(', ')}
          </div>
        ` : ''}

        <div class="column-review-fields">
          <div class="column-review-field">
            <label>この列は何を入れる場所ですか？</label>
            <input type="text" class="col-meaning" value="${escapeHtml(entry.meaning)}" placeholder="例: 会社名、電話番号 など">
          </div>
          <div class="column-review-field">
            <label>今も使いますか？</label>
            <select class="col-inuse">
              <option value="unknown" ${entry.inUse === 'unknown' ? 'selected' : ''}>わからない</option>
              <option value="yes" ${entry.inUse === 'yes' ? 'selected' : ''}>はい</option>
              <option value="no" ${entry.inUse === 'no' ? 'selected' : ''}>いいえ（不要）</option>
            </select>
          </div>
          <div class="column-review-field">
            <label>必須ですか？</label>
            <select class="col-required">
              <option value="unknown" ${entry.required === 'unknown' ? 'selected' : ''}>わからない</option>
              <option value="yes" ${entry.required === 'yes' ? 'selected' : ''}>はい（必須）</option>
              <option value="no" ${entry.required === 'no' ? 'selected' : ''}>いいえ</option>
            </select>
          </div>
          <div class="column-review-field">
            <label>入力ルールがありますか？</label>
            <input type="text" class="col-rule" value="${escapeHtml(entry.rule)}" placeholder="例: 半角数字のみ、日付形式 など">
          </div>
        </div>
      </div>
    `;
  }

  html += `
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-primary" id="save-review-btn-bottom">保存して結果を見る</button>
      <a href="/runs/${escapeHtml(runId)}" class="btn">あとで続ける</a>
    </div>
  `;

  app.innerHTML = html;

  // Save review handler
  const saveHandler = async () => {
    const items = document.querySelectorAll('.column-review-item');
    const reviews = [];
    items.forEach(item => {
      const pos = parseInt(item.dataset.position);
      reviews.push({
        position: pos,
        label: columns[pos] || '',
        key: entries[pos]?.profileKey || columns[pos] || '',
        meaning: item.querySelector('.col-meaning')?.value || '',
        inUse: item.querySelector('.col-inuse')?.value || 'unknown',
        required: item.querySelector('.col-required')?.value || 'unknown',
        rule: item.querySelector('.col-rule')?.value || '',
      });
    });

    try {
      const result = await api(`/api/column-reviews/${runId}/${reviewProfileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviews }),
      });

      if (result.effectiveSummary) {
        showColumnReviewSummary(runId, reviewProfileId, result.effectiveSummary);
      } else {
        navigate(`/runs/${runId}`);
      }
    } catch (err) {
      alert('保存に失敗しました: ' + err.message);
    }
  };

  document.getElementById('save-review-btn')?.addEventListener('click', saveHandler);
  document.getElementById('save-review-btn-bottom')?.addEventListener('click', saveHandler);
}
```

- [ ] **Step 2: 手動動作確認**

ブラウザで `/runs/<runId>/columns` に直接アクセスして:
- pendingConfirmation なしでロードできること
- 保存済み review が表示されること
- 保存済みがない場合は「列情報が見つかりません」が出ること

- [ ] **Step 3: コミット**

```bash
git add src/ui/public/app.js
git commit -m "feat: renderColumnReview — resume from saved review without pendingConfirmation"
```

---

## Task 4: app.js — renderRunDetail に列確認カードと修正済みボタンを追加

**Files:**
- Modify: `src/ui/public/app.js`

**変更の目的:**
- 「列レビュー」ボタンを正しく `/runs/:id/columns` に遷移させる
- run 詳細に、列確認状況（profile 名・使う/使わない/未確定 件数）を表示する
- 「列の確認を再開」リンクを追加する

- [ ] **Step 1: renderRunDetail 内の「列レビュー」ボタンハンドラを修正**

`src/ui/public/app.js` の line 803–820 の `btn-start-review-from-run` イベントリスナーを以下に置換:

```js
    // Start column review from run detail
    document.getElementById('btn-start-review-from-run').addEventListener('click', () => {
      navigate(`/runs/${runId}/columns`);
    });
```

- [ ] **Step 2: run 詳細ページに列確認カードを追加**

`renderRunDetail` の `app.innerHTML = html;` (line 790) の直前（`app.innerHTML = html;` の前、html 組み立ての末尾）に追加:

実装方法: `app.innerHTML = html;` の後に、非同期で列確認カードを追加する処理を挿入する。

具体的には、`app.innerHTML = html;` (line 790) の次の行（`// Delete button` の前）に以下を挿入:

```js
    // 列確認カードを非同期でロード
    loadColumnStatusCard(runId);
```

そして `renderRunDetail` 関数の外（`// --- Tab content loading ---` の前）に以下の関数を追加:

```js
async function loadColumnStatusCard(runId) {
  try {
    const status = await api(`/api/runs/${runId}/column-status`);
    if (!status.entries || status.entries.length === 0) return;

    const entry = status.entries[0];
    const cardHtml = `
      <div class="card" id="column-status-card">
        <h2>列の確認状況</h2>
        <p style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">
          ファイル種別: <strong>${escapeHtml(entry.profileName)}</strong>
        </p>
        <div class="stats" style="margin-bottom:12px">
          <div class="stat"><div class="label">使う列</div><div class="value">${entry.activeCount}</div></div>
          <div class="stat"><div class="label">使わない列</div><div class="value">${entry.unusedCount}</div></div>
          <div class="stat"><div class="label">まだ決まっていない列</div><div class="value">${entry.pendingCount}</div></div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a href="/runs/${escapeHtml(runId)}/columns" class="btn btn-primary">列の確認を再開</a>
        </div>
        <p style="font-size:11px;color:var(--text-secondary);margin-top:8px">
          この内容はあとから続けられます
        </p>
      </div>
    `;
    // サマリカードの直後に挿入
    const summaryCard = app.querySelector('.card');
    if (summaryCard) {
      summaryCard.insertAdjacentHTML('afterend', cardHtml);
    }
  } catch { /* ignore — column status is optional */ }
}
```

- [ ] **Step 3: コミット**

```bash
git add src/ui/public/app.js
git commit -m "feat: run detail — add column status card and fix review navigation"
```

---

## Task 5: 全テスト実行・既存エラーとの切り分け確認

- [ ] **Step 1: typecheck（既存エラーとの差分確認）**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx tsc --noEmit 2>&1 | grep -c "error TS"
```

数が増えていないこと。

- [ ] **Step 2: lint（既存エラーとの差分確認）**

```bash
npx eslint src/ui/server.ts 2>&1 | tail -10
```

- [ ] **Step 3: 全テスト実行**

```bash
npx vitest run 2>&1 | tail -30
```

今回の変更で新しい FAIL が増えていないこと。

- [ ] **Step 4: 最終コミット（必要な場合）**

```bash
git status
```
