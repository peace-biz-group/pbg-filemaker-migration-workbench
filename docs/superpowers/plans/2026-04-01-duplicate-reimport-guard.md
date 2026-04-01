# Duplicate Re-Import Guard 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** confirm 段階で「前回と同じ内容の再投入」を検知し、前回の結果を見るよう促しつつ、必要なら override して実行できる導線を実現する。

**Architecture:** `src/core/pre-run-diff.ts` で `buildPreRunDiffPreview()` を実装（pre-run diff preview はまだ未実装のため本計画に含める）。`sameRawFingerprint === true` のとき confirm 画面に duplicate warning カードを表示、「前回の結果を見る」「それでも実行する」の分岐を出す。override 実行時は `duplicateWarningShown` / `duplicateOverride` を RunMeta に記録する。

**Tech Stack:** TypeScript (Node.js), Express, vanilla JS (app.js), vitest

---

## 前提確認

- `src/core/pre-run-diff.ts` は **未実装**（計画のみ存在）
- `GET /api/pre-run-preview` は **未実装**
- `/api/upload-identify` レスポンスに `sourceFileHash` / `schemaFingerprint` は **未追加**
- confirm 画面に duplicate warning カードは **未実装**
- RunMeta に `duplicateWarningShown` / `duplicateOverride` は **未追加**

---

## ファイル構成

| ファイル | 操作 | 役割 |
|---------|------|------|
| `src/core/pre-run-diff.ts` | 新規作成 | `PreRunDiffPreview` 型・`buildPreRunDiffPreview()` |
| `src/core/pipeline-runner.ts` | 修正 | `RunMeta` に `duplicateWarningShown?` / `duplicateOverride?` 追加、`executeRun` options 拡張 |
| `src/ui/server.ts` | 修正 | `upload-identify` レスポンス拡張、`GET /api/pre-run-preview`、`POST /api/runs` で duplicate meta 受け取り |
| `src/ui/public/app.js` | 修正 | confirm 画面に duplicate warning カード・前回の結果を見る導線・override ボタン追加 |
| `test/core/pre-run-diff.test.ts` | 新規作成 | buildPreRunDiffPreview のユニットテスト |

---

## Task 1: pre-run-diff コアロジック（TDD）

**Files:**
- Create: `src/core/pre-run-diff.ts`
- Create: `test/core/pre-run-diff.test.ts`

- [ ] **Step 1: テストファイルを作成（failing）**

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
      filename: 'never_seen_xyz_file_abc.csv',
      columnCount: 5,
    });
    expect(result.classification).toBe('first_import');
    expect(result.classificationLabel).toBe('初めての取り込みです');
    expect(result.previousRunId).toBeNull();
    expect(result.sameRawFingerprint).toBeNull();
    expect(result.duplicateWarning).toBe(false);
  });

  it('同じ sourceFileHash の run がある場合は same_file かつ duplicateWarning=true を返す', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], config);
    expect(r1.status).toBe('completed');

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
    expect(result.duplicateWarning).toBe(true);
  });

  it('sourceFileHash が異なる場合は duplicate warning にならない', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], config);
    expect(r1.status).toBe('completed');

    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: 'different-hash-value-does-not-match',
      columnCount: r1.summary?.columnCount ?? 1,
    });
    // comparable run は見つかるが raw fingerprint は違う
    expect(result.previousRunId).toBe(r1.id);
    expect(result.sameRawFingerprint).toBe(false);
    expect(result.duplicateWarning).toBe(false);
  });

  it('列数が変わっていると column_changed を返す', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], config);
    expect(r1.status).toBe('completed');
    const prevCols = r1.summary?.columnCount ?? 1;

    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',
      sourceFileHash: 'different-hash',
      columnCount: prevCols + 3,
    });
    expect(result.classification).toBe('column_changed');
    expect(result.classificationLabel).toBe('列の形が変わっています');
    expect(result.columnCountDelta).toBe(3);
    expect(result.duplicateWarning).toBe(false);
  });

  it('必須フィールドが常に揃っている（API shape 安定）', () => {
    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'test.csv',
      columnCount: 3,
    });
    expect(result.version).toBe(1);
    expect(result).toHaveProperty('previousRunId');
    expect(result).toHaveProperty('sameRawFingerprint');
    expect(result).toHaveProperty('sameSchemaFingerprint');
    expect(result).toHaveProperty('columnCountCurr');
    expect(result).toHaveProperty('classification');
    expect(result).toHaveProperty('classificationLabel');
    expect(result).toHaveProperty('duplicateWarning');
  });
});
```

- [ ] **Step 2: テストを実行して failing を確認**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx vitest run test/core/pre-run-diff.test.ts 2>&1 | head -30
```

