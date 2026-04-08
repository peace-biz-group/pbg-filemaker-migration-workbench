# UI 全面改善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全4画面の UI を日本語前提・非技術者前提で全面改善し、英語・内部用語・曖昧表現を排除する

**Architecture:** 変更対象は `src/ui/public/app.js`（全画面の HTML テンプレート）、`src/ui/public/style.css`（CSS）、`src/ui/public/index.html`（ナビ）、`src/file-profiles/types.ts`（ColumnReviewEntry 型）。バックエンド API は後方互換を維持しつつ `required` フィールドを無視する軽微な調整のみ。

**Tech Stack:** Vanilla JS SPA, Express, TypeScript

**Spec:** `docs/superpowers/specs/2026-04-08-ui-overhaul-design.md`

---

### Task 1: CSS — 列確認用の新しいスタイル追加

**Files:**
- Modify: `src/ui/public/style.css:417-506` (column review section)

- [ ] **Step 1: 列カード 2カラムグリッドと新スタイルを追加**

`style.css` の column review セクション（417行目付近〜）を以下のように変更する。
既存の `.column-review-fields` の 4カラムグリッド定義と `.choice-row` / `.choice-chip` 関連スタイルを削除し、新しいスタイルに置き換える。

削除対象:
- `.column-review-fields` の `grid-template-columns: minmax(280px, ...)` 定義 (435行目)
- `.choice-row` と `.choice-chip` 関連 (457-496行目)
- `@media (max-width: 1200px)` の `.column-review-fields` ルール (498-499行目)

追加するCSS:
```css
/* Column review — 2-column card grid */
.column-review-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

/* Column review — input pair (meaning + rule) */
.column-review-inputs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 8px;
}

.column-review-inputs label {
  display: block;
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 3px;
}

.column-review-inputs input {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 12px;
  font-family: inherit;
  box-sizing: border-box;
}

.column-review-inputs input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

/* Use / Don't use toggle */
.use-toggle {
  display: flex;
  gap: 8px;
}

.use-toggle label {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 8px 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s;
}

.use-toggle label:hover {
  border-color: var(--primary);
}

.use-toggle .active-yes {
  border: 2px solid var(--success);
  background: #dcfce7;
  font-weight: 700;
  color: #15803d;
}

.use-toggle .active-no {
  border: 2px solid #6b7280;
  background: #f3f4f6;
  font-weight: 700;
  color: #374151;
}

/* Unused card greyed out */
.column-review-item.unused {
  opacity: 0.65;
  background: #fafafa;
  border-color: var(--border);
}

.column-review-item.unused input:disabled {
  color: #d1d5db;
  background: #f9fafb;
}

/* Active (used) card */
.column-review-item.used {
  border: 2px solid var(--success);
  background: #fafffe;
}

/* Unanswered card */
.column-review-item.unanswered {
  border: 1px solid #fde68a;
  background: #fffdf7;
}

/* Summary bar */
.column-summary-bar {
  margin-top: 16px;
  padding: 12px 16px;
  background: var(--bg);
  border-radius: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.column-summary-bar .summary-counts {
  display: flex;
  gap: 20px;
  font-size: 13px;
}

.column-summary-bar .summary-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 4px;
}

/* Header row card style for new run page */
.header-row-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  background: var(--bg);
  border-radius: var(--radius);
  margin-bottom: 16px;
}

.header-row-card input[type="checkbox"] {
  width: 18px;
  height: 18px;
}

@media (max-width: 768px) {
  .column-review-grid {
    grid-template-columns: 1fr;
  }
  .column-review-inputs {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 2: 既存の不要な CSS を削除**

以下を削除:
- `.column-review-fields` の 4カラムグリッド定義 (435行目)
- `.column-review-field` 関連スタイル (438-455行目)
- `.choice-row` (457-462行目)
- `.choice-row label, .choice-chip` (464-477行目)
- `.choice-chip input[type="radio"]` (478-480行目)
- `.column-review-field .choice-row` 固定幅スタイル (482-496行目)
- `@media (max-width: 1200px)` 内の `.column-review-fields` ルール (498-499行目)

- [ ] **Step 3: ビルド確認**

Run: `npx tsc --noEmit`
Expected: 既存のエラーが増えないこと（CSS のみの変更なので型チェック影響なし）

- [ ] **Step 4: コミット**

```bash
git add src/ui/public/style.css
git commit -m "style: replace column review CSS with 2-column grid and use/unused toggle"
```

---

### Task 2: index.html — ナビゲーション日本語化

**Files:**
- Modify: `src/ui/public/index.html`

- [ ] **Step 1: ナビリンクを変更**

`src/ui/public/index.html` の `<nav>` を変更:

Before:
```html
    <a href="/new">新規 Run</a>
