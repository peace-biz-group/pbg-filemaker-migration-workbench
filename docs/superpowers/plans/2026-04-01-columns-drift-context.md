# Columns Drift Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** schema drift guard 後の /runs/:id/columns 画面で、前回との列差分（増えた列・消えた列）を最小限かつ分かりやすく表示し、現場が「どこを見ればよいか」をすぐ判断できるようにする。

**Architecture:** `RunMeta` に `columnNames` を追加して run 完了時に保存。`buildColumnsDriftContext()` を `pre-run-diff.ts` に追加して前回 run との差分を計算。`GET /api/runs/:id/drift-context` エンドポイント経由で columns 画面に渡す。UI は既存 `renderColumnReview()` に drift サマリブロックと列バッジを追加する。

**Tech Stack:** TypeScript (Node.js), Express, Vitest, vanilla JS (app.js)

---

## ファイル構成

| 操作 | ファイル | 理由 |
|------|---------|------|
| 新規作成 | `src/core/effective-mapping.ts` | worktree から移植。server.ts / candidate-profile.ts が import 済みだが本体が未マージ（既存 typecheck error の根本） |
| 修正 | `src/core/pipeline-runner.ts` | `RunMeta` に `columnNames?` 追加。`executeRun()` で `ir.columns` を保存 |
| 修正 | `src/core/pre-run-diff.ts` | `ColumnsDriftContext` 型と `buildColumnsDriftContext()` 追加 |
| 修正 | `src/ui/server.ts` | `GET /api/runs/:id/drift-context` エンドポイント追加 |
| 修正 | `src/ui/public/app.js` | `renderColumnReview()` に drift サマリブロック・列バッジ・前回 run リンクを追加 |
| 修正 | `test/core/pre-run-diff.test.ts` | `buildColumnsDriftContext` のテストを追加 |

---

## Task 1: effective-mapping.ts を src/core/ に追加する

worktree (`_worktrees/review-workflow-v2/src/core/effective-mapping.ts`) に実装済みの `effective-mapping.ts` が `src/core/` に存在せず、`server.ts` と `candidate-profile.ts` が既に import しているため typecheck が失敗している。まずこれを解消する。

**Files:**
- Create: `src/core/effective-mapping.ts`

- [ ] **Step 1: ファイルを作成する**

