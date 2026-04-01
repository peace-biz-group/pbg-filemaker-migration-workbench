# Pre-Run Diff Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** confirm 画面で「前回との比較」を軽量に見せ、現場が実行前に「前回とほぼ同じか / 件数が変わったか / 列が変わりそうか」を把握できるようにする。

**Architecture:** 新規 `src/core/pre-run-diff.ts` でコアロジックを持ち、`/api/upload-identify` レスポンスに `sourceFileHash`/`schemaFingerprint` を追加、新規 `GET /api/pre-run-preview` エンドポイントで `PreRunDiffPreview` を返す。フロントの confirm 画面がこれを取得して小カードを表示する。全件 row diff は行わない。

**Tech Stack:** TypeScript (Node.js), Express, vanilla JS (app.js), vitest

---

## ファイル構成

| ファイル | 操作 | 役割 |
|---------|------|------|
| `src/core/pre-run-diff.ts` | 新規作成 | `PreRunDiffPreview` 型、`buildPreRunDiffPreview()`、分類ロジック |
| `src/ui/server.ts` | 修正 | `/api/upload-identify` レスポンス拡張、`GET /api/pre-run-preview` 追加 |
| `src/ui/public/app.js` | 修正 | confirm 画面に pre-run preview カード追加 |
| `test/core/pre-run-diff.test.ts` | 新規作成 | コアロジックのテスト |

---

## Task 1: 型定義とコアロジック — `src/core/pre-run-diff.ts`

**Files:**
- Create: `src/core/pre-run-diff.ts`

- [ ] **Step 1: テストファイルを先に作成（failing）**

`test/core/pre-run-diff.test.ts` を作成:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildPreRunDiffPreview } from '../../src/core/pre-run-diff.js';
import { executeRun } from '../../src/core/pipeline-runner.js';
import { loadConfig } from '../../src/config/defaults.js';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

const OUTPUT = join(import.meta.dirname, '..', 'output-pre-run-diff-test');
const F = join(import.meta.dirname, '..', 'fixtures');