```

After:
```html
    <a href="/new">新しく読み込む</a>
```

- [ ] **Step 2: コミット**

```bash
git add src/ui/public/index.html
git commit -m "ui: rename nav link from 新規 Run to 新しく読み込む"
```

---

### Task 3: app.js — ダッシュボード改善

**Files:**
- Modify: `src/ui/public/app.js:92-178` (renderDashboard function)

- [ ] **Step 1: renderDashboard を書き換え**

`renderDashboard` 関数（92-178行目）を以下に置き換える。

主な変更:
- 見出し「直近の実行結果」→「最近の作業」
- ボタン「新規 Run」→「新しく読み込む」
- run-item 内の `run.mode` 表示を削除
- ファイル名を主表示にする
- `mode: ${modes}` 表示を削除
- 状態バッジを拡張（完了/列の確認中/設定保存済み/エラー/処理中）

```javascript
async function renderDashboard() {
  app.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">最近の作業</h2>
      <div class="btn-group">
        <a href="/import" class="btn btn-primary">ファイルを取り込む</a>
        <a href="/new" class="btn btn-primary">新しく読み込む</a>
      </div>
    </div>
    <div class="card" id="run-list-card">
      <div class="loading">読み込み中...</div>
    </div>
    <div class="card" id="review-list-card" style="display:none">
      <h3>レビュー</h3>
    </div>
  `;

  try {
    const runs = await api('/api/runs');
    const container = $('#run-list-card');

    if (runs.length === 0) {
      container.innerHTML = `
        <div class="empty">
          <p>まだ作業がありません</p>
          <a href="/new" class="btn btn-primary" style="margin-top:12px">ファイルを読み込む</a>
        </div>
      `;
      return;
    }

    let html = '<div class="run-list">';
    for (const run of runs) {
      const files = run.inputFiles.map(f => f.split('/').pop()).join(', ');
      const time = new Date(run.startedAt).toLocaleString('ja-JP');
      const fileType = run.summary?.fileType
        ? label('fileTypes', run.summary.fileType)
        : '';

      // 状態判定
      let statusHtml = '';
      let ctaHtml = '';
      if (run.status === 'failed') {
        statusHtml = '<span class="badge badge-danger">エラー</span>';
      } else if (run.status !== 'completed') {
        statusHtml = '<span class="badge badge-warning">処理中</span>';
      } else {
        // completed — 列確認状態で細分化
        const cs = run.columnStatus;
        if (cs && cs.pendingCount > 0) {
          statusHtml = '<span class="badge badge-warning">列の確認中</span>';
          ctaHtml = `<a href="/runs/${run.id}/columns" class="btn" style="font-size:12px;padding:4px 12px">確認を続ける</a>`;
        } else if (cs && cs.savedAsCandidate) {
          statusHtml = '<span class="badge badge-info">設定保存済み</span>';
        } else {
          statusHtml = '<span class="badge badge-success">完了</span>';
        }
      }

      const subtitleParts = [fileType].filter(Boolean);
      if (run.status === 'failed' && run.error) {
        subtitleParts.push(run.error.slice(0, 40));
      }

      html += `
        <a href="/runs/${run.id}" class="run-item">
          ${statusHtml}
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(files)}</div>
            ${subtitleParts.length > 0 ? `<div style="font-size:12px;color:var(--text-secondary)">${escapeHtml(subtitleParts.join(' — '))}</div>` : ''}
          </div>
          ${ctaHtml}
          <span class="run-time">${time}</span>
        </a>
      `;
    }
    html += '</div>';
    container.innerHTML = `<h3>最近の作業 (${runs.length}件)</h3>` + html;

    // Load reviews for dashboard
    try {
      const reviews = await api('/api/reviews');
      if (reviews.length > 0) {
        const revCard = document.getElementById('review-list-card');
        revCard.style.display = '';
        let revHtml = `<h3>レビュー (${reviews.length}件)</h3><div class="run-list">`;
        for (const rev of reviews) {
          const statusBadge = rev.reviewStatus === 'draft'
            ? '<span class="badge badge-warning">下書き</span>'
            : rev.reviewStatus === 'reviewed'
              ? '<span class="badge badge-info">レビュー済</span>'
              : `<span class="badge">${rev.reviewStatus}</span>`;
          const time = new Date(rev.updatedAt).toLocaleString('ja-JP');
          revHtml += `
            <a href="/reviews/${rev.id}/columns" class="run-item">
              <span class="run-mode">${escapeHtml(rev.fileName)}</span>
              ${statusBadge}
              <span class="run-files">${rev.reviewer || '—'}</span>
              <span class="run-time">${time}</span>
            </a>
          `;
        }
        revHtml += '</div>';
        revCard.innerHTML = revHtml;
      }
    } catch { /* ignore review load error */ }

  } catch (err) {
    $('#run-list-card').innerHTML = `<p class="empty">読み込みに失敗しました: ${err.message}</p>`;
  }
}
```