```typescript
/**
 * Effective Mapping — 列レビュー回答から run 単位の実効 mapping を生成する。
 *
 * - profile の seed 定義は source of truth として残す
 * - 列レビュー結果で run ごとに補正できる構造
 * - profile 本体は変更しない（run-scoped only）
 * - fail-closed: unknown は canonical に昇格させない
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ColumnReviewEntry, ColumnDef } from '../file-profiles/types.js';

// --- Types ---

export interface EffectiveMappingColumn {
  position: number;
  /** 実際の CSV 列ヘッダー名 */
  sourceHeader: string;
  /** 正規化後の内部キー名 */
  canonicalKey: string;
  /** 表示用日本語ラベル */
  label: string;
  /**
   * active  = inUse=yes → mapping に含める
   * unused  = inUse=no  → mapping 対象外
   * pending = inUse=unknown → fail-closed、mapping 対象外
   */
  status: 'active' | 'unused' | 'pending';
  required: 'yes' | 'no' | 'unknown';
}

export interface EffectiveMappingResult {
  runId: string;
  profileId: string;
  generatedAt: string;
  /**
   * 実効 mapping: sourceHeader → canonicalKey
   * inUse=yes の列のみ含む
   */
  mapping: Record<string, string>;
  activeCount: number;
  unusedCount: number;
  pendingCount: number;
  columns: EffectiveMappingColumn[];
}

// --- Core logic ---

/**
 * 列レビュー回答から run 単位の実効 mapping を生成する。
 *
 * known file (profileDef あり):
 *   - profile の ColumnDef がベース (position → key)
 *   - review で意味・inUse・required を補正
 *
 * new file (profileDef なし):
 *   - review.label (CSVヘッダー) → review.key (ユーザー入力 or ヘッダーそのまま) で mapping
 *
 * ルール:
 *   - inUse=yes  → mapping[sourceHeader] = canonicalKey
 *   - inUse=no   → 除外 (status=unused)
 *   - inUse=unknown → 除外 (status=pending, fail-closed)
 */
export function buildEffectiveMapping(
  runId: string,
  profileId: string,
  reviews: ColumnReviewEntry[],
  profileDef?: ColumnDef[] | null,
): EffectiveMappingResult {
  const mapping: Record<string, string> = {};
  const columns: EffectiveMappingColumn[] = [];

  for (const review of reviews) {
    const profileCol = profileDef?.find(c => c.position === review.position) ?? null;

    const sourceHeader = review.label;
    const canonicalKey = review.key || profileCol?.key || sourceHeader;
    const label = review.meaning || profileCol?.label || sourceHeader;

    let status: 'active' | 'unused' | 'pending';
    if (review.inUse === 'yes') {
      status = 'active';
      mapping[sourceHeader] = canonicalKey;
    } else if (review.inUse === 'no') {
      status = 'unused';
    } else {
      status = 'pending';
    }

    columns.push({
      position: review.position,
      sourceHeader,
      canonicalKey,
      label,
      status,
      required: review.required,
    });
  }

  columns.sort((a, b) => a.position - b.position);

  return {
    runId,
    profileId,
    generatedAt: new Date().toISOString(),
    mapping,
    activeCount: columns.filter(c => c.status === 'active').length,
    unusedCount: columns.filter(c => c.status === 'unused').length,
    pendingCount: columns.filter(c => c.status === 'pending').length,
    columns,
  };
}

// --- Persistence ---

function getEffectiveMappingDir(dataDir: string): string {
  return join(dataDir, 'column-reviews', 'effective');
}

function getEffectiveMappingPath(dataDir: string, runId: string, profileId: string): string {
  return join(getEffectiveMappingDir(dataDir), `${runId}_${profileId}.json`);
}

export function saveEffectiveMapping(dataDir: string, result: EffectiveMappingResult): void {
  const dir = getEffectiveMappingDir(dataDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    getEffectiveMappingPath(dataDir, result.runId, result.profileId),
    JSON.stringify(result, null, 2),
    'utf-8',
  );
}

export function loadEffectiveMapping(
  dataDir: string,
  runId: string,
  profileId: string,
): EffectiveMappingResult | null {
  const filePath = getEffectiveMappingPath(dataDir, runId, profileId);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as EffectiveMappingResult;
  } catch {
    return null;
  }
}

/**
 * 指定 runId に紐づく全 effective mapping を返す。
 */
export function findEffectiveMappings(dataDir: string, runId: string): EffectiveMappingResult[] {
  const dir = getEffectiveMappingDir(dataDir);
  if (!existsSync(dir)) return [];

  const prefix = `${runId}_`;
  const results: EffectiveMappingResult[] = [];

  for (const f of readdirSync(dir)) {
    if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
    try {
      results.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')) as EffectiveMappingResult);
    } catch {
      // skip corrupted
    }
  }

  return results;
}
```

- [ ] **Step 2: typecheck を実行して effective-mapping 関連エラーが消えることを確認する**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npm run typecheck 2>&1 | grep -E "effective-mapping|Cannot find module"
```

期待: `effective-mapping` に関するエラーが 0 件になる（他の既存エラーは残ってよい）

- [ ] **Step 3: コミット**

```bash
git add src/core/effective-mapping.ts
git commit -m "feat: add effective-mapping.ts to src/core (migrate from worktree)"
```

---

## Task 2: RunMeta に columnNames を追加し executeRun で保存する

columns diff を計算するために、各 run の CSV 列名を run-meta.json に保存する。

**Files:**
- Modify: `src/core/pipeline-runner.ts`

- [ ] **Step 1: RunMeta インターフェースに columnNames を追加する**

`src/core/pipeline-runner.ts` の `RunMeta` インターフェース（現在 line 24〜50）を以下のように修正する：

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
  /** 最初の入力ファイルの列名一覧（drift context 用） */
  columnNames?: string[];
  previousRunId?: string;
  /** confirm 段階で duplicate warning が表示された場合 true */
  duplicateWarningShown?: boolean;
  /** duplicate warning を見た上で明示的に override して実行した場合 true */
  duplicateOverride?: boolean;
  /** confirm 段階で schema drift warning が表示された場合 true */
  schemaDriftWarningShown?: boolean;
  /** schema drift warning を見た上で明示的に override して進んだ場合 true */
  schemaDriftOverride?: boolean;
}
```

