# Candidate Profile 生成・保存・再利用 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 列レビュー結果から「仮のファイル設定」(candidate profile) を生成・JSON 保存し、次回 upload 時の候補提示に再利用できるようにする。

**Architecture:** 3層設計（review → effective mapping → candidate profile）を維持しつつ、candidate profile を `dataDir/candidate-profiles/` に独立した JSON として保存する。`loadProfiles()` が candidate も読み込むことで、既存の `matchProfile()` が自動的に candidate を候補に含めるようになる。

**Tech Stack:** TypeScript, Node.js fs (sync), Express, Vanilla JS (app.js SPA), Vitest

---

## ファイル構成

| 操作 | パス | 役割 |
|------|------|------|
| 新規作成 | `src/file-profiles/candidate-profile.ts` | buildCandidateProfile, 永続化関数, 型ガード |
| 修正 | `src/file-profiles/types.ts` | CandidateProfile インターフェース追加 |
| 修正 | `src/file-profiles/index.ts` | loadProfiles に candidate 読込を追加、candidate 関数を re-export |
| 修正 | `src/ui/server.ts` | POST /api/runs/:id/save-candidate-profile エンドポイント追加 |
| 修正 | `src/ui/public/app.js` | 「この設定を次回も使えるようにする」ボタン追加、仮の設定バッジ追加 |
| 新規作成 | `test/file-profiles/candidate-profile.test.ts` | candidate profile のテスト |

---

## Task 1: CandidateProfile 型定義

**Files:**
- Modify: `src/file-profiles/types.ts`

- [ ] **Step 1: FileProfile に `candidate` オプション フィールドを追加し、CandidateProfile インターフェースを定義する**

`src/file-profiles/types.ts` の末尾（`UploadConfirmation` の前）に追加：

```typescript
/**
 * 現場の列レビューから自動生成された「仮のファイル設定」。
 * seed profile を直接上書きせず、独立した JSON として保存する。
 */
export interface CandidateProfile extends FileProfile {
  /** candidate であることを示すフラグ（seed との判別用） */
  candidate: true;
  /** 生成元の run ID */
  generatedFromRunId: string;
  /** 生成日時（ISO 8601） */
  generatedAt: string;
  /** アップロード元のファイル名（UI 表示用） */
  sourceFilename: string;
}
```

- [ ] **Step 2: TypeScript ビルドで型エラーがないことを確認**

```bash
npx tsc --noEmit 2>&1 | grep 'candidate-profile\|types.ts' | head -20
```

Expected: candidate-profile や types.ts に関する新しいエラーがない

- [ ] **Step 3: Commit**

```bash
git add src/file-profiles/types.ts
git commit -m "feat: add CandidateProfile interface to types.ts"
```

---

## Task 2: buildCandidateProfile と永続化関数の実装

**Files:**
- Create: `src/file-profiles/candidate-profile.ts`
- Create: `test/file-profiles/candidate-profile.test.ts`

- [ ] **Step 1: テストファイルを作成する（失敗するテストを書く）**