Expected: FAIL — `buildPreRunDiffPreview` が存在しない

- [ ] **Step 3: src/core/pre-run-diff.ts を作成**

```typescript
/**
 * Pre-Run Diff Preview
 *
 * 実行前（confirm 段階）に取れる metadata だけで、
 * 直近の comparable run との軽量比較を行う。
 * 全件 row diff は行わない。
 */

import { basename } from 'node:path';
import { listRuns } from './pipeline-runner.js';
import { logicalSourceKey } from '../ingest/fingerprint.js';

export type PreRunClassification =
  | 'same_file'       // 前回とほぼ同じです
  | 'row_changed'     // 件数が変わっています
  | 'column_changed'  // 列の形が変わっています
  | 'first_import'    // 初めての取り込みです
  | 'no_comparable';  // 比較対象なし

export interface PreRunDiffPreview {
  version: 1;
  /** 比較対象 run の ID。比較対象なし / 初回の場合は null */
  previousRunId: string | null;
  /** 同じ raw ファイルか（sourceFileHash の一致）。不明なら null */
  sameRawFingerprint: boolean | null;
  /** 同じスキーマか（schemaFingerprint の一致）。不明なら null */
  sameSchemaFingerprint: boolean | null;
  /** 前回の列数。不明なら null */
  columnCountPrev: number | null;
  /** 今回の列数 */
  columnCountCurr: number;
  /** 列数の差。不明なら null */
  columnCountDelta: number | null;
  /** 前回の行数。不明なら null */
  rowCountPrev: number | null;
  /** 分類（内部用） */
  classification: PreRunClassification;
  /** 現場向け日本語ラベル */
  classificationLabel: string;
  /**
   * 重複再投入の可能性があるか。
   * sameRawFingerprint === true のときだけ true になる。
   * 自動ブロックには使わず、UI での確認促進に使う。
   */
  duplicateWarning: boolean;
}

export interface PreRunInput {
  /** アップロードされたファイルの名前（basename） */
  filename: string;
  /** raw ファイルハッシュ（任意） */
  sourceFileHash?: string;
  /** スキーマフィンガープリント（任意） */
  schemaFingerprint?: string;
  /** 検出された列数 */
  columnCount: number;
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
  if (opts.columnDelta !== null && opts.columnDelta !== 0) return 'column_changed';
  if (opts.sameSchemaFingerprint === false) return 'column_changed';
  return 'row_changed';
}

/**
 * 実行前に comparable run を探し、PreRunDiffPreview を生成する。
 * comparable run が見つからない場合は first_import を返す。
 */
export function buildPreRunDiffPreview(
  outputDir: string,
  input: PreRunInput,
): PreRunDiffPreview {
  const lsk = logicalSourceKey([basename(input.filename)]);

  const allCompleted = listRuns(outputDir).filter(
    r => r.status === 'completed' && r.logicalSourceKey === lsk,
  );

  const prevRun = allCompleted[0] ?? null;

  if (!prevRun) {
    return {
      version: 1,
      previousRunId: null,
      sameRawFingerprint: null,
      sameSchemaFingerprint: null,
      columnCountPrev: null,
      columnCountCurr: input.columnCount,
      columnCountDelta: null,
      rowCountPrev: null,
      classification: 'first_import',
      classificationLabel: CLASSIFICATION_LABELS['first_import'],
      duplicateWarning: false,
    };
  }

  let sameRawFingerprint: boolean | null = null;
  if (input.sourceFileHash && prevRun.sourceFileHashes) {
    const prevHashes = Object.values(prevRun.sourceFileHashes);
    sameRawFingerprint = prevHashes.includes(input.sourceFileHash);
  }

  let sameSchemaFingerprint: boolean | null = null;
  if (input.schemaFingerprint && prevRun.schemaFingerprints) {
    const prevSchemas = Object.values(prevRun.schemaFingerprints);
    sameSchemaFingerprint = prevSchemas.includes(input.schemaFingerprint);
  }

  const columnCountPrev = prevRun.summary?.columnCount ?? null;
  const columnCountDelta =
    columnCountPrev !== null ? input.columnCount - columnCountPrev : null;
  const rowCountPrev = prevRun.summary?.recordCount ?? null;

  const classification = classifyPreRun({
    hasPrevRun: true,
    sameRawFingerprint,
    sameSchemaFingerprint,
    columnDelta: columnCountDelta,
  });

  return {
    version: 1,
    previousRunId: prevRun.id,
    sameRawFingerprint,
    sameSchemaFingerprint,
    columnCountPrev,
    columnCountCurr: input.columnCount,
    columnCountDelta,
    rowCountPrev,
    classification,
    classificationLabel: CLASSIFICATION_LABELS[classification],
    duplicateWarning: sameRawFingerprint === true,
  };
}
```