- [ ] **Step 2: executeRun の ingestFile ループで ir.columns を保存する**

`executeRun()` 内の `for (const f of inputFiles)` ループ（line 224 付近）に以下を追加する。
`ir.columns` は既にループ内で参照されているため、最初のファイルの列名だけ保存すればよい。

既存コード（line 224〜241 付近）の `ingestDiagnoses[f] = ir.diagnosis;` の直後に追加する：

```typescript
// 最初のファイルの列名を drift context 用に保存
if (!meta.columnNames && ir.columns.length > 0) {
  meta.columnNames = ir.columns;
}
```

つまりループ全体はこうなる（抜粋）：

```typescript
for (const f of inputFiles) {
  const ir = await ingestFile(f, resolveFileIngestOptions(f, config), 1);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of ir.records) { break; }
  sourceFileHashes[f] = ir.sourceFileHash;
  schemaFingerprints[f] = ir.schemaFingerprint;
  ingestDiagnoses[f] = ir.diagnosis;
  // drift context 用: 最初のファイルの列名を保存
  if (!meta.columnNames && ir.columns.length > 0) {
    meta.columnNames = ir.columns;
  }

  // Write mapping suggestions
  const suggestions = generateMappingSuggestions(ir.schemaFingerprint, ir.columns);
  if (suggestions.suggestions.length > 0) {
    writeFileSync(
      join(runDir, 'mapping-suggestions.json'),
      JSON.stringify(suggestions, null, 2),
      'utf-8',
    );
  }
}
```

- [ ] **Step 3: テストを書く**

`test/core/pipeline-runner.test.ts` に以下を追加（既存のテストファイルがあればそこに追記）：

```typescript
it('executeRun 後の run meta に columnNames が保存される', async () => {
  const file = join(F, 'utf8.csv');
  const meta = await executeRun('profile', [file], config);
  expect(meta.status).toBe('completed');
  expect(meta.columnNames).toBeDefined();
  expect(Array.isArray(meta.columnNames)).toBe(true);
  expect(meta.columnNames!.length).toBeGreaterThan(0);

  // run-meta.json に永続化されていること
  const { readFileSync } = await import('node:fs');
  const saved = JSON.parse(readFileSync(`${meta.outputDir}/run-meta.json`, 'utf-8'));
  expect(saved.columnNames).toEqual(meta.columnNames);
});
```

- [ ] **Step 4: テストを実行して通ることを確認する**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx vitest run test/core/pipeline-runner.test.ts 2>&1 | tail -20
```

期待: `columnNames` のテストが PASS

- [ ] **Step 5: コミット**

```bash
git add src/core/pipeline-runner.ts test/core/pipeline-runner.test.ts
git commit -m "feat: store columnNames in RunMeta for drift context"
```

---

## Task 3: buildColumnsDriftContext を pre-run-diff.ts に追加する

columns 画面用の軽量 drift context を計算する純粋関数を追加する。

**Files:**
- Modify: `src/core/pre-run-diff.ts`

- [ ] **Step 1: ColumnsDriftContext 型を定義し、関数を追加する**

`src/core/pre-run-diff.ts` の末尾（`buildPreRunDiffPreview` の後）に以下を追加する：

```typescript
/**
 * columns 画面向けの drift context。
 * comparable previous run がある場合だけ生成する。
 * previousRunId がない場合は null を返す。
 */
export interface ColumnsDriftContext {
  version: 1;
  /** 比較対象の前回 run ID */
  previousRunId: string;
  /** 前回の列名一覧。run-meta に columnNames がない場合は null */
  previousColumnNames: string[] | null;
  /** 今回の列名一覧 */
  currentColumnNames: string[];
  /** 今回増えた列（previous にはなく current にある） */
  addedColumns: string[];
  /** 前回あったが今回ない列 */
  removedColumns: string[];
  /** run meta に schemaDriftWarningShown=true が記録されているか */
  schemaDriftWarningShown: boolean;
}

/**
 * 指定 runId の columns 画面向け drift context を生成する。
 *
 * - previousRunId がない（初回 import） → null を返す
 * - previousRunId があるが columnNames が両方取れない → addedColumns / removedColumns は空
 * - 軽量判定のみ（row diff なし）
 */