注: `run.columnStatus` は既存の `/api/runs` レスポンスにない場合がある。
その場合 `cs` は undefined になるので、デフォルトで「完了」バッジが表示される。
将来的に `/api/runs` に columnStatus サマリを含めることで細分化が機能するが、
現時点ではクライアント側で安全に fallback する。

- [ ] **Step 2: 動作確認**

ブラウザで `http://localhost:24242/` を開き:
- 見出しが「最近の作業」になっていること
- run-item にファイル名が主表示されていること
- mode が表示されていないこと

- [ ] **Step 3: コミット**

```bash
git add src/ui/public/app.js
git commit -m "ui(dashboard): show filename as primary, remove mode display, Japanese status badges"
```

---

### Task 4: app.js — 新規 Run 画面改善

**Files:**
- Modify: `src/ui/public/app.js:184-477` (renderNewRun function and handlers)

- [ ] **Step 1: renderNewRun の HTML テンプレートを書き換え**

`renderNewRun` 関数内の `app.innerHTML` テンプレート（194-267行目）を以下に置き換える。

```javascript
  app.innerHTML = `
    <h2 style="font-size:18px;margin-bottom:4px">新しくファイルを読み込む</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">ファイルを選んで中身を確認します。設定は通常そのままで大丈夫です。</p>
    <div class="card">
      <form id="run-form">
        <input type="hidden" name="mode" value="run-all">
        <input type="hidden" name="configPath" value="">

        <div class="form-group">
          <label>入力ファイル</label>
          <div class="drop-zone" id="drop-zone">
            <p>CSV / XLSX ファイルをここにドロップ<br>またはクリックしてファイルを選択</p>
            <input type="file" id="file-input" multiple accept=".csv,.xlsx" style="display:none">
            <div class="file-list-preview" id="file-preview"></div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
          <div class="form-group" style="margin-bottom:0">
            <label>文字コード</label>
            <select name="encoding">
              <option value="auto" selected>自動検出（通常はこのまま）</option>
              <option value="cp932">Shift-JIS (CP932)</option>
              <option value="utf8">UTF-8</option>
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>区切り文字</label>
            <select name="delimiter">
              <option value="auto">自動検出（通常はこのまま）</option>
              <option value=",">カンマ (,)</option>
              <option value="\t">タブ</option>
              <option value=";">セミコロン (;)</option>
            </select>
          </div>
        </div>

        <div class="header-row-card">
          <input type="checkbox" name="hasHeader" id="has-header-checkbox">
          <div>
            <div style="font-size:14px;font-weight:600">1行目は見出し（項目名）</div>
            <div style="font-size:11px;color:var(--text-secondary)">ファイル選択時に自動で切り替わります</div>
          </div>
        </div>

        <details style="margin-bottom:16px">
          <summary style="font-size:12px;color:var(--text-secondary);cursor:pointer">ローカルパスを直接指定する場合</summary>
          <div style="margin-top:8px">
            <textarea name="filePaths" placeholder="1行に1ファイルパスを入力" rows="3" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius);font-size:13px;font-family:inherit;box-sizing:border-box"></textarea>
            <p style="font-size:11px;color:var(--text-secondary);margin-top:4px">
              このパソコンから読み取れるファイルの場所を入力してください
            </p>
          </div>
        </details>

        <div id="progress-area" style="display:none">
          <div class="progress-container">
            <div class="progress-bar-wrap"><div class="progress-bar-fill" id="progress-fill"></div></div>
            <div class="progress-step" id="progress-text"></div>
          </div>
        </div>

        <div style="display:flex;gap:8px;align-items:center">
          <button type="button" class="btn btn-primary" id="confirm-btn">ファイルを確認する</button>
          <button type="button" class="btn" id="preview-btn">中身をプレビュー</button>
          <span id="run-status" style="font-size:13px;color:var(--text-secondary)"></span>
        </div>
      </form>
    </div>
  `;
```