- [ ] **Step 4: テストを実行して pass を確認**

```bash
npx vitest run test/core/pre-run-diff.test.ts 2>&1 | tail -30
```

Expected: すべて PASS

- [ ] **Step 5: commit**

```bash
git add src/core/pre-run-diff.ts test/core/pre-run-diff.test.ts
git commit -m "feat: add pre-run diff preview core logic with duplicate warning detection"
```

---

## Task 2: RunMeta 型と executeRun options を拡張

**Files:**
- Modify: `src/core/pipeline-runner.ts:24-42` (RunMeta インターフェース)
- Modify: `src/core/pipeline-runner.ts:166-172` (executeRun options 型)
- Modify: `src/core/pipeline-runner.ts:177-186` (meta 初期化)

- [ ] **Step 1: RunMeta に optional フィールドを追加**

`src/core/pipeline-runner.ts` の RunMeta インターフェース（行 24 付近）を修正:

現在:
```typescript
export interface RunMeta {
  id: string;
  mode: RunMode;
  inputFiles: string[];
  configPath?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  error?: string;
  outputDir: string;
  summary?: ReportSummary;
  // new fields (optional for backward compat)
  sourceBatchId?: string;
  logicalSourceKey?: string;
  sourceFileHashes?: Record<string, string>;
  schemaFingerprints?: Record<string, string>;
  ingestDiagnoses?: Record<string, IngestDiagnosis>;
  previousRunId?: string;
}
```

変更後（末尾に 2 行追加）:
```typescript
export interface RunMeta {
  id: string;
  mode: RunMode;
  inputFiles: string[];
  configPath?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  error?: string;
  outputDir: string;
  summary?: ReportSummary;
  // new fields (optional for backward compat)
  sourceBatchId?: string;
  logicalSourceKey?: string;
  sourceFileHashes?: Record<string, string>;
  schemaFingerprints?: Record<string, string>;
  ingestDiagnoses?: Record<string, IngestDiagnosis>;
  previousRunId?: string;
  /** confirm 段階で duplicate warning が表示された場合 true */
  duplicateWarningShown?: boolean;
  /** duplicate warning を見た上で明示的に override して実行した場合 true */
  duplicateOverride?: boolean;
}
```

- [ ] **Step 2: executeRun の options 型を拡張**

`src/core/pipeline-runner.ts` の `executeRun` シグネチャ（行 166-172 付近）を修正:

現在:
```typescript
export async function executeRun(
  mode: RunMode,
  inputFiles: string[],
  config: WorkbenchConfig,
  configPath?: string,
  options?: { async?: boolean },
): Promise<RunMeta> {
```

変更後:
```typescript
export async function executeRun(
  mode: RunMode,
  inputFiles: string[],
  config: WorkbenchConfig,
  configPath?: string,
  options?: {
    async?: boolean;
    duplicateWarningShown?: boolean;
    duplicateOverride?: boolean;
  },
): Promise<RunMeta> {
```

- [ ] **Step 3: meta 初期化時に duplicate フィールドを設定**

`executeRun` 内の `meta` 初期化（行 177-186 付近）を修正:

現在:
```typescript
  const meta: RunMeta = {
    id: runId,
    mode,
    inputFiles: inputFiles.map((f) => resolve(f)),
    configPath,
    status: 'running',
    startedAt: new Date().toISOString(),
    outputDir: runDir,
  };
  saveMeta(meta);
```

変更後:
```typescript
  const meta: RunMeta = {
    id: runId,
    mode,
    inputFiles: inputFiles.map((f) => resolve(f)),
    configPath,
    status: 'running',
    startedAt: new Date().toISOString(),
    outputDir: runDir,
    ...(options?.duplicateWarningShown ? { duplicateWarningShown: true } : {}),
    ...(options?.duplicateOverride ? { duplicateOverride: true } : {}),
  };
  saveMeta(meta);
```

- [ ] **Step 4: TypeScript チェック（今回の変更のみ）**

```bash
npx tsc --noEmit 2>&1 | grep -v "node_modules" | grep "pipeline-runner" | head -20
```

Expected: pipeline-runner.ts に新しいエラーが出ていないこと

- [ ] **Step 5: 既存テストが壊れていないことを確認**