export function buildColumnsDriftContext(
  outputDir: string,
  runId: string,
): ColumnsDriftContext | null {
  const meta = getRun(outputDir, runId);
  if (!meta || !meta.previousRunId) return null;

  const prevMeta = getRun(outputDir, meta.previousRunId);
  if (!prevMeta) return null;

  const currentColumnNames = meta.columnNames ?? [];
  const previousColumnNames = prevMeta.columnNames ?? null;

  let addedColumns: string[] = [];
  let removedColumns: string[] = [];

  if (previousColumnNames !== null && currentColumnNames.length > 0) {
    const prevSet = new Set(previousColumnNames);
    const currSet = new Set(currentColumnNames);
    addedColumns = currentColumnNames.filter(c => !prevSet.has(c));
    removedColumns = previousColumnNames.filter(c => !currSet.has(c));
  }

  return {
    version: 1,
    previousRunId: meta.previousRunId,
    previousColumnNames,
    currentColumnNames,
    addedColumns,
    removedColumns,
    schemaDriftWarningShown: meta.schemaDriftWarningShown ?? false,
  };
}
```

`getRun` を使うため、import を追加する必要がある：

```typescript
import { listRuns, getRun } from './pipeline-runner.js';
```

（既存の `import { listRuns } from './pipeline-runner.js';` を修正）

- [ ] **Step 2: テストを書く（failing）**

`test/core/pre-run-diff.test.ts` に以下の describe ブロックを追加する：

```typescript
import { buildPreRunDiffPreview, buildColumnsDriftContext } from '../../src/core/pre-run-diff.js';

// ... 既存のテスト ...

describe('buildColumnsDriftContext', () => {
  it('previousRunId がない run では null を返す', async () => {
    // 初回 run（comparable run なし）
    const result = buildColumnsDriftContext(OUTPUT, 'nonexistent-run-id');
    expect(result).toBeNull();
  });

  it('comparable previous run がある場合に drift context を返す', async () => {
    // 1回目 run
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], config);
    expect(r1.status).toBe('completed');

    // 2回目 run（前回 run が存在する）
    const r2 = await executeRun('profile', [file], config);
    expect(r2.status).toBe('completed');
    expect(r2.previousRunId).toBe(r1.id);

    const ctx = buildColumnsDriftContext(OUTPUT, r2.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.version).toBe(1);
    expect(ctx!.previousRunId).toBe(r1.id);
    expect(Array.isArray(ctx!.currentColumnNames)).toBe(true);
  });

  it('列が変わっていない場合 addedColumns と removedColumns が空', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], config);
    const r2 = await executeRun('profile', [file], config);

    const ctx = buildColumnsDriftContext(OUTPUT, r2.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.addedColumns).toHaveLength(0);
    expect(ctx!.removedColumns).toHaveLength(0);
  });

  it('addedColumns / removedColumns が正しく計算される（columnNames を直接書き換えて検証）', async () => {
    const { writeFileSync } = await import('node:fs');
    const file = join(F, 'utf8.csv');

    // r1 を実行して columnNames を手動で上書き
    const r1 = await executeRun('profile', [file], config);
    const r1Meta = { ...r1, columnNames: ['氏名', '電話番号', '住所'] };
    writeFileSync(`${r1.outputDir}/run-meta.json`, JSON.stringify(r1Meta, null, 2), 'utf-8');

    // r2 を実行して columnNames を手動で上書き（「住所」→「会社名」に変更）
    const r2 = await executeRun('profile', [file], config);
    const r2Meta = { ...r2, previousRunId: r1.id, columnNames: ['氏名', '電話番号', '会社名'] };
    writeFileSync(`${r2.outputDir}/run-meta.json`, JSON.stringify(r2Meta, null, 2), 'utf-8');

    const ctx = buildColumnsDriftContext(OUTPUT, r2.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.addedColumns).toEqual(['会社名']);
    expect(ctx!.removedColumns).toEqual(['住所']);
  });

  it('comparable previous run はあるが columnNames が未保存の場合 addedColumns / removedColumns は空', async () => {
    const { writeFileSync } = await import('node:fs');
    const file = join(F, 'utf8.csv');

    const r1 = await executeRun('profile', [file], config);
    // r1 の columnNames を削除（古い run を模倣）
    const r1Meta = { ...r1 };
    delete (r1Meta as Partial<typeof r1Meta>).columnNames;
    writeFileSync(`${r1.outputDir}/run-meta.json`, JSON.stringify(r1Meta, null, 2), 'utf-8');

    const r2 = await executeRun('profile', [file], config);

    const ctx = buildColumnsDriftContext(OUTPUT, r2.id);
    expect(ctx).not.toBeNull();
    // previousColumnNames が null のため差分計算できない → 空
    expect(ctx!.previousColumnNames).toBeNull();
    expect(ctx!.addedColumns).toHaveLength(0);
    expect(ctx!.removedColumns).toHaveLength(0);
  });

  it('schema drift warning が表示された場合 schemaDriftWarningShown が true', async () => {
    const file = join(F, 'utf8.csv');
    const r1 = await executeRun('profile', [file], config);
    const r2 = await executeRun('profile', [file], config, undefined, {
      schemaDriftWarningShown: true,
    });

    const ctx = buildColumnsDriftContext(OUTPUT, r2.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.schemaDriftWarningShown).toBe(true);
  });

  it('schema drift warning がない場合 schemaDriftWarningShown が false', async () => {
    const file = join(F, 'utf8.csv');
    await executeRun('profile', [file], config);
    const r2 = await executeRun('profile', [file], config);

    const ctx = buildColumnsDriftContext(OUTPUT, r2.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.schemaDriftWarningShown).toBe(false);
  });
});
```

- [ ] **Step 3: テストを実行して失敗を確認する**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx vitest run test/core/pre-run-diff.test.ts 2>&1 | tail -30
```