describe('buildPreRunDiffPreview', () => {
  let config: ReturnType<typeof loadConfig>;

  beforeAll(() => {
    config = loadConfig();
    config.outputDir = OUTPUT;
    mkdirSync(OUTPUT, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(OUTPUT)) rmSync(OUTPUT, { recursive: true, force: true });
  });

  it('comparable run がない場合は first_import を返す', () => {
    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'never_seen_file_xyz.csv',
      columnCount: 5,
    });
    expect(result.classification).toBe('first_import');
    expect(result.classificationLabel).toBe('初めての取り込みです');
    expect(result.previousRunId).toBeNull();
    expect(result.fastPathRecommended).toBe(false);
    expect(result.columnReviewRecommended).toBe(false);
  });

  it('同じ sourceFileHash の run がある場合は same_file を返す', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('run-all', [file], config);
    expect(r1.status).toBe('completed');

    // r1 の sourceFileHash を使って pre-run preview を構築
    const hash = Object.values(r1.sourceFileHashes ?? {})[0]!;
    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: hash,
      columnCount: r1.summary?.columnCount ?? 1,
    });
    expect(result.classification).toBe('same_file');
    expect(result.classificationLabel).toBe('前回とほぼ同じです');
    expect(result.previousRunId).toBe(r1.id);
    expect(result.sameRawFingerprint).toBe(true);
    expect(result.fastPathRecommended).toBe(false); // profileId なしなので
  });

  it('profileId が一致する場合 fastPathRecommended=true になる', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('run-all', [file], config, undefined, { profileId: 'test-profile-fp' });
    const hash = Object.values(r1.sourceFileHashes ?? {})[0]!;

    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: hash,
      columnCount: r1.summary?.columnCount ?? 1,
      profileId: 'test-profile-fp',
    });
    expect(result.classification).toBe('same_file');
    expect(result.fastPathRecommended).toBe(true);
  });

  it('列数が変わっていると column_changed を返す', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('run-all', [file], config);
    expect(r1.status).toBe('completed');
    const prevCols = r1.summary?.columnCount ?? 1;

    // 列数を変えて preview を構築（sourceFileHash 不一致を模擬）
    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: 'different-hash-does-not-match',
      columnCount: prevCols + 3, // 列数が増えた
    });
    expect(result.classification).toBe('column_changed');
    expect(result.classificationLabel).toBe('列の形が変わっています');
    expect(result.columnReviewRecommended).toBe(true);
    expect(result.columnCountDelta).toBe(3);
  });

  it('built-in / candidate の両方で壊れない', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('run-all', [file], config, undefined, { profileId: 'candidate-profile-001' });
    const hash = Object.values(r1.sourceFileHashes ?? {})[0]!;

    // built-in profile id
    const resultBuiltIn = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: hash,
      columnCount: r1.summary?.columnCount ?? 1,
      profileId: 'some-builtin-profile',
    });
    // logicalSourceKey 一致するので comparable は見つかる
    expect(resultBuiltIn.previousRunId).not.toBeNull();

    // candidate profile id（r1 の profileId と一致）
    const resultCandidate = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: hash,
      columnCount: r1.summary?.columnCount ?? 1,
      profileId: 'candidate-profile-001',
    });
    expect(resultCandidate.previousRunId).toBe(r1.id);
  });

  it('confirm 向け API shape が安定して返る（必須フィールド）', () => {
    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'test.csv',
      columnCount: 3,
    });
    expect(result.version).toBe(1);
    expect(result).toHaveProperty('previousRunId');
    expect(result).toHaveProperty('profileId');
    expect(result).toHaveProperty('sameRawFingerprint');
    expect(result).toHaveProperty('sameSchemaFingerprint');
    expect(result).toHaveProperty('columnCountCurr');
    expect(result).toHaveProperty('classification');
    expect(result).toHaveProperty('classificationLabel');
    expect(result).toHaveProperty('fastPathRecommended');
    expect(result).toHaveProperty('columnReviewRecommended');
  });
});
```

- [ ] **Step 2: テストを実行して failing を確認**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx vitest run test/core/pre-run-diff.test.ts 2>&1 | head -40
```

Expected: FAIL — `buildPreRunDiffPreview` が存在しない

- [ ] **Step 3: コアロジックの実装**

`src/core/pre-run-diff.ts` を作成:

```typescript
/**
 * Pre-Run Diff Preview
 *
 * 実行前（confirm 段階）に取れる metadata だけで、
 * 直近の comparable run との軽量比較を行う。
 * 全件 row diff は行わない。
 */

import { basename } from 'node:path';
import type { RunMeta } from './pipeline-runner.js';
import { listRuns } from './pipeline-runner.js';
import { logicalSourceKey } from '../ingest/fingerprint.js';

export type PreRunClassification =
  | 'same_file'       // 前回とほぼ同じです
  | 'row_changed'     // 件数が変わっています
  | 'column_changed'  // 列の形が変わっています
  | 'first_import'    // 初めての取り込みです
  | 'no_comparable';  // 比較対象なし（ファイル名ヒントなし等）

export interface PreRunDiffPreview {
  version: 1;
  /** 比較対象 run の ID。比較対象なし / 初回の場合は null */
  previousRunId: string | null;
  /** 今回候補の profileId */
  profileId: string | null;
  /** 同じ raw ファイルか（sourceFileHash の一致）。不明なら null */
  sameRawFingerprint: boolean | null;
  /** 同じスキーマか（schemaFingerprint の一致）。不明なら null */
  sameSchemaFingerprint: boolean | null;
  /** 前回の列数（前回 run の summary.columnCount）。不明なら null */
  columnCountPrev: number | null;
  /** 今回の列数 */
  columnCountCurr: number;
  /** 列数の差。不明なら null */
  columnCountDelta: number | null;
  /** 前回の行数（前回 run の summary.recordCount）。不明なら null */
  rowCountPrev: number | null;
  /** 前回のヘッダー有無。不明なら null */
  hasHeaderPrev: boolean | null;
  /** 今回のヘッダー有無。不明なら null */
  hasHeaderCurr: boolean | null;
  /** 分類（内部用） */
  classification: PreRunClassification;
  /** 現場向け日本語ラベル */
  classificationLabel: string;
  /** fast path を推奨するか（same_file + profileId 一致） */
  fastPathRecommended: boolean;
  /** 列確認を推奨するか（column_changed の場合） */
  columnReviewRecommended: boolean;
}

/** buildPreRunDiffPreview に渡す入力 */
export interface PreRunInput {
  /** アップロードされたファイルの basename（ファイル名） */
  filename: string;
  /** ingest 後に得られる raw ファイルハッシュ（任意） */
  sourceFileHash?: string;
  /** ingest 後に得られるスキーマフィンガープリント（任意） */
  schemaFingerprint?: string;
  /** 実際に検出された列数 */
  columnCount: number;
  /** ヘッダー有無（任意） */
  hasHeader?: boolean;
  /** matchProfile で候補として選ばれた profileId（任意） */
  profileId?: string;
}

const CLASSIFICATION_LABELS: Record<PreRunClassification, string> = {
  same_file: '前回とほぼ同じです',
  row_changed: '件数が変わっています',
  column_changed: '列の形が変わっています',
  first_import: '初めての取り込みです',
  no_comparable: '比較対象なし',
};

function classifyPreRun(opts: {
  hasPrevRun: boolean;
  sameRawFingerprint: boolean | null;
  sameSchemaFingerprint: boolean | null;
  columnDelta: number | null;
}): PreRunClassification {
  if (!opts.hasPrevRun) return 'first_import';
  if (opts.sameRawFingerprint === true) return 'same_file';
  // 列数の差が明確にあるか、schema fingerprint が異なれば column_changed
  if (opts.columnDelta !== null && opts.columnDelta !== 0) return 'column_changed';
  if (opts.sameSchemaFingerprint === false) return 'column_changed';
  // raw が違い schema は同じ（または不明）→ 件数変化と判断
  return 'row_changed';
}

/**
 * 実行前（confirm 段階）に comparable run を探し、PreRunDiffPreview を生成する。
 * comparable run が見つからない場合は first_import を返す。
 */
export function buildPreRunDiffPreview(
  outputDir: string,
  input: PreRunInput,
): PreRunDiffPreview {
  const lsk = logicalSourceKey([basename(input.filename)]);
  const pid = input.profileId ?? null;

  // logicalSourceKey でフィルタリングして comparable run を検索
  const allCompleted = listRuns(outputDir).filter(
    r => r.status === 'completed' && r.logicalSourceKey === lsk,
  );

  // profileId が一致するものを優先、なければ最新
  let prevRun: RunMeta | null = null;
  if (pid && allCompleted.length > 0) {
    prevRun =
      allCompleted.find(r => (r.profileId ?? r.fastPathProfileId) === pid) ??
      allCompleted[0] ??
      null;
  } else {
    prevRun = allCompleted[0] ?? null;
  }

  // comparable run なし → first_import
  if (!prevRun) {
    return {
      version: 1,
      previousRunId: null,
      profileId: pid,
      sameRawFingerprint: null,
      sameSchemaFingerprint: null,
      columnCountPrev: null,
      columnCountCurr: input.columnCount,
      columnCountDelta: null,
      rowCountPrev: null,
      hasHeaderPrev: null,
      hasHeaderCurr: input.hasHeader ?? null,
      classification: 'first_import',
      classificationLabel: CLASSIFICATION_LABELS['first_import'],
      fastPathRecommended: false,
      columnReviewRecommended: false,
    };
  }

  // raw fingerprint 比較（sourceFileHash が渡された場合のみ）
  let sameRawFingerprint: boolean | null = null;
  if (input.sourceFileHash && prevRun.sourceFileHashes) {
    const prevHashes = Object.values(prevRun.sourceFileHashes);
    sameRawFingerprint = prevHashes.includes(input.sourceFileHash);
  }

  // schema fingerprint 比較（schemaFingerprint が渡された場合のみ）
  let sameSchemaFingerprint: boolean | null = null;
  if (input.schemaFingerprint && prevRun.schemaFingerprints) {
    const prevSchemas = Object.values(prevRun.schemaFingerprints);
    sameSchemaFingerprint = prevSchemas.includes(input.schemaFingerprint);
  }

  // 列数比較
  const columnCountPrev = prevRun.summary?.columnCount ?? null;
  const columnCountDelta =
    columnCountPrev !== null ? input.columnCount - columnCountPrev : null;

  // 行数（前回の実績値）
  const rowCountPrev = prevRun.summary?.recordCount ?? null;

  // ヘッダー有無（前回 run の ingestDiagnoses から取得）
  const prevDiags = prevRun.ingestDiagnoses ?? {};
  const firstPrevDiag = Object.values(prevDiags)[0];
  const hasHeaderPrev = firstPrevDiag?.headerApplied ?? null;

  const classification = classifyPreRun({
    hasPrevRun: true,
    sameRawFingerprint,
    sameSchemaFingerprint,
    columnDelta: columnCountDelta,
  });

  // fast path 推奨: 同じファイルかつ profileId 一致
  const fastPathRecommended = classification === 'same_file' && pid !== null;

  // 列確認推奨: 列の形が変わっている
  const columnReviewRecommended = classification === 'column_changed';

  return {
    version: 1,
    previousRunId: prevRun.id,
    profileId: pid,
    sameRawFingerprint,
    sameSchemaFingerprint,
    columnCountPrev,
    columnCountCurr: input.columnCount,
    columnCountDelta,
    rowCountPrev,
    hasHeaderPrev,
    hasHeaderCurr: input.hasHeader ?? null,
    classification,
    classificationLabel: CLASSIFICATION_LABELS[classification],
    fastPathRecommended,
    columnReviewRecommended,
  };
}
```