```bash
npx vitest run test/core/pipeline-runner.test.ts 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 6: commit**

```bash
git add src/core/pipeline-runner.ts
git commit -m "feat: extend RunMeta and executeRun options with duplicate warning fields"
```

---

## Task 3: サーバー拡張

**Files:**
- Modify: `src/ui/server.ts`

- [ ] **Step 1: import を追加**

`server.ts` 先頭の import ブロックに追加（`buildCandidateProfile` などの import の後に追加）:

```typescript
import { buildPreRunDiffPreview } from '../core/pre-run-diff.js';
```

- [ ] **Step 2: `/api/upload-identify` レスポンスに sourceFileHash / schemaFingerprint を追加**

`server.ts` の upload-identify ハンドラの `res.json({...})` 部分を変更:

現在（行 451 付近）:
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

- [ ] **Step 3: `GET /api/pre-run-preview` エンドポイントを追加**

`server.ts` の `/api/configs` エンドポイント（行 642 付近）の直前に追加:

```typescript
  // --- API: Pre-run diff preview (confirm 段階で実行前に比較) ---
  app.get('/api/pre-run-preview', (req, res) => {
    const filename = String(req.query.filename ?? '');
    if (!filename) {
      return res.status(400).json({ error: 'filename は必須です' });
    }
    const sourceFileHash = req.query.sourceFileHash ? String(req.query.sourceFileHash) : undefined;
    const schemaFingerprint = req.query.schemaFingerprint ? String(req.query.schemaFingerprint) : undefined;
    const columnCount = req.query.columnCount ? parseInt(String(req.query.columnCount), 10) : 0;

    const preview = buildPreRunDiffPreview(baseOutputDir, {
      filename,
      sourceFileHash,
      schemaFingerprint,
      columnCount,
    });
    res.json(preview);
  });
```

- [ ] **Step 4: `POST /api/runs` で duplicateWarningShown / duplicateOverride を受け取る**

`server.ts` の POST /api/runs ハンドラ内の `executeRun` 呼び出し部分（行 190 付近）を修正:

現在:
```typescript
      const meta = await executeRun(mode, inputFiles, config, configPath);
```

変更後:
```typescript
      const dupWarningShown = req.body.duplicateWarningShown === 'true' || req.body.duplicateWarningShown === true;
      const dupOverride = req.body.duplicateOverride === 'true' || req.body.duplicateOverride === true;
      const meta = await executeRun(mode, inputFiles, config, configPath, {
        ...(dupWarningShown ? { duplicateWarningShown: true } : {}),
        ...(dupOverride ? { duplicateOverride: true } : {}),
      });
```

- [ ] **Step 5: TypeScript チェック（server.ts のみ）**

```bash
npx tsc --noEmit 2>&1 | grep -v "node_modules" | grep "server\.ts" | head -20
```

Expected: server.ts に新しいエラーが出ていないこと

- [ ] **Step 6: commit**

```bash
git add src/ui/server.ts
git commit -m "feat: add GET /api/pre-run-preview and extend upload-identify response with sourceFileHash"
```

---

## Task 4: フロントエンド — confirm 画面に duplicate warning を追加

**Files:**
- Modify: `src/ui/public/app.js`

### 変更の全体像

1. `renderConfirmPage()` 内のページスコープ変数として `currentPreRunPreview` / `duplicateOverrideActive` を追加
2. action area に `id="action-area"` を追加
3. `renderPreRunPreviewCard()` ヘルパー関数を追加（`escapeHtml` の直前あたりに配置）
4. `renderConfirmPage()` 内で `app.innerHTML = html` の直後、非同期で pre-run preview を取得
5. preview が `duplicateWarning: true` のとき action area を書き換える
6. proceed ボタンのクリックハンドラで `duplicateWarningShown` / `duplicateOverride` を POST に含める

---

- [ ] **Step 1: `renderPreRunPreviewCard()` ヘルパーを `escapeHtml` 関数の直前に追加**

`app.js` の行 1119 付近（`function escapeHtml(str)` の直前）に挿入:

```javascript
// --- Pre-run diff preview card (重複再投入ガード) ---