期待: `buildColumnsDriftContext` のテストが FAIL（関数が未実装のため）

- [ ] **Step 4: 実装を追加する（Step 1 のコードを書く）**

`src/core/pre-run-diff.ts` の import を修正し、関数を追加する。

Import の変更（既存 `import { listRuns }` を `import { listRuns, getRun }` に変更）：

```typescript
import { listRuns, getRun } from './pipeline-runner.js';
```

その後、ファイル末尾に `ColumnsDriftContext` 型定義と `buildColumnsDriftContext()` 関数を追加する（Step 1 のコードを使用）。

- [ ] **Step 5: テストを再実行して通ることを確認する**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx vitest run test/core/pre-run-diff.test.ts 2>&1 | tail -30
```

期待: 全テスト PASS

- [ ] **Step 6: コミット**

```bash
git add src/core/pre-run-diff.ts test/core/pre-run-diff.test.ts
git commit -m "feat: add buildColumnsDriftContext for columns screen drift visualization"
```

---

## Task 4: GET /api/runs/:id/drift-context エンドポイントを追加する

**Files:**
- Modify: `src/ui/server.ts`

- [ ] **Step 1: import を追加する**

`src/ui/server.ts` の既存の import（line 30 付近）に `buildColumnsDriftContext` を追加する：

```typescript
import { buildPreRunDiffPreview, buildColumnsDriftContext } from '../core/pre-run-diff.js';
```

- [ ] **Step 2: エンドポイントを追加する**

`/api/pre-run-preview` エンドポイント（line 654 付近）の直後に以下を追加する：

```typescript
// --- API: Columns drift context (schema drift 後の columns 画面用) ---
app.get('/api/runs/:id/drift-context', (req, res) => {
  const runId = req.params.id;
  const ctx = buildColumnsDriftContext(baseOutputDir, runId);
  if (!ctx) return res.json(null);
  res.json(ctx);
});
```

- [ ] **Step 3: typecheck を実行してエラーが増えていないことを確認する**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npm run typecheck 2>&1 | grep -v "node_modules" | head -20
```

期待: 既存エラー（detectHeaderLikelihood, scanForMojibake 等）のみ。今回の変更由来のエラーがない。

- [ ] **Step 4: コミット**

```bash
git add src/ui/server.ts
git commit -m "feat: add GET /api/runs/:id/drift-context endpoint"
```

---

## Task 5: columns 画面に drift context を表示する

**Files:**
- Modify: `src/ui/public/app.js`

- [ ] **Step 1: renderColumnReview で drift context を取得する**