- [ ] **Step 4: テスト実行して pass を確認**

```bash
npx vitest run test/core/pre-run-diff.test.ts 2>&1 | tail -30
```

Expected: すべての describe ブロックが PASS

- [ ] **Step 5: commit**

```bash
git add src/core/pre-run-diff.ts test/core/pre-run-diff.test.ts
git commit -m "feat: add pre-run diff preview core logic and tests"
```

---

## Task 2: サーバー拡張 — `src/ui/server.ts`

**Files:**
- Modify: `src/ui/server.ts`

- [ ] **Step 1: `/api/upload-identify` レスポンスに `sourceFileHash`/`schemaFingerprint` を追加**

`server.ts` の `/api/upload-identify` ハンドラ内、`res.json({...})` 部分を修正。現在の `ir.sourceFileHash` と `ir.schemaFingerprint` はすでに取得済みなので、レスポンスに追加するだけ。

変更前 (server.ts:479-491):
```typescript
      res.json({
        filename: uploaded.originalname,
        filePath: dest,
        diagnosis: {
          detectedEncoding: ir.diagnosis.format === 'csv' ? ir.diagnosis.detectedEncoding : 'xlsx',
          appliedEncoding: ir.diagnosis.format === 'csv' ? ir.diagnosis.appliedEncoding : 'xlsx',
          headerApplied: ir.diagnosis.headerApplied,
          format: ir.diagnosis.format,
        },
        previewRows: sampleRows,
        columns: ir.columns,
        profileMatch,
      });
```