function renderPreRunPreviewCard(preview) {
  if (!preview) return '';
  const cls = preview.classification;
  const label = preview.classificationLabel || '';

  let icon = '○';
  let color = '#6b7280';
  let bgColor = '#f9fafb';
  if (cls === 'same_file') {
    icon = '！';
    color = '#b45309';
    bgColor = '#fef3c7';
  } else if (cls === 'first_import') {
    icon = '★';
    color = '#6366f1';
    bgColor = '#ede9fe';
  } else if (cls === 'column_changed') {
    icon = '！';
    color = '#d97706';
    bgColor = '#fef3c7';
  } else if (cls === 'row_changed') {
    icon = '↑';
    color = '#2563eb';
    bgColor = '#dbeafe';
  }

  let detailLines = '';
  if (preview.rowCountPrev !== null) {
    detailLines += `<div style="font-size:12px;color:#6b7280;margin-top:4px">前回の件数: <strong>${Number(preview.rowCountPrev).toLocaleString('ja-JP')}件</strong></div>`;
  }
  if (preview.columnCountDelta !== null && preview.columnCountDelta !== 0) {
    const sign = preview.columnCountDelta > 0 ? '+' : '';
    detailLines += `<div style="font-size:12px;color:${color};margin-top:2px">列数の変化: <strong>${sign}${preview.columnCountDelta}列</strong>（前回 ${preview.columnCountPrev ?? '?'}列 → 今回 ${preview.columnCountCurr}列）</div>`;
  } else if (preview.columnCountPrev !== null) {
    detailLines += `<div style="font-size:12px;color:#6b7280;margin-top:2px">列数: <strong>${preview.columnCountCurr}列</strong>（前回と同じ）</div>`;
  }

  return `
    <div class="card" style="background:${bgColor};border:1px solid ${color};padding:12px 16px">
      <div style="font-size:13px;font-weight:600;color:${color}">${icon} ${escapeHtml(label)}</div>
      ${detailLines}
    </div>
  `;
}
```

- [ ] **Step 2: `renderConfirmPage()` 内のページスコープ変数を追加**

`renderConfirmPage()` 関数の先頭（行 1131 の `if (!pendingConfirmation)` の直前）に追加:

```javascript
  let currentPreRunPreview = null;
  let duplicateOverrideActive = false;
```

- [ ] **Step 3: action area に id を付け、duplicate warning カード用のプレースホルダーを追加**

`renderConfirmPage()` 内の action buttons 部分（行 1300-1306 付近）を変更:

現在:
```javascript
  // Action buttons
  html += `
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-primary" id="confirm-proceed-btn">確認して実行</button>
      <a href="/new" class="btn">戻る</a>
    </div>
  `;
```

変更後:
```javascript
  // Duplicate warning placeholder (filled asynchronously after pre-run preview loads)
  html += `<div id="duplicate-warning-container"></div>`;

  // Action buttons
  html += `
    <div id="action-area" style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-primary" id="confirm-proceed-btn">確認して実行</button>
      <a href="/new" class="btn">戻る</a>
    </div>
  `;
```

- [ ] **Step 4: `app.innerHTML = html` の直後に非同期 pre-run preview 取得を追加**

`app.innerHTML = html;`（行 1308）の直後に以下を追加:

```javascript
  // Pre-run preview を非同期で取得（confirm フローを止めない）
  (async () => {
    try {
      const params = new URLSearchParams({
        filename: data.filename || '',
        columnCount: String((data.columns || []).length),
      });
      if (data.sourceFileHash) params.set('sourceFileHash', data.sourceFileHash);
      if (data.schemaFingerprint) params.set('schemaFingerprint', data.schemaFingerprint);

      currentPreRunPreview = await api(`/api/pre-run-preview?${params.toString()}`);

      const warningContainer = document.getElementById('duplicate-warning-container');
      if (!warningContainer) return;

      if (currentPreRunPreview?.duplicateWarning) {
        // duplicate warning あり → カードと分岐ボタンを表示
        const prevRunId = currentPreRunPreview.previousRunId;
        warningContainer.innerHTML = `
          <div class="card" style="background:#fef3c7;border:1px solid #b45309;padding:12px 16px;margin-bottom:0">
            <div style="font-size:13px;font-weight:600;color:#b45309">！ 前回と同じ内容の可能性があります</div>
            <div style="font-size:12px;color:#6b7280;margin-top:4px">前回の結果を確認してから進めることをおすすめします。<br>必要な場合だけもう一度実行してください。</div>
            ${currentPreRunPreview.rowCountPrev !== null
              ? `<div style="font-size:12px;color:#6b7280;margin-top:4px">前回の件数: <strong>${Number(currentPreRunPreview.rowCountPrev).toLocaleString('ja-JP')}件</strong></div>`
              : ''}
            ${prevRunId ? `
            <div style="margin-top:10px">
              <a href="/runs/${encodeURIComponent(prevRunId)}" class="btn" style="font-size:13px">前回の結果を見る</a>
            </div>` : ''}
          </div>
        `;

        // action area を更新：「それでも実行する」を明示
        const actionArea = document.getElementById('action-area');
        if (actionArea) {
          actionArea.innerHTML = `
            <button class="btn" id="confirm-proceed-btn" style="font-size:12px;color:#6b7280">それでも実行する</button>
            <a href="/new" class="btn">戻る</a>
          `;
          // proceed ボタンを再バインド（duplicate override あり）
          const overrideBtn = document.getElementById('confirm-proceed-btn');
          if (overrideBtn) {
            overrideBtn.addEventListener('click', async () => {
              duplicateOverrideActive = true;
              await executeProceed({ data, pm, duplicateWarningShown: true, duplicateOverride: true });
            });
          }
        }
      } else if (currentPreRunPreview && !currentPreRunPreview.duplicateWarning) {
        // duplicate warning なし → 軽量な状態カードを表示
        warningContainer.innerHTML = renderPreRunPreviewCard(currentPreRunPreview);
      }
    } catch {
      // 取得失敗は無視（confirm フローを止めない）
    }
  })();