`test/file-profiles/candidate-profile.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCandidateProfile,
  saveCandidateProfile,
  loadAllCandidateProfiles,
  isCandidateProfile,
} from '../../src/file-profiles/candidate-profile.js';
import type { EffectiveMappingResult } from '../../src/core/effective-mapping.js';

const TMP_DIR = join(import.meta.dirname, '..', 'output-candidate-profile-test');

const sampleEffectiveMapping: EffectiveMappingResult = {
  runId: 'run-001',
  profileId: 'customer-list',
  generatedAt: '2026-04-01T00:00:00.000Z',
  mapping: { '会社名': 'company_name', '電話番号': 'phone' },
  activeCount: 2,
  unusedCount: 1,
  pendingCount: 0,
  columns: [
    { position: 0, sourceHeader: '会社名', canonicalKey: 'company_name', label: '取引先', status: 'active', required: 'yes' },
    { position: 1, sourceHeader: '電話番号', canonicalKey: 'phone', label: '電話番号', status: 'active', required: 'no' },
    { position: 2, sourceHeader: '旧フラグ', canonicalKey: 'old_flag', label: '旧フラグ', status: 'unused', required: 'no' },
  ],
};

describe('buildCandidateProfile', () => {
  it('effective mapping から candidate profile を生成できる', () => {
    const candidate = buildCandidateProfile(
      'run-001',
      '顧客一覧_2024.csv',
      sampleEffectiveMapping,
      { label: '顧客一覧（仮）', defaultEncoding: 'cp932', defaultHasHeader: true },
    );

    expect(candidate.id).toBe('candidate-run-001-customer-list');
    expect(candidate.candidate).toBe(true);
    expect(candidate.provisional).toBe(true);
    expect(candidate.generatedFromRunId).toBe('run-001');
    expect(candidate.sourceFilename).toBe('顧客一覧_2024.csv');
    expect(candidate.label).toBe('顧客一覧（仮）');
    expect(candidate.defaultEncoding).toBe('cp932');
    expect(candidate.defaultHasHeader).toBe(true);
    expect(candidate.category).toBe('生成された設定');
  });

  it('全列（active/unused/pending）が columns に含まれる', () => {
    const candidate = buildCandidateProfile('run-001', '顧客一覧.csv', sampleEffectiveMapping, {});
    expect(candidate.columns).toHaveLength(3);
  });

  it('active 列の position が previewColumns に含まれる（最大4件）', () => {
    const candidate = buildCandidateProfile('run-001', 'test.csv', sampleEffectiveMapping, {});
    // active: position 0, 1
    expect(candidate.previewColumns).toContain(0);
    expect(candidate.previewColumns).toContain(1);
    expect(candidate.previewColumns).not.toContain(2); // unused は除外
    expect(candidate.previewColumns.length).toBeLessThanOrEqual(4);
  });

  it('sourceHeader が ColumnDef.headerHints に含まれる', () => {
    const candidate = buildCandidateProfile('run-001', 'test.csv', sampleEffectiveMapping, {});
    const col0 = candidate.columns.find(c => c.position === 0)!;
    expect(col0.headerHints).toContain('会社名');
    expect(col0.key).toBe('company_name');
    expect(col0.label).toBe('取引先'); // effective mapping の label
    expect(col0.required).toBe(true); // required='yes'
  });

  it('ファイル名からファイル名ヒントを生成する', () => {
    const candidate = buildCandidateProfile('run-001', '顧客一覧_2024.csv', sampleEffectiveMapping, {});
    expect(candidate.filenameHints.some(h => h.includes('顧客一覧_2024'))).toBe(true);
  });

  it('label 未指定の場合は sourceFilename のステムを使う', () => {
    const candidate = buildCandidateProfile('run-001', '顧客一覧.csv', sampleEffectiveMapping, {});
    expect(candidate.label).toBe('顧客一覧');
  });
});

describe('isCandidateProfile', () => {
  it('candidate: true のプロファイルを判定できる', () => {
    const candidate = buildCandidateProfile('run-001', 'test.csv', sampleEffectiveMapping, {});
    expect(isCandidateProfile(candidate)).toBe(true);
  });

  it('seed profile（candidate フィールドなし）は false を返す', () => {
    const seed = {
      id: 'customer-list',
      label: '顧客一覧',
      filenameHints: [],
      defaultEncoding: 'cp932' as const,
      defaultHasHeader: true,
      columns: [],
      previewColumns: [],
      category: '顧客管理系',
      provisional: true,
    };
    expect(isCandidateProfile(seed)).toBe(false);
  });
});

describe('candidate profile persistence', () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('保存して loadAllCandidateProfiles で読み込める', () => {
    const candidate = buildCandidateProfile('run-save-01', 'test.csv', sampleEffectiveMapping, {});
    saveCandidateProfile(TMP_DIR, candidate);

    const all = loadAllCandidateProfiles(TMP_DIR);
    expect(all.length).toBeGreaterThanOrEqual(1);
    const found = all.find(p => p.id === candidate.id);
    expect(found).toBeDefined();
    expect(found!.candidate).toBe(true);
    expect(found!.generatedFromRunId).toBe('run-save-01');
  });

  it('ディレクトリが存在しない場合は空配列を返す', () => {
    const result = loadAllCandidateProfiles('/tmp/nonexistent-candidate-test-dir-xyz');
    expect(result).toEqual([]);
  });

  it('複数の candidate を保存して全件取得できる', () => {
    const mapping2: EffectiveMappingResult = {
      ...sampleEffectiveMapping,
      runId: 'run-002',
      profileId: 'apo-list',
    };
    const c1 = buildCandidateProfile('run-002a', 'file-a.csv', sampleEffectiveMapping, {});
    const c2 = buildCandidateProfile('run-002b', 'file-b.csv', mapping2, {});
    saveCandidateProfile(TMP_DIR, c1);
    saveCandidateProfile(TMP_DIR, c2);

    const all = loadAllCandidateProfiles(TMP_DIR);
    const ids = all.map(p => p.id);
    expect(ids).toContain(c1.id);
    expect(ids).toContain(c2.id);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/file-profiles/candidate-profile.test.ts 2>&1 | tail -10
```