`renderColumnReview()` 関数の中（「Load preview rows」のブロックの後、「columns が結局空」チェックの前）に以下を追加する：

```javascript
// Load drift context（schema drift 後の差分表示用）
let driftCtx = null;
try {
  driftCtx = await api(`/api/runs/${runId}/drift-context`);
} catch { /* ignore */ }
```

- [ ] **Step 2: drift サマリブロックを html に追加する**

`let html = ...` の直後で `<div class="card">` ブロックを開く前に、drift サマリを差し込む。

既存の以下のコードの直前（`let html = \`\n    <div ...`）に drift サマリの HTML を生成する変数を用意し、`<div class="card">` の中の先頭に差し込む：

```javascript
// Drift サマリ HTML（addedColumns や removedColumns があるときだけ表示）
let driftSummaryHtml = '';
if (driftCtx && (driftCtx.addedColumns.length > 0 || driftCtx.removedColumns.length > 0 || driftCtx.schemaDriftWarningShown)) {
  const addedList = driftCtx.addedColumns.length > 0
    ? `<p style="margin:4px 0;font-size:13px">増えた列: ${driftCtx.addedColumns.map(c => `<strong>${escapeHtml(c)}</strong>`).join('、')}</p>`
    : '';
  const removedList = driftCtx.removedColumns.length > 0
    ? `<p style="margin:4px 0;font-size:13px">なくなった列: ${driftCtx.removedColumns.map(c => `<strong>${escapeHtml(c)}</strong>`).join('、')}</p>`
    : '';
  const prevRunLink = `<p style="margin:8px 0 0 0;font-size:12px"><a href="/runs/${escapeHtml(driftCtx.previousRunId)}" style="color:var(--text-secondary)">前回の結果を見る</a></p>`;

  driftSummaryHtml = `
    <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:12px 14px;margin-bottom:12px">
      <p style="font-weight:600;font-size:13px;margin:0 0 6px 0">前回と列の形が変わっています。新しい列を先に確認してください。</p>
      ${addedList}
      ${removedList}
      ${prevRunLink}
    </div>
  `;
}
```

そして既存の `let html = ...` を以下のように変更する（`<div class="card">` の先頭に `driftSummaryHtml` を挿入）：

```javascript
let html = `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
    <h2 style="font-size:18px">列の確認</h2>
    <div class="btn-group">
      <button class="btn btn-primary" id="save-review-btn">保存</button>
      <a href="/runs/${escapeHtml(runId)}" class="btn">あとで続ける</a>
    </div>
  </div>

  <div class="card">
    ${driftSummaryHtml}
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">
      ${profile ? `「<strong>${escapeHtml(profile.label)}</strong>」の列を確認してください。` : '各列の意味を教えてください。'}
      ${profile?.provisional ? '<span class="badge badge-warning">仮の定義です — 確認をお願いします</span>' : ''}
      ${isResume ? '<span class="badge badge-info">保存済みの回答から続きを表示しています</span>' : ''}
    </p>
    <p style="font-size:12px;color:var(--text-secondary);margin-bottom:16px">
      わからない場合は、そのままで大丈夫です。あとから修正できます。
    </p>
`;
```

- [ ] **Step 3: 各列に「新しい列」バッジを追加する**

`for (const entry of entries)` ループの中で、`entry.headerName` が `driftCtx.addedColumns` に含まれる場合、バッジを付ける。

既存の以下のコードを修正する：

```javascript
// 修正前
<div class="column-review-header">
  <span class="badge badge-info">${entry.position + 1}列目</span>
  <strong>${escapeHtml(entry.headerName)}</strong>
  ${entry.profileLabel ? `<span style="font-size:12px;color:var(--text-secondary)">（候補: ${escapeHtml(entry.profileLabel)}）</span>` : ''}
</div>
```

```javascript
// 修正後
const isNewCol = driftCtx?.addedColumns?.includes(entry.headerName) ?? false;
// ...（テンプレート内で使用）
<div class="column-review-header">
  <span class="badge badge-info">${entry.position + 1}列目</span>
  <strong>${escapeHtml(entry.headerName)}</strong>
  ${isNewCol ? '<span class="badge badge-warning" style="margin-left:4px">新しい列</span>' : ''}
  ${entry.profileLabel ? `<span style="font-size:12px;color:var(--text-secondary)">（候補: ${escapeHtml(entry.profileLabel)}）</span>` : ''}
</div>
```