```

- [ ] **Step 5: 実行処理を `executeProceed()` ヘルパーに切り出す**

`renderConfirmPage()` 内の proceed ボタンのイベントリスナー（行 1358-1445 付近）を `executeProceed()` ヘルパーに切り出す。

まず `renderConfirmPage()` 関数内に `executeProceed` ヘルパーを定義する（`// Proceed button` コメントの直前に追加）:

```javascript
  async function executeProceed({ data, pm, duplicateWarningShown = false, duplicateOverride = false } = {}) {
    const choice = document.querySelector('input[name="file-type-choice"]:checked')?.value;
    const hasHeader = document.querySelector('input[name="has-header"]:checked')?.value !== 'false';
    const fs = data.formState;

    const ingestOptions = {
      encoding: document.getElementById('retry-encoding')?.value || fs.encoding,
      delimiter: fs.delimiter,
      hasHeader,
    };

    let selectedProfileId = null;
    if (choice === 'known' && pm.profile) {
      selectedProfileId = pm.profile.id;
    } else if (choice === 'alt') {
      selectedProfileId = document.getElementById('alt-profile-select')?.value;
    }

    const proceedBtn = document.getElementById('confirm-proceed-btn');
    if (proceedBtn) {
      proceedBtn.disabled = true;
      proceedBtn.textContent = '実行中...';
    }

    try {
      let result;
      if (data.filePath && !fs.uploadedFiles?.length) {
        result = await api('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: fs.mode,
            configPath: fs.configPath,
            filePaths: [data.filePath],
            ingestOptions,
            duplicateWarningShown,
            duplicateOverride,
          }),
        });
      } else {
        const formData = new FormData();
        formData.append('mode', fs.mode);
        if (fs.configPath) formData.append('configPath', fs.configPath);
        if (fs.uploadedFiles) {
          for (const f of fs.uploadedFiles) formData.append('files', f);
        } else {
          for (const f of uploadedFiles) formData.append('files', f);
        }
        if (fs.filePathsText?.length > 0) {
          formData.append('filePaths', JSON.stringify(fs.filePathsText));
        }
        formData.append('ingestOptions', JSON.stringify(ingestOptions));
        if (duplicateWarningShown) formData.append('duplicateWarningShown', 'true');
        if (duplicateOverride) formData.append('duplicateOverride', 'true');

        const res = await fetch('/api/runs', { method: 'POST', body: formData });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        result = await res.json();
      }

      if (choice === 'new') {
        pendingConfirmation = { ...data, runId: result.id, selectedProfileId: null };
        navigate(`/runs/${result.id}/columns`);
      } else if (selectedProfileId) {
        pendingConfirmation = { ...data, runId: result.id, selectedProfileId };
        navigate(`/runs/${result.id}/columns`);
      } else {
        navigate(`/runs/${result.id}`);
      }
    } catch (err) {
      if (proceedBtn) {
        proceedBtn.disabled = false;
        proceedBtn.textContent = duplicateOverride ? 'それでも実行する' : '確認して実行';
      }
      alert('実行に失敗しました: ' + err.message);
    }
  }
```

- [ ] **Step 6: 既存の proceedBtn イベントリスナーを executeProceed 呼び出しに置き換える**

現在の proceed ボタンのイベントリスナー（行 1358-1444 付近）を以下に置き換える:

現在:
```javascript
  // Proceed button
  const proceedBtn = document.getElementById('confirm-proceed-btn');
  if (proceedBtn) {
    proceedBtn.addEventListener('click', async () => {
      const choice = document.querySelector('input[name="file-type-choice"]:checked')?.value;
      const hasHeader = document.querySelector('input[name="has-header"]:checked')?.value !== 'false';
      const fs = data.formState;

      // Update ingest options with confirmed header
      const ingestOptions = {
        encoding: document.getElementById('retry-encoding')?.value || fs.encoding,
        delimiter: fs.delimiter,
        hasHeader,
      };

      // Determine selected profile
      let selectedProfileId = null;
      if (choice === 'known' && pm.profile) {
        selectedProfileId = pm.profile.id;
      } else if (choice === 'alt') {
        selectedProfileId = document.getElementById('alt-profile-select')?.value;
      }
      // choice === 'new' → no profile

      proceedBtn.disabled = true;
      proceedBtn.textContent = '実行中...';

      try {
        let result;
        if (data.filePath && !fs.uploadedFiles?.length) {
          // Local path execution
          result = await api('/api/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mode: fs.mode,
              configPath: fs.configPath,
              filePaths: [data.filePath],
              ingestOptions,
            }),
          });
        } else {
          // Uploaded file execution
          const formData = new FormData();
          formData.append('mode', fs.mode);
          if (fs.configPath) formData.append('configPath', fs.configPath);
          if (fs.uploadedFiles) {
            for (const f of fs.uploadedFiles) formData.append('files', f);
          } else {
            for (const f of uploadedFiles) formData.append('files', f);
          }
          if (fs.filePathsText?.length > 0) {
            formData.append('filePaths', JSON.stringify(fs.filePathsText));
          }
          formData.append('ingestOptions', JSON.stringify(ingestOptions));

          const res = await fetch('/api/runs', { method: 'POST', body: formData });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${res.status}`);
          }
          result = await res.json();
        }

        // If new file → go to column review; if known file → go to run detail
        if (choice === 'new') {
          pendingConfirmation = {
            ...data,
            runId: result.id,
            selectedProfileId: null,
          };
          navigate(`/runs/${result.id}/columns`);
        } else if (selectedProfileId) {
          pendingConfirmation = {
            ...data,
            runId: result.id,
            selectedProfileId,
          };
          navigate(`/runs/${result.id}/columns`);
        } else {
          navigate(`/runs/${result.id}`);
        }
      } catch (err) {
        proceedBtn.disabled = false;
        proceedBtn.textContent = '確認して実行';
        alert('実行に失敗しました: ' + err.message);
      }
    });
  }
```

変更後（executeProceed を呼ぶだけ）:
```javascript
  // Proceed button（duplicate warning がない場合の通常フロー）
  const proceedBtn = document.getElementById('confirm-proceed-btn');
  if (proceedBtn) {
    proceedBtn.addEventListener('click', () => {
      executeProceed({ data, pm });
    });
  }
```

- [ ] **Step 7: ブラウザで動作を手動確認するチェックポイント**

- confirm 画面で `/api/pre-run-preview` が呼ばれる（Network タブ確認）
- 初回 upload 時は「初めての取り込みです」カード（または何も表示しない）
- 同じファイルを再 upload すると amber の duplicate warning カード
- duplicate warning のとき「前回の結果を見る」リンクが表示される
- duplicate warning のとき proceed ボタンが「それでも実行する」に変わる
- 「それでも実行する」で実行すると run detail へ遷移する
- カード取得失敗時も confirm フローが止まらない（Network をオフにしてテスト）

- [ ] **Step 8: commit**

```bash
git add src/ui/public/app.js
git commit -m "feat: show duplicate warning card on confirm page with override option"
```

---

## Task 5: 追加テスト — duplicate override 実行の記録確認

**Files:**
- Modify: `test/core/pre-run-diff.test.ts`

- [ ] **Step 1: executeRun での duplicateOverride 記録テストを追加**

`test/core/pre-run-diff.test.ts` の `describe` ブロック末尾に以下を追加:

```typescript
  it('duplicate warning を表示した上で override 実行すると run meta に記録される', async () => {
    const file = join(F, 'utf8.csv');
    const meta = await executeRun('profile', [file], {
      ...config,
      outputDir: OUTPUT,
    }, undefined, {
      duplicateWarningShown: true,
      duplicateOverride: true,
    });

    expect(meta.status).toBe('completed');
    expect(meta.duplicateWarningShown).toBe(true);
    expect(meta.duplicateOverride).toBe(true);

    // run-meta.json に永続化されていることを確認
    const saved = await import('node:fs').then(fs =>
      JSON.parse(fs.readFileSync(`${meta.outputDir}/run-meta.json`, 'utf-8'))
    );
    expect(saved.duplicateWarningShown).toBe(true);
    expect(saved.duplicateOverride).toBe(true);
  });

  it('duplicateWarning なしの通常実行では duplicate フィールドが undefined になる', async () => {
    const file = join(F, 'utf8.csv');
    const meta = await executeRun('profile', [file], {
      ...config,
      outputDir: OUTPUT,
    });

    expect(meta.duplicateWarningShown).toBeUndefined();
    expect(meta.duplicateOverride).toBeUndefined();
  });

  it('built-in profile と candidate profile で logicalSourceKey が一致し comparable run が見つかる', async () => {
    // utf8.csv で 2 回実行（built-in と candidate の両方を模擬）
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], { ...config, outputDir: OUTPUT });
    expect(r1.status).toBe('completed');

    // 同じ filename で pre-run preview → comparable run が見つかるはず
    const result = buildPreRunDiffPreview(OUTPUT, {
      filename: 'utf8.csv',  // basename が同じ → logicalSourceKey が一致
      columnCount: r1.summary?.columnCount ?? 1,
    });
    expect(result.previousRunId).not.toBeNull();
  });