Expected: `Cannot find module '../../src/file-profiles/candidate-profile.js'` のようなエラー

- [ ] **Step 3: candidate-profile.ts を実装する**

`src/file-profiles/candidate-profile.ts`:

```typescript
/**
 * Candidate Profile — 列レビューから自動生成した「仮のファイル設定」。
 *
 * - seed profile を直接上書きしない
 * - dataDir/candidate-profiles/{id}.json に保存
 * - provisional: true, candidate: true で明示
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { FileProfile, ColumnDef, CandidateProfile } from './types.js';
import type { EffectiveMappingResult } from '../core/effective-mapping.js';

// --- Type Guard ---

export function isCandidateProfile(profile: FileProfile): profile is CandidateProfile {
  return (profile as CandidateProfile).candidate === true;
}

// --- Build ---

/**
 * 列レビュー結果（effective mapping）から candidate profile を生成する。
 *
 * @param runId - 生成元 run ID
 * @param sourceFilename - アップロード元のファイル名（basename のみ）
 * @param em - 保存済み effective mapping
 * @param overrides - UI から渡す上書き値（label, defaultEncoding, defaultHasHeader）
 */
export function buildCandidateProfile(
  runId: string,
  sourceFilename: string,
  em: EffectiveMappingResult,
  overrides: {
    label?: string;
    defaultEncoding?: 'cp932' | 'utf8' | 'auto';
    defaultHasHeader?: boolean;
  },
): CandidateProfile {
  const stem = basename(sourceFilename, extname(sourceFilename));

  // ID は runId + profileId から決定論的に生成（重複保存を防ぐ）
  const id = `candidate-${runId}-${em.profileId}`;

  // ファイル名ヒント: stem ベースの glob パターン
  const filenameHints = [`${stem}*`, `*${stem}*`];

  // 全列を ColumnDef に変換（active/unused/pending すべて含める）
  // ヘッダーヒントに sourceHeader を登録することでマッチング精度を上げる
  const columns: ColumnDef[] = em.columns.map(col => ({
    position: col.position,
    label: col.label,
    key: col.canonicalKey,
    required: col.required === 'yes',
    headerHints: [col.sourceHeader],
  }));

  // previewColumns: active 列の position 先頭4件
  const previewColumns = em.columns
    .filter(c => c.status === 'active')
    .slice(0, 4)
    .map(c => c.position);

  const label = overrides.label || stem;

  return {
    id,
    label,
    filenameHints,
    defaultEncoding: overrides.defaultEncoding ?? 'auto',
    defaultHasHeader: overrides.defaultHasHeader ?? true,
    columns,
    previewColumns,
    category: '生成された設定',
    provisional: true,
    candidate: true,
    generatedFromRunId: runId,
    generatedAt: new Date().toISOString(),
    sourceFilename,
  };
}

// --- Persistence ---

function getCandidateDir(dataDir: string): string {
  return join(dataDir, 'candidate-profiles');
}

/** candidate profile を JSON ファイルとして保存する */
export function saveCandidateProfile(dataDir: string, profile: CandidateProfile): void {
  const dir = getCandidateDir(dataDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${profile.id}.json`),
    JSON.stringify(profile, null, 2),
    'utf-8',
  );
}