注意: `<button type="submit">` の「確認せず実行」ボタンは完全に削除する。
`form` の `submit` イベントハンドラ（284-343行目）も削除する。

- [ ] **Step 2: hasHeader の自動切替ロジックを追加**

`addFiles` 関数（667行目）の末尾、`renderFilePreview()` の直後に以下を追加:

```javascript
  // ファイル拡張子に応じて hasHeader を自動切替
  const cb = document.getElementById('has-header-checkbox');
  if (cb && uploadedFiles.length > 0) {
    const lastFile = uploadedFiles[uploadedFiles.length - 1];
    const ext = lastFile.name.toLowerCase().split('.').pop();
    cb.checked = (ext === 'xlsx');
  }
```

- [ ] **Step 3: submit イベントハンドラの削除**

`$('#run-form').addEventListener('submit', ...)` ブロック（284-343行目）を削除する。
フォームの submit イベントはもう発火しない（submit ボタンが存在しないため）。

- [ ] **Step 4: confirm ボタンハンドラの hasHeader 参照を修正**

confirm ボタンハンドラ（394-476行目）で `form.hasHeader.checked` を参照している箇所を、チェックボックスの新しい id に合わせる:

Before:
```javascript
hasHeader: form.hasHeader.checked,
```

After:
```javascript
hasHeader: document.getElementById('has-header-checkbox').checked,
```

この変更は2箇所ある（430行目付近と464行目付近）。

- [ ] **Step 5: preview モーダル内の英語を日本語化**

`showPreviewModal` 関数（564行目付近）の以下を修正:

Before:
```javascript
        <h2 style="font-size:16px">Preview: ${escapeHtml(data.file.split('/').pop())}</h2>
```
After:
```javascript
        <h2 style="font-size:16px">プレビュー: ${escapeHtml(data.file.split('/').pop())}</h2>
```

Before:
```javascript
        カラム: ${(data.columns || []).length} |
        Schema FP: ${(data.schemaFingerprint || '').slice(0,16)}... |
        Parse エラー: ${data.parseFailures ? data.parseFailures.length : 0}
```
After:
```javascript
        列数: ${(data.columns || []).length} |
        読み取りエラー: ${data.parseFailures ? data.parseFailures.length : 0}
```
（Schema FP 行を削除）

Before:
```javascript
        alert('Preview 失敗: ' + err.message);
```
After:
```javascript
        alert('プレビューに失敗しました: ' + err.message);
```

- [ ] **Step 6: 動作確認**

ブラウザで `/new` を開き:
- 「確認せず実行」ボタンが存在しないこと
- ドロップゾーンが上部にあること
- 文字コードのデフォルトが「自動検出」であること
- ヘッダ行のチェックボックスがカード風レイアウトであること
- CSV ファイルをドロップ → チェック OFF
- XLSX ファイルをドロップ → チェック ON
- 実行モード・設定ファイルの select が見えないこと
- ローカルパスが `<details>` で折りたたまれていること

- [ ] **Step 7: コミット**

```bash
git add src/ui/public/app.js
git commit -m "ui(new-run): remove skip-confirm button, auto-detect header by file type, Japanese labels"
```

---

### Task 5: app.js — 列の確認画面を改善

**Files:**
- Modify: `src/ui/public/app.js:2008-2247` (renderColumnReview function)

- [ ] **Step 1: renderColumnReview の entry 構築を簡素化**

`entries` の構築（2088-2108行目）を修正。`required` フィールドを削除し、`inUse` のデフォルトを変更:

Before:
```javascript
      inUse: existingInUse ?? (inferredKey ? 'yes' : 'unknown'),
      required: existing?.required ?? (profileCol ? (profileCol.required ? 'yes' : 'no') : 'unknown'),
```

After:
```javascript
      inUse: existing?.inUse === 'yes' ? 'yes' : (existing?.inUse === 'no' ? 'no' : (inferredKey ? 'yes' : '')),
```

（`required` 行を削除。`inUse` の `'unknown'` は空文字に変換 = 未回答）

- [ ] **Step 2: 列カードの HTML テンプレートを書き換え**

`for (const entry of entries)` ループ内の HTML（2156-2198行目）を以下に置き換え:

```javascript
    const cardClass = entry.inUse === 'yes' ? 'used' : entry.inUse === 'no' ? 'unused' : 'unanswered';
    const isUnused = entry.inUse === 'no';
    const isNewCol = driftCtx?.addedColumns?.includes(entry.headerName) ?? false;
    html += `
      <div class="column-review-item ${cardClass}" data-position="${entry.position}">
        <div class="column-review-header">
          <span class="badge badge-info">${entry.position + 1}列目</span>
          <strong>${escapeHtml(entry.headerName)}</strong>
          ${isNewCol ? '<span class="badge badge-warning" style="margin-left:4px">新しい列</span>' : ''}
          ${entry.inUse === '' ? '<span class="badge" style="background:#fef3c7;color:#d97706;margin-left:4px">未回答</span>' : ''}
          ${entry.profileLabel ? `<span style="font-size:12px;color:var(--text-secondary)">（候補: ${escapeHtml(entry.profileLabel)}）</span>` : ''}
        </div>

        ${entry.samples.length > 0 ? `
          <div style="margin:4px 0 8px 0;font-size:11px;color:var(--text-secondary)">
            例: ${entry.samples.slice(0, 3).map(s => `<code style="background:var(--bg);padding:1px 4px;border-radius:2px">${escapeHtml(truncate(s, 30))}</code>`).join(', ')}
          </div>
        ` : ''}

        <div class="column-review-inputs">
          <div>
            <label>何を入力する列？</label>
            <input type="text" class="col-meaning" value="${escapeHtml(entry.meaning)}" placeholder="例: 会社名、電話番号" ${isUnused ? 'disabled' : ''}>
          </div>
          <div>
            <label>入力規則・選択肢</label>
            <input type="text" class="col-rule" value="${escapeHtml(entry.rule)}" placeholder="例: 半角数字のみ、選択肢名" ${isUnused ? 'disabled' : ''}>
          </div>
        </div>

        <div class="use-toggle">
          <label class="${entry.inUse === 'yes' ? 'active-yes' : ''}">
            <input type="radio" name="inuse-${entry.position}" class="col-inuse" value="yes" ${entry.inUse === 'yes' ? 'checked' : ''}> 使う
          </label>
          <label class="${entry.inUse === 'no' ? 'active-no' : ''}">
            <input type="radio" name="inuse-${entry.position}" class="col-inuse" value="no" ${entry.inUse === 'no' ? 'checked' : ''}> 使わない
          </label>
        </div>
        ${entry.inUse === '' ? '<div style="font-size:10px;color:#d97706;margin-top:4px">※ 選ばないと「使わない」扱いになります</div>' : ''}
      </div>
    `;
```

- [ ] **Step 3: カード群を 2カラムグリッドで囲む**

カード群を囲む要素を変更。

Before (2153行目付近):
```javascript
  // for ループの前
  // 直接 card div の中にカードが並んでいる
```

After: for ループの直前に `<div class="column-review-grid">` を追加し、ループの直後に `</div>` で閉じる。

- [ ] **Step 4: サマリバーを追加**

for ループ直後（`</div>` の後、カードの `</div>` 閉じの前）に:

```javascript
    // Summary bar
    const usedCount = entries.filter(e => e.inUse === 'yes').length;
    const unusedCount = entries.filter(e => e.inUse === 'no').length;
    const unansweredCount = entries.filter(e => e.inUse !== 'yes' && e.inUse !== 'no').length;

    html += `
      <div class="column-summary-bar">
        <div class="summary-counts">
          <span><span class="summary-dot" style="background:#16a34a"></span>使う: <strong>${usedCount}</strong></span>
          <span><span class="summary-dot" style="background:#9ca3af"></span>使わない: <strong>${unusedCount}</strong></span>
          <span><span class="summary-dot" style="background:#f59e0b"></span>未回答: <strong>${unansweredCount}</strong></span>
        </div>
        <button class="btn btn-primary" id="save-review-btn-summary">確認を保存する</button>
      </div>
    `;
```