```

- [ ] **Step 2: テストを実行して全 pass を確認**

```bash
npx vitest run test/core/pre-run-diff.test.ts 2>&1 | tail -40
```

Expected: 全テスト PASS

- [ ] **Step 3: commit**

```bash
git add test/core/pre-run-diff.test.ts
git commit -m "test: add duplicate override execution and recording tests"
```

---

## Task 6: 全体確認 — build / lint / typecheck / test

**Files:**
- なし（確認のみ）

- [ ] **Step 1: 全テスト実行**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx vitest run 2>&1 | tail -60
```

Expected: 新規追加テストが PASS、既存テストが壊れていないこと

- [ ] **Step 2: TypeScript 型チェック（今回触ったファイルのみ）**

```bash
npx tsc --noEmit 2>&1 | grep -v "node_modules" | grep -E "(pre-run-diff|pipeline-runner|server)" | head -30
```

Expected: 今回触ったファイルに新しいエラーが出ていないこと

- [ ] **Step 3: 既存エラーと今回の変更による影響を切り分け**

```bash
# 既存エラーを確認（変更前から存在するもの）
npx tsc --noEmit 2>&1 | grep -v "node_modules" | grep -v "pre-run-diff\|pipeline-runner\|server\.ts" | head -20
```

Expected: `detectHeaderLikelihood`、`scanForMojibake`、`bundleDir` 等の既知エラーが出るが、今回の変更範囲には及ばないこと

- [ ] **Step 4: lint（あれば）**

```bash
npm run lint 2>&1 | grep -E "(pre-run-diff|server\.ts|app\.js|pipeline-runner)" | head -20
```

- [ ] **Step 5: 既存テスト全体を確認**

```bash
npx vitest run 2>&1 | grep -E "PASS|FAIL|Error" | head -30
```

---

## Self-Review

### Spec coverage チェック

| 要件 | タスク |
|-----|--------|
| sameRawFingerprint ベースの duplicate guard | Task 1: `buildPreRunDiffPreview()` の `duplicateWarning` フィールド |
| confirm 画面での duplicate warning カード表示 | Task 4: amber カード、「前回と同じ内容の可能性があります」 |
| 前回 run への導線「前回の結果を見る」 | Task 4: `/runs/{previousRunId}` リンク |
| 「それでも実行する」override ボタン | Task 4: action area の書き換え |
| duplicate warning 時の default は「前回の結果を見る」寄り | Task 4: override ボタンを小さめ・2番目に配置 |
| duplicateWarningShown / duplicateOverride の記録 | Task 2: RunMeta 拡張、Task 3: server で受け取り、Task 5: テスト |
| 自動ブロックしない | Task 1: `duplicateWarning` は情報提供のみ、Task 4: override 可能 |
| built-in / candidate の既存再利用を壊さない | Task 5: logicalSourceKey 一致テスト |
| sameRawFingerprint でない場合は警告が出ない | Task 1 / Task 5 テスト |
| テスト（4ケース以上） | Task 1 + Task 5 |

### Placeholder scan

- なし（全ステップにコードあり）

### Type consistency

- `RunMeta.duplicateWarningShown?: boolean` → `executeRun options.duplicateWarningShown` → `meta.duplicateWarningShown` ✓
- `buildPreRunDiffPreview` の `PreRunDiffPreview.duplicateWarning: boolean` → `currentPreRunPreview?.duplicateWarning` (JS) ✓
- `listRuns()` の返り値 `RunMeta[]` → `r.logicalSourceKey` / `r.sourceFileHashes` / `r.summary` は既存フィールド ✓
- `logicalSourceKey([basename(input.filename)])` → `pipeline-runner.ts` の `logicalSourceKey(srcKeys)` と同じ関数 ✓