変更後:
```typescript
      res.json({
        filename: uploaded.originalname,
        filePath: dest,
        diagnosis: {
          detectedEncoding: ir.diagnosis.format === 'csv' ? ir.diagnosis.detectedEncoding : 'xlsx',
          appliedEncoding: ir.diagnosis.format === 'csv' ? ir.diagnosis.appliedEncoding : 'xlsx',
          headerApplied: ir.diagnosis.headerApplied,
          format: ir.diagnosis.format,
        },
        previewRows: sampleRows,
        columns: ir.columns,
        profileMatch,
        sourceFileHash: ir.sourceFileHash,
        schemaFingerprint: ir.schemaFingerprint,
      });
```

- [ ] **Step 2: `GET /api/pre-run-preview` エンドポイントを追加**

`buildPreRunDiffPreview` を import し、エンドポイントを追加。位置はファイル末尾近くの `/api/configs` の手前あたりが自然。

まず import 追加（server.ts 先頭の import ブロックへ）:
```typescript
import { buildPreRunDiffPreview } from '../core/pre-run-diff.js';
```

エンドポイント:
```typescript
  // --- API: Pre-run diff preview (confirm 段階で実行前に比較) ---
  app.get('/api/pre-run-preview', (req, res) => {
    const filename = String(req.query.filename ?? '');
    if (!filename) {
      return res.status(400).json({ error: 'filename は必須です' });
    }
    const profileId = req.query.profileId ? String(req.query.profileId) : undefined;
    const sourceFileHash = req.query.sourceFileHash ? String(req.query.sourceFileHash) : undefined;
    const schemaFingerprint = req.query.schemaFingerprint ? String(req.query.schemaFingerprint) : undefined;
    const columnCount = req.query.columnCount ? parseInt(String(req.query.columnCount), 10) : 0;
    const hasHeader = req.query.hasHeader !== undefined ? req.query.hasHeader !== 'false' : undefined;

    const preview = buildPreRunDiffPreview(baseOutputDir, {
      filename,
      sourceFileHash,
      schemaFingerprint,
      columnCount,
      hasHeader,
      profileId,
    });
    res.json(preview);
  });
```

- [ ] **Step 3: TypeScript コンパイルエラーがないか確認**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx tsc --noEmit 2>&1 | grep -v "node_modules" | head -40
```

Expected: 今回触った範囲で新しいエラーが出ていないこと（既存エラーは無視）

- [ ] **Step 4: commit**

```bash
git add src/ui/server.ts src/core/pre-run-diff.ts
git commit -m "feat: add GET /api/pre-run-preview endpoint and extend upload-identify response"
```

---

## Task 3: フロントエンド — confirm 画面に前回比較カードを追加

**Files:**
- Modify: `src/ui/public/app.js`

- [ ] **Step 1: `renderPreRunPreviewCard()` ヘルパー関数を追加**

`app.js` の `renderConfirmPage` 関数の手前（例えば `// --- Confirm Page` コメントの直前）に追加:

```javascript
// --- Pre-run diff preview card ---

function renderPreRunPreviewCard(preview) {
  if (!preview) return '';

  const cls = preview.classification;
  const label = preview.classificationLabel || '';

  // アイコンと色の決定
  let icon = '○';
  let color = 'var(--text-secondary)';
  let bgColor = 'var(--surface)';
  if (cls === 'same_file') {
    icon = '✓';
    color = 'var(--success,#16a34a)';
    bgColor = '#dcfce7';
  } else if (cls === 'first_import') {
    icon = '★';
    color = '#6366f1';
    bgColor = '#ede9fe';
  } else if (cls === 'column_changed') {
    icon = '!';
    color = '#d97706';
    bgColor = '#fef3c7';
  } else if (cls === 'row_changed') {
    icon = '↑';
    color = '#2563eb';
    bgColor = '#dbeafe';
  }

  // 件数・列数の差分表示
  let detailLines = '';
  if (preview.previousRunId) {
    if (preview.rowCountPrev !== null) {
      detailLines += `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px">前回の件数: <strong>${preview.rowCountPrev.toLocaleString('ja-JP')}件</strong></div>`;
    }
    if (preview.columnCountDelta !== null && preview.columnCountDelta !== 0) {
      const sign = preview.columnCountDelta > 0 ? '+' : '';
      detailLines += `<div style="font-size:12px;color:${color};margin-top:2px">列数の変化: <strong>${sign}${preview.columnCountDelta}列</strong>（前回 ${preview.columnCountPrev ?? '?'}列 → 今回 ${preview.columnCountCurr}列）</div>`;
    } else if (preview.columnCountPrev !== null) {
      detailLines += `<div style="font-size:12px;color:var(--text-secondary);margin-top:2px">列数: <strong>${preview.columnCountCurr}列</strong>（前回と同じ）</div>`;
    }
  }

  // 推奨メッセージ
  let recommendHtml = '';
  if (preview.columnReviewRecommended) {
    recommendHtml = `<div style="margin-top:6px;font-size:12px;color:#d97706;font-weight:600">列の確認をおすすめします</div>`;
  } else if (preview.fastPathRecommended) {
    recommendHtml = `<div style="margin-top:6px;font-size:12px;color:var(--success,#16a34a)">「このまま進む」が使えます</div>`;
  }

  return `
    <div class="card" style="background:${bgColor};border:1px solid ${color};margin-top:0;padding:12px 16px" id="pre-run-preview-card">
      <div style="font-size:13px;font-weight:600;color:${color}">${icon} ${escapeHtml(label)}</div>
      ${detailLines}
      ${recommendHtml}
    </div>
  `;
}
```

- [ ] **Step 2: `renderConfirmPage()` 内で pre-run preview を非同期取得して差し込む**

`renderConfirmPage()` 関数内、`app.innerHTML = html;` の直後（行1389付近）に以下を追加:

```javascript
  // Pre-run preview を非同期で取得してカードを差し込む
  const preRunCardContainer = document.createElement('div');
  preRunCardContainer.id = 'pre-run-preview-container';
  // ヘッダーチェックカードの手前に挿入
  const headerCard = app.querySelector('.card:nth-child(3)') || app.lastElementChild;
  if (headerCard) {
    app.insertBefore(preRunCardContainer, headerCard);
  } else {
    app.appendChild(preRunCardContainer);
  }

  // fetch pre-run preview
  (async () => {
    try {
      const params = new URLSearchParams({
        filename: data.filename || '',
        columnCount: String((data.columns || []).length),
      });
      if (data.sourceFileHash) params.set('sourceFileHash', data.sourceFileHash);
      if (data.schemaFingerprint) params.set('schemaFingerprint', data.schemaFingerprint);
      if (pm.profile?.id) params.set('profileId', pm.profile.id);
      if (diag.headerApplied !== undefined) {
        params.set('hasHeader', diag.headerApplied ? 'true' : 'false');
      }

      const preview = await api(`/api/pre-run-preview?${params.toString()}`);
      const container = document.getElementById('pre-run-preview-container');
      if (container) {
        container.outerHTML = renderPreRunPreviewCard(preview);
      }
    } catch {
      // 取得失敗は無視（confirm フローを止めない）
    }
  })();
```

- [ ] **Step 3: fast path カードとの整合を確認**

`isFastPathEligible` の評価ロジックはそのままにする。pre-run preview の `fastPathRecommended` は参考情報として表示するだけで、fast path の表示条件を変えない（`pm.confidence === 'high'` が既存条件）。

ただし、`columnReviewRecommended === true` のとき、fast path カードの説明文に注意書きを加える。
fast path ボタンが存在する場合、カード内に以下を追加（`id="fast-path-btn"` ボタンの手前のテキスト部分）:

変更前の fast path カード HTML テンプレート（行1367-1379）:
```javascript
    html += `
      <div class="card" style="background:var(--bg-secondary,#f8f9fa);border:1px solid var(--success,#16a34a);margin-top:8px">
        <p style="font-size:14px;font-weight:600;color:var(--success,#16a34a);margin-bottom:4px">前に保存した設定で進めます</p>
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">
          「${escapeHtml(pm.profile.label)}」の設定をそのまま使います。心配な場合は「列を確認する」を選んでください。
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" id="fast-path-btn">このまま進む</button>
          <button class="btn" id="confirm-proceed-btn">列を確認する</button>
          <a href="/new" class="btn">戻る</a>
        </div>
      </div>
    `;