- [ ] **Step 5: ヘッダーのボタンラベルを変更**

Before:
```javascript
        <button class="btn btn-primary" id="save-review-btn">保存</button>
        <a href="/runs/${escapeHtml(runId)}" class="btn">あとで続ける</a>
```

After:
```javascript
        <button class="btn btn-primary" id="save-review-btn">確認を保存する</button>
        <a href="/runs/${escapeHtml(runId)}" class="btn">あとで続ける</a>
```

- [ ] **Step 6: 下部のボタンを変更**

Before:
```javascript
      <button class="btn btn-primary" id="save-review-btn-bottom">保存して結果を見る</button>
```

After:
```javascript
      <button class="btn btn-primary" id="save-review-btn-bottom">確認を保存する</button>
```

- [ ] **Step 7: カード操作のイベントハンドラを追加**

`saveHandler` 定義の前に、use-toggle の動的スタイリングハンドラを追加:

```javascript
  // Use toggle interaction
  document.querySelectorAll('.use-toggle input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const card = e.target.closest('.column-review-item');
      if (!card) return;
      const value = e.target.value;

      // Update card class
      card.classList.remove('used', 'unused', 'unanswered');
      card.classList.add(value === 'yes' ? 'used' : 'unused');

      // Update toggle label classes
      card.querySelectorAll('.use-toggle label').forEach(lbl => {
        lbl.classList.remove('active-yes', 'active-no');
      });
      e.target.closest('label').classList.add(value === 'yes' ? 'active-yes' : 'active-no');

      // Disable/enable inputs
      card.querySelectorAll('.column-review-inputs input').forEach(inp => {
        inp.disabled = (value === 'no');
      });

      // Remove unanswered hint
      const hint = card.querySelector('[style*="color:#d97706"]');
      if (hint && hint.textContent.includes('選ばないと')) hint.remove();
      const unansweredBadge = card.querySelector('.badge[style*="fef3c7"]');
      if (unansweredBadge) unansweredBadge.remove();

      // Update summary bar counts
      updateSummaryBar();
    });
  });

  function updateSummaryBar() {
    const items = document.querySelectorAll('.column-review-item');
    let used = 0, unused = 0, unanswered = 0;
    items.forEach(item => {
      const checked = item.querySelector('.col-inuse:checked');
      if (checked?.value === 'yes') used++;
      else if (checked?.value === 'no') unused++;
      else unanswered++;
    });
    const countsEl = document.querySelector('.summary-counts');
    if (countsEl) {
      countsEl.innerHTML = `
        <span><span class="summary-dot" style="background:#16a34a"></span>使う: <strong>${used}</strong></span>
        <span><span class="summary-dot" style="background:#9ca3af"></span>使わない: <strong>${unused}</strong></span>
        <span><span class="summary-dot" style="background:#f59e0b"></span>未回答: <strong>${unanswered}</strong></span>
      `;
    }
  }
```

- [ ] **Step 8: saveHandler の required 送信を修正**

saveHandler 内の reviews push（2216-2226行目）を修正:

Before:
```javascript
        inUse: item.querySelector('.col-inuse:checked')?.value || 'yes',
        required: item.querySelector('.col-required:checked')?.value || 'yes',
        rule: item.querySelector('.col-rule')?.value || '',
```

After:
```javascript
        inUse: item.querySelector('.col-inuse:checked')?.value || 'no',
        required: 'unknown',
        rule: item.querySelector('.col-rule')?.value || '',
```

注: 未回答（ラジオ未選択）は `'no'` として送信（使わない扱い）。
`required` は常に `'unknown'` を送信（後方互換のためフィールドは残す）。

- [ ] **Step 9: サマリバーの保存ボタンにもイベントを接続**

saveHandler の接続部分に追加:

```javascript
  document.getElementById('save-review-btn-summary')?.addEventListener('click', saveHandler);
```

- [ ] **Step 10: 動作確認**