/** dataDir/candidate-profiles/ から全 candidate profile を読み込む */
export function loadAllCandidateProfiles(dataDir: string): CandidateProfile[] {
  const dir = getCandidateDir(dataDir);
  if (!existsSync(dir)) return [];

  const results: CandidateProfile[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      if (data.candidate === true) {
        results.push(data as CandidateProfile);
      }
    } catch {
      // 壊れたファイルはスキップ
    }
  }
  return results;
}
```

- [ ] **Step 4: テストを実行して全件パスを確認**

```bash
npx vitest run test/file-profiles/candidate-profile.test.ts 2>&1 | tail -20
```

Expected: 全テスト PASS

- [ ] **Step 5: Commit**

```bash
git add src/file-profiles/candidate-profile.ts test/file-profiles/candidate-profile.test.ts
git commit -m "feat: add buildCandidateProfile, persistence, and type guard"
```

---

## Task 3: loadProfiles に candidate profile 読込を組み込む

**Files:**
- Modify: `src/file-profiles/index.ts`

- [ ] **Step 1: 既存の file-profiles テストを確認して壊していないかチェックできるようにする**

```bash
npx vitest run test/file-profiles/file-profiles.test.ts 2>&1 | tail -10
```

Expected: 現在の状態で PASS している

- [ ] **Step 2: index.ts を修正する**

`src/file-profiles/index.ts` の以下を変更：

**インポート追加**（既存インポートの後に追記）:
```typescript
import { loadAllCandidateProfiles, isCandidateProfile, buildCandidateProfile, saveCandidateProfile } from './candidate-profile.js';
import type { CandidateProfile } from './types.js';
```

**export に追加**（ファイル先頭の export ブロック）:
```typescript
export { isCandidateProfile, buildCandidateProfile, saveCandidateProfile } from './candidate-profile.js';
export type { CandidateProfile } from './types.js';
```

**loadProfiles を修正**（candidate も読み込む）:

```typescript
/** Load user-saved profiles from disk, merging with seeds */
export function loadProfiles(dataDir: string): FileProfile[] {
  // 1. seed をベースにする
  let base: FileProfile[] = [...SEED_PROFILES];

  // 2. user-saved profiles（file-profiles.json）でシードを上書き
  const filePath = join(dataDir, 'file-profiles.json');
  if (existsSync(filePath)) {
    try {
      const saved: FileProfile[] = JSON.parse(readFileSync(filePath, 'utf-8'));
      const savedIds = new Set(saved.map(p => p.id));
      base = [
        ...saved,
        ...SEED_PROFILES.filter(s => !savedIds.has(s.id)),
      ];
    } catch {
      base = [...SEED_PROFILES];
    }
  }

  // 3. candidate profiles（candidate-profiles/*.json）を追加
  // candidate の ID は "candidate-{runId}-{profileId}" なので seed と衝突しない
  const candidates = loadAllCandidateProfiles(dataDir);
  const baseIds = new Set(base.map(p => p.id));
  const newCandidates = candidates.filter(c => !baseIds.has(c.id));

  registry = [...base, ...newCandidates];
  return registry;
}
```

- [ ] **Step 3: テストを実行して既存テストが壊れていないことを確認**

```bash
npx vitest run test/file-profiles/file-profiles.test.ts test/file-profiles/candidate-profile.test.ts 2>&1 | tail -20
```

Expected: 全テスト PASS

- [ ] **Step 4: Commit**

```bash
git add src/file-profiles/index.ts
git commit -m "feat: loadProfiles now includes candidate-profiles dir in registry"
```

---

## Task 4: API エンドポイント追加

**Files:**
- Modify: `src/ui/server.ts`

- [ ] **Step 1: server.ts のインポートに candidate 関連を追加**

`src/ui/server.ts` の既存インポートを修正：

```typescript
import {
  loadProfiles, getProfiles, getProfileById, matchProfile,
  saveProfiles, saveColumnReview, loadColumnReview,
  buildCandidateProfile, saveCandidateProfile, isCandidateProfile,
} from '../file-profiles/index.js';
import type { FileProfile, ColumnReviewEntry, CandidateProfile } from '../file-profiles/index.js';
```

- [ ] **Step 2: `/runs/:id/save-candidate-profile` エンドポイントを追加**

`src/ui/server.ts` の `app.post('/api/runs/:id/rerun-with-review', ...)` ブロックの**直後**に追加：

```typescript
  // --- API: 列レビューから candidate profile を生成・保存 ---
  app.post('/api/runs/:id/save-candidate-profile', async (req, res) => {
    try {
      const runId = req.params.id;
      const { profileId, label } = req.body as { profileId?: string; label?: string };
      if (!profileId) {
        return res.status(400).json({ error: 'profileId が必要です' });
      }

      const run = getRun(baseOutputDir, runId);
      if (!run) return res.status(404).json({ error: 'Run が見つかりません' });

      const em = loadEffectiveMapping(baseOutputDir, runId, profileId);
      if (!em) {
        return res.status(404).json({
          error: '列レビューの回答が見つかりません。先に列の確認を保存してください。',
        });
      }

      // 元ファイル名を basename で取得
      const sourceFilename = run.inputFiles.length > 0
        ? run.inputFiles[0].split('/').pop() ?? 'unknown.csv'
        : 'unknown.csv';

      const candidate = buildCandidateProfile(runId, sourceFilename, em, { label });
      saveCandidateProfile(baseOutputDir, candidate);

      // registry を更新（次回の matchProfile に反映）
      loadProfiles(baseOutputDir);

      res.json({ id: candidate.id, label: candidate.label, saved: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '保存に失敗しました' });
    }
  });