```

このコードは変えない。pre-run preview カードが「列の確認をおすすめします」と表示するだけで十分。

- [ ] **Step 4: 手動動作確認チェックリスト（実際にはコードレビューで確認）**

以下の点を確認:
- confirm ページが `pre-run-preview-container` div を含む
- `/api/pre-run-preview` が呼ばれる（Network タブ）
- `first_import` のときは「初めての取り込みです」が表示される
- `same_file` のときは「前回とほぼ同じです」が緑で表示される
- `column_changed` のときは「列の確認をおすすめします」が表示される
- カード取得失敗でも confirm フローが止まらない

- [ ] **Step 5: commit**

```bash
git add src/ui/public/app.js
git commit -m "feat: show pre-run diff preview card on confirm page"
```

---

## Task 4: 最終確認 — build / lint / typecheck / test

**Files:**
- なし（確認のみ）

- [ ] **Step 1: 全テスト実行**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx vitest run 2>&1 | tail -50
```

Expected: 今回追加したテストが PASS、既存テストが壊れていないこと

- [ ] **Step 2: TypeScript 型チェック**

```bash
npx tsc --noEmit 2>&1 | grep -v "node_modules" | head -60
```

Expected: 今回触った範囲（`pre-run-diff.ts`, `server.ts`）に新しいエラーがないこと

- [ ] **Step 3: 既存エラーと今回の差分を確認**

```bash
npx tsc --noEmit 2>&1 | grep -v "node_modules" | grep -E "(pre-run-diff|server\.ts)" | head -20
```

今回の変更に起因するエラーがないことを確認。

- [ ] **Step 4: lint（あれば）**

```bash
npm run lint 2>&1 | grep -E "(pre-run-diff|server\.ts|app\.js)" | head -20
```

- [ ] **Step 5: 最終 commit**

全テスト / 型チェックが問題なければ最終 commit:

```bash
git add -p  # 未 commit のものがあれば
git status
```

---

## Self-Review

### Spec coverage チェック

| 要件 | タスク |
|-----|--------|
| pre-run comparable lookup（profileId / logicalSourceKey / known/candidate 両対応） | Task 1: `buildPreRunDiffPreview()` |
| pre-run diff preview（previousRunId, profileId, sameRawFingerprint, rowCount, columnCount, hasHeader, sameSchema） | Task 1: `PreRunDiffPreview` 型 |
| pre-run classification（前回とほぼ同じ / 件数変化 / 列変化 / 初回）| Task 1: `classifyPreRun()` |
| confirm 画面での可視化（カード、日本語ラベル、行列差、推奨メッセージ） | Task 3 |
| fast path との整合（fastPathRecommended / columnReviewRecommended） | Task 1 + Task 3 |
| テスト（comparable 有無、同一ファイル、列数変化、built-in/candidate、API shape） | Task 1 |
| `/api/upload-identify` に sourceFileHash/schemaFingerprint を含める | Task 2 |
| 新規 `GET /api/pre-run-preview` エンドポイント | Task 2 |

### Placeholder scan

- なし

### Type consistency

- `PreRunInput.filename` → `basename(input.filename)` で logicalSourceKey 計算 ✓
- `PreRunDiffPreview.version: 1` は固定 ✓
- `classification: PreRunClassification` と `CLASSIFICATION_LABELS` のキーが一致 ✓
- `RunMeta.sourceFileHashes` / `schemaFingerprints` / `summary?.columnCount` / `summary?.recordCount` は既存 RunMeta 型と一致 ✓
- `ingestDiagnoses[key].headerApplied` は `IngestDiagnosis` の `headerApplied: boolean` と一致 ✓