ブラウザで `/runs/{id}/columns` を開き:
- 2カラムグリッドで列カードが表示されること
- 「使う/使わない」の二択ボタンが表示されること
- 「使わない」を押すとカードがグレーアウトすること
- 入力欄が「何を入力する列？」と「入力規則・選択肢」の横並びであること
- サマリバーにカウントが表示されること
- 保存が正常に動作すること

- [ ] **Step 11: コミット**

```bash
git add src/ui/public/app.js
git commit -m "ui(column-review): 2-column grid, use/unused binary toggle, summary bar"
```

---

### Task 6: app.js — 列確認結果画面の改善

**Files:**
- Modify: `src/ui/public/app.js:2249-2308` (showColumnReviewSummary function)

- [ ] **Step 1: showColumnReviewSummary を書き換え**

`showColumnReviewSummary` 関数（2249-2308行目）を以下に置き換え:

```javascript
function showColumnReviewSummary(runId, profileId, summary) {
  const { activeCount, unusedCount, pendingCount } = summary;
  const unansweredCount = pendingCount;

  app.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">列の確認結果</h2>
    </div>
    <div class="card">
      <div class="stats" style="margin-bottom:16px">
        <div class="stat">
          <div class="label">使う列</div>
          <div class="value" style="color:var(--success)">${activeCount}</div>
        </div>
        <div class="stat">
          <div class="label">使わない列</div>
          <div class="value" style="color:var(--text-secondary)">${unusedCount}</div>
        </div>
        <div class="stat">
          <div class="label">未回答</div>
          <div class="value" style="color:#d97706">${unansweredCount}</div>
        </div>
      </div>
      ${unansweredCount > 0 ? `
        <div style="background:#fffbeb;border-left:3px solid #f59e0b;padding:10px 14px;border-radius:0 6px 6px 0;margin-bottom:16px;font-size:13px">
          未回答の列が${unansweredCount}件あります。未回答の列は「使わない」扱いになります。<br>
          あとから「列の確認を続ける」で変更できます。
        </div>
      ` : `
        <div style="background:#f0fdf4;border-left:3px solid #16a34a;padding:10px 14px;border-radius:0 6px 6px 0;margin-bottom:16px;font-size:13px;color:#15803d">
          すべての列を確認しました。
        </div>
      `}
      ${activeCount > 0 ? `
        <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">
          <button class="btn btn-primary" id="btn-normalize-with-review" style="font-size:14px">
            次に進む（使う列${activeCount}件で処理）
          </button>
          <a href="/runs/${escapeHtml(runId)}/columns" class="btn">
            列の確認を続ける
          </a>
          <div>
            <button class="btn" id="btn-save-candidate-summary"
              onclick="saveCandidateFromRun('${escapeHtml(runId)}', '${escapeHtml(profileId)}')"
            >今の確認内容を保存する</button>
            <div style="font-size:10px;color:var(--text-secondary);margin-top:2px">次回も候補として使えます</div>
          </div>
        </div>
      ` : `
        <div style="display:flex;gap:8px">
          <a href="/runs/${escapeHtml(runId)}/columns" class="btn btn-primary">列の確認を続ける</a>
        </div>
      `}
    </div>
  `;

  document.getElementById('btn-normalize-with-review')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-normalize-with-review');
    btn.disabled = true;
    btn.textContent = '処理中...';
    try {
      const result = await api(\`/api/runs/\${runId}/rerun-with-review\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId }),
      });
      navigate(\`/runs/\${result.id}\`);
    } catch (err) {
      alert('処理に失敗しました: ' + err.message);
      btn.disabled = false;
      btn.textContent = \`次に進む（使う列\${activeCount}件で処理）\`;
    }
  });
}
```

- [ ] **Step 2: 動作確認**

列確認を保存した後:
- 「列の確認結果」が表示されること
- 未回答があれば黄色警告バーが表示されること
- 「次に進む（使う列N件で処理）」ボタンが表示されること
- 「列の確認を続ける」「今の確認内容を保存する」の違いが明確であること

- [ ] **Step 3: コミット**

```bash
git add src/ui/public/app.js
git commit -m "ui(review-summary): clarify button purposes, add unanswered warning"
```

---

### Task 7: app.js — 実行結果画面の日本語化

**Files:**
- Modify: `src/ui/public/app.js:827-1032` (renderRunDetail function)

- [ ] **Step 1: renderRunDetail 内の文言を修正**

以下の文字列置換を行う（すべて `renderRunDetail` 関数内）:

| 行付近 | Before | After |
|--------|--------|-------|
| 857 | `終わりました` | `処理が完了しました` |
| 862 | `Homeに戻る` | `ダッシュボードに戻る` |
| 868 | `実行のくわしい情報` | `くわしい情報` |
| 890 | `source batch数: ${...} / mode: ${...}` | 削除（この行を除去） |
| 893 | `レコード数` | `データ件数` |
| 894 | `カラム数` | `列数` |
| 898 | `mainline追加` | `新規追加` |
| 899 | `mainline更新` | `更新` |
| 900 | `mainline変更なし` | `変更なし` |
| 901 | `mainline重複` | `重複` |
| 902 | `archiveスキップ` 行 | 削除 |
| 930 | `前と後をくらべる` | `元のデータと比較` |
| 1242 | `Before（元データ）` | `元のデータ` |
| 1249 | `After（正規化後）` | `変換後のデータ` |

- [ ] **Step 2: 列の確認状況カードのボタンラベルを修正**

`loadColumnStatusCard` 関数（1036行目付近）内:

Before:
```javascript
          <a href="/runs/${escapeHtml(runId)}/columns" class="btn btn-primary">列の確認を再開</a>
```
After:
```javascript
          <a href="/runs/${escapeHtml(runId)}/columns" class="btn btn-primary">列の確認を続ける</a>
```

Before:
```javascript
          >この設定を保存</button>
```
After:
```javascript
          >今の確認内容を保存する</button>
```

「まだ決まっていない列」→「未回答」に変更:
Before:
```javascript
          <div class="stat"><div class="label">まだ決まっていない列</div><div class="value">${entry.pendingCount}</div></div>
```
After:
```javascript
          <div class="stat"><div class="label">未回答</div><div class="value">${entry.pendingCount}</div></div>
```

- [ ] **Step 3: 動作確認**

ブラウザで `/runs/{id}` を開き:
- 「mainline」「archive」という単語が画面に表示されていないこと
- 統計ラベルがすべて日本語であること
- ボタンラベルが更新されていること

- [ ] **Step 4: コミット**

```bash
git add src/ui/public/app.js
git commit -m "ui(run-detail): replace English/internal terms with Japanese labels"
```

---

### Task 8: app.js — confirm ページ・import ページの文言修正

**Files:**
- Modify: `src/ui/public/app.js` (renderConfirmPage, import page functions)

- [ ] **Step 1: confirm ページの文言修正**

`renderConfirmPage` 関数内の以下を修正:

`alert('Preview 失敗:')` → `alert('プレビューに失敗しました:')` （もし残っていれば）

- [ ] **Step 2: import ページの英語混じり文言を確認**

`renderImportPage` と関連関数を確認し、残っている英語やわかりにくい表現を修正。
（import ページはすでにほぼ日本語化されているが、`STEP` ラベルの英大文字等を確認）

- [ ] **Step 3: コミット**

```bash
git add src/ui/public/app.js
git commit -m "ui: minor Japanese wording fixes in confirm and import pages"
```

---

### Task 9: ビルド確認と最終検証

**Files:**
- All modified files

- [ ] **Step 1: TypeScript ビルド確認**

Run: `npx tsc --noEmit`
Expected: 既存のエラーが増えていないこと

- [ ] **Step 2: lint 確認（設定があれば）**

Run: `npm run lint` (または `npx eslint src/`)
Expected: 新しいエラーが出ていないこと

- [ ] **Step 3: 全画面の目視確認**

以下の URL をすべて確認:
1. `http://localhost:24242/` — ダッシュボード
2. `http://localhost:24242/new` — 新しく読み込む
3. `http://localhost:24242/runs/{id}/columns` — 列の確認
4. `http://localhost:24242/runs/{id}` — 実行結果

各画面で:
- 英語ラベルが残っていないか
- レイアウトが崩れていないか
- ボタンが正しく動作するか
- レスポンシブ（768px以下）で崩れないか

- [ ] **Step 4: 最終コミット（必要に応じて）**

修正が必要な箇所があれば修正してコミット。