```

- [ ] **Step 3: server のテストを実行して既存テストが壊れていないことを確認**

```bash
npx vitest run test/ui/server.test.ts 2>&1 | tail -20
```

Expected: 既存テストが PASS（新しいエンドポイントのテストはまだ書いていない）

- [ ] **Step 4: column-status API テストでエンドポイント動作を確認（スモークテスト）**

```bash
npx vitest run test/ui/server.test.ts 2>&1 | grep -E 'PASS|FAIL|error' | head -10
```

- [ ] **Step 5: Commit**

```bash
git add src/ui/server.ts
git commit -m "feat: add POST /api/runs/:id/save-candidate-profile endpoint"
```

---

## Task 5: API エンドポイントのテストを追加

**Files:**
- Modify: `test/ui/server.test.ts`

- [ ] **Step 1: 既存テストの構造を確認**

```bash
head -80 test/ui/server.test.ts
```

テストの setup パターン（tmpDir, createApp など）を把握する。

- [ ] **Step 2: save-candidate-profile のテストを追加**

`test/ui/server.test.ts` の最後に以下を追加：

```typescript
// --- POST /api/runs/:id/save-candidate-profile ---

describe('POST /api/runs/:id/save-candidate-profile', () => {
  // このテストは事前に run と effective mapping が必要
  // setup: run を作成し、effective mapping を保存してから候補保存をテスト

  it('effective mapping がない場合は 404 を返す', async () => {
    const res = await request(app)
      .post('/api/runs/nonexistent-run/save-candidate-profile')
      .send({ profileId: 'customer-list' });
    // run が存在しないので 404
    expect(res.status).toBe(404);
  });

  it('profileId が未指定の場合は 400 を返す', async () => {
    const res = await request(app)
      .post('/api/runs/some-run/save-candidate-profile')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/profileId/);
  });
});
```

> **Note:** `app` と `request` は既存テストの setup に合わせて変数名を調整すること。existing test ファイルの先頭 80 行を確認してから追記する。

- [ ] **Step 3: テストを実行**

```bash
npx vitest run test/ui/server.test.ts 2>&1 | tail -20
```

Expected: 新しいテストを含めて PASS

- [ ] **Step 4: Commit**

```bash
git add test/ui/server.test.ts
git commit -m "test: add save-candidate-profile endpoint tests"
```

---

## Task 6: UI — 「この設定を保存」ボタンと「仮の設定」バッジ

**Files:**
- Modify: `src/ui/public/app.js`

- [ ] **Step 1: loadColumnStatusCard に保存ボタンを追加**

`app.js` の `loadColumnStatusCard` 関数内、`<div style="display:flex;gap:8px;flex-wrap:wrap">` ブロックを以下に置き換える：

```javascript
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a href="/runs/${escapeHtml(runId)}/columns" class="btn btn-primary">列の確認を再開</a>
          <button
            class="btn"
            id="btn-save-candidate"
            onclick="saveCandidateFromRun('${escapeHtml(runId)}', '${escapeHtml(entry.profileId)}')"
            title="この列の設定を次回も使えるように保存します"
          >この設定を保存</button>
        </div>
        <p id="save-candidate-msg" style="font-size:11px;color:var(--text-secondary);margin-top:4px;display:none"></p>
```

- [ ] **Step 2: saveCandidateFromRun 関数を追加**

`app.js` の `loadColumnStatusCard` 関数の**後ろ**（`// --- Tab content loading ---` の前）に追加：