具体的には `entries` の `map` または `for` ループの中で、各 `entry` に対して `isNewCol` を判定し HTML に反映させる。

実際のコードでは `for (const entry of entries)` の中の html テンプレートを以下のように変更する：

```javascript
for (const entry of entries) {
  const isNewCol = driftCtx?.addedColumns?.includes(entry.headerName) ?? false;
  html += `
    <div class="column-review-item" data-position="${entry.position}">
      <div class="column-review-header">
        <span class="badge badge-info">${entry.position + 1}列目</span>
        <strong>${escapeHtml(entry.headerName)}</strong>
        ${isNewCol ? '<span class="badge badge-warning" style="margin-left:4px">新しい列</span>' : ''}
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
```

- [ ] **Step 4: コミット**

```bash
git add src/ui/public/app.js
git commit -m "feat: show drift context summary and new-column badges in columns screen"
```

---

## Task 6: 全テストを実行して検証する

- [ ] **Step 1: テストスイート全体を実行する**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npm test 2>&1 | tail -40
```

期待: 今回追加したテストが全 PASS。既存テストも PASS。

- [ ] **Step 2: typecheck を実行する**

```bash
npm run typecheck 2>&1 | grep -v "node_modules" | head -30
```

期待: effective-mapping 由来のエラーが消えている。`detectHeaderLikelihood`, `scanForMojibake` など既存の未解決エラーは残ってよい（今回の変更由来の新エラーがないことを確認）。

- [ ] **Step 3: 差分のエラー数を確認する**

```bash
# 既存エラー数の記録（事前）と比較
npm run typecheck 2>&1 | grep "error TS" | wc -l
```

今回の変更前は 9 件（typecheck 確認済み）。追加されたエラーがないことを確認。

- [ ] **Step 4: コミット（必要であれば最終整理）**

全テストが通っていれば以下を実行：

```bash
git status
# 未コミットのファイルがあればここでコミットする
```

---

## 実装上の注意点・仮置き

1. **`columnNames` の取得元** — 現在は `executeRun()` で `ingestFile()` を呼ぶ際に `ir.columns` を取得する。ただし、`rerun-with-review` で実行した run も `ingestFile` を呼ぶため、自動的に `columnNames` が保存される。

2. **既存 run の `columnNames`** — 過去の run には `columnNames` がない。`previousColumnNames` が `null` の場合、`addedColumns` と `removedColumns` は空配列になる（安全側に倒す）。

3. **drift サマリブロックの表示条件** — `addedColumns.length > 0 || removedColumns.length > 0 || schemaDriftWarningShown` が true のとき表示。`schemaDriftWarningShown` だけ true で差分が計算できない場合は「前回と列の形が変わっています」とだけ表示する。

4. **new column バッジの並び順** — 既存フォーム構造を変えないため、新しい列が上部に来るわけではない（仮置き）。重点確認列を先頭に移動する機能は後回し。

5. **`effectiveMapping` option エラー** — `server.ts` line 610 の `effectiveMapping` オプションは `executeRun` の型定義にまだ存在しない（既存エラー）。今回は触らない。

## 未解決・次にやるべきこと

1. `detectHeaderLikelihood`, `scanForMojibake` の定義追加 → server.ts の既存エラー解消
2. `executeRun` の `effectiveMapping` オプションを型定義に追加
3. drift があるとき「新しい列を先に表示する」ソートの実装
4. 前回の run で effective mapping が保存されている場合、その `sourceHeader` を `columnNames` のフォールバックとして使う

---

## 受け入れ確認チェックリスト

- [ ] `npm test` が全 PASS（既存テスト + 追加テスト）
- [ ] `npm run typecheck` で effective-mapping 由来エラーが消えている
- [ ] schema drift 後の `/runs/:id/columns` で前回との差分サマリが表示される
- [ ] 増えた列に「新しい列」バッジが付く
- [ ] なくなった列がサマリに列挙される
- [ ] 「前回の結果を見る」リンクがある
- [ ] 差分がない場合（first_import）はサマリブロックが表示されない
- [ ] 既存の列レビューフォームが壊れていない