```javascript
async function saveCandidateFromRun(runId, profileId) {
  const btn = document.getElementById('btn-save-candidate');
  const msg = document.getElementById('save-candidate-msg');
  if (!btn || !msg) return;

  btn.disabled = true;
  btn.textContent = '保存中...';

  try {
    const result = await api(`/api/runs/${runId}/save-candidate-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    });
    btn.textContent = '保存済み ✓';
    msg.textContent = 'この設定は次回も候補として表示されます';
    msg.style.display = 'block';
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'この設定を保存';
    msg.textContent = '保存に失敗しました。もう一度お試しください。';
    msg.style.display = 'block';
    msg.style.color = 'var(--danger)';
  }
}
```

- [ ] **Step 3: api() ヘルパーが POST に対応しているか確認**

```bash
grep -n 'async function api\|function api' src/ui/public/app.js | head -5
```

既存の `api()` 関数が fetch options を受け取る形になっているか確認する。もし GET のみの場合は以下の形に修正：

```javascript
async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 4: upload confirm ページに「仮の設定」バッジを追加**

`app.js` の `renderConfirmPage` 関数内、プロファイル名を表示している箇所を探す。
`matchProfile` の結果を表示する HTML に以下のバッジを追加：

```javascript
// profile.candidate が true の場合のバッジ
const candidateBadge = profileMatch.profile?.candidate
  ? '<span style="font-size:10px;background:var(--warning,#f0ad4e);color:#fff;padding:1px 6px;border-radius:4px;margin-left:6px">仮の設定</span>'
  : '';
```

バッジを既存のプロファイルラベル表示の隣に配置する。

- [ ] **Step 5: ブラウザで動作確認（手動）**

1. `npm run dev`（または `node dist/cli/index.js ui`）を起動
2. ファイルをアップロード → run を実行
3. run 詳細 → 「列の確認」を開いて回答を保存
4. run 詳細に戻り「列の確認状況」カードの「この設定を保存」ボタンをクリック
5. 「保存済み ✓」と表示されることを確認
6. 別のファイルをアップロードし、同じファイル名を使うと「仮の設定」バッジが表示されることを確認

- [ ] **Step 6: Commit**

```bash
git add src/ui/public/app.js
git commit -m "feat: add save-candidate button in column-status card and candidate badge in upload confirm"
```

---

## Task 7: 全体検証

**Files:** なし（検証のみ）

- [ ] **Step 1: TypeScript ビルドチェック**

```bash
npx tsc --noEmit 2>&1 | grep -v 'detectHeaderLikelihood\|scanForMojibake\|bundleDir' | head -30
```

Expected: 今回追加した変更に起因する新しいエラーがないこと
（既存の detectHeaderLikelihood / scanForMojibake / bundleDir エラーは無視）

- [ ] **Step 2: 全テストを実行**

```bash
npx vitest run 2>&1 | tail -30
```

Expected: 既存テストが壊れていない。新しいテストが PASS している。

- [ ] **Step 3: 今回の変更に起因する新しい失敗を確認**

```bash
npx vitest run 2>&1 | grep -E 'FAIL|× ' | head -20
```

Expected: 今回追加した変更が原因の FAIL がないこと

- [ ] **Step 4: eslint チェック（もし設定されている場合）**

```bash
npx eslint src/file-profiles/candidate-profile.ts src/ui/server.ts 2>&1 | head -30
```

- [ ] **Step 5: 最終 Commit**

```bash
git status
git add -A
git commit -m "feat: candidate profile generation from column review — end-to-end"
```

---

## 設計メモ

### 3層の整理

| 層 | ファイル | 役割 |
|---|---|---|
| review | `dataDir/column-reviews/{runId}_{profileId}.json` | 現場の回答（正） |
| effective mapping | `dataDir/column-reviews/effective/{runId}_{profileId}.json` | run-scoped 実効結果 |
| candidate profile | `dataDir/candidate-profiles/candidate-{runId}-{profileId}.json` | 再利用用成果物 |

### candidate profile の ID

`candidate-{runId}-{profileId}` で決定論的に生成。
同じ run の同じ profileId で再保存すると上書きになる（意図的）。

### matchProfile との統合

`loadProfiles()` が candidate も registry に追加するため、`matchProfile()` は変更なしで candidate を候補に含める。

### 既存エラーとの切り分け

以下は今回の変更と無関係な既存エラー：
- `detectHeaderLikelihood` — server.ts のインポート不足（別タスク）
- `scanForMojibake` — 同上
- `bundleDir` — bundleDir オプション関連（別タスク）

TypeScript チェック時はこれらをフィルタして確認する。
