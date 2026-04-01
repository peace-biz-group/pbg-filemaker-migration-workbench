# Headerless Known File Matching 強化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ヘッダーなし CSV でも built-in / candidate profile が known file 候補として安定して出やすくなるよう、matchProfile の判定材料を強化する

**Architecture:** `matchProfile` に column count と isHeaderless オプションを追加し、filename hint + column count の2つを主要判定材料とする。FileProfile 型に `columnCount` と `headerlessSuitable` を任意フィールドとして追加（後方互換）。upload-identify API でこれらの情報を渡す。UI は理由を現場向け日本語で表示する。

**Tech Stack:** TypeScript, Vitest, Express（既存スタックのみ）

---

## ファイル構成

| ファイル | 変更内容 |
|---------|---------|
| `src/file-profiles/types.ts` | `FileProfile` に `columnCount?: number`, `headerlessSuitable?: boolean` を追加 |
| `src/file-profiles/index.ts` | `matchProfile` に `options?: { isHeaderless?: boolean; columnCount?: number }` を追加、列数スコアリングとヘッダーなしボーナスを実装 |
| `src/file-profiles/candidate-profile.ts` | `buildCandidateProfile` の overrides に `headerlessSuitable?` を追加、`columnCount` を自動設定 |
| `src/ui/server.ts` | `upload-identify` で `isHeaderless` / `columnCount` を `matchProfile` に渡す |
| `src/ui/public/app.js` | confirm 画面の候補理由表示を改善（日本語ヒント表示） |
| `test/file-profiles/file-profiles.test.ts` | 列数スコアリング・ヘッダーなし判定のテストを追加 |
| `test/file-profiles/candidate-profile.test.ts` | `columnCount` / `headerlessSuitable` のテストを追加 |

---

## Task 1: FileProfile 型に columnCount / headerlessSuitable を追加

**Files:**
- Modify: `src/file-profiles/types.ts:40-59`

- [ ] **Step 1: 型定義を変更する**

`FileProfile` インターフェースに2つの任意フィールドを追加する。既存のフィールドはそのまま。

```typescript
/** ファイルプロファイル */
export interface FileProfile {
  /** 一意の識別子 */
  id: string;
  /** 日本語ラベル（「顧客一覧」など） */
  label: string;
  /** ファイル名マッチング用ヒント（glob-like パターン） */
  filenameHints: string[];
  /** 既定の文字コード */
  defaultEncoding: 'cp932' | 'utf8' | 'auto';
  /** 既定のヘッダー有無 */
  defaultHasHeader: boolean;
  /** 位置ベース列定義 */
  columns: ColumnDef[];
  /** プレビューで見せる主要列の position */
  previewColumns: number[];
  /** カテゴリ（管理用） */
  category: string;
  /** 仮置きフラグ — true なら seed データで未確認 */
  provisional: boolean;
  /**
   * このプロファイルが想定する列数。
   * 未設定の場合は columns.length を参照する。
   * ヘッダーなし CSV とのマッチング精度向上に使う。
   */
  columnCount?: number;
  /**
   * ヘッダーなし CSV に適しているか。
   * true のときはヘッダーなしファイルとのマッチスコアにボーナスを加算する。
   */
  headerlessSuitable?: boolean;
}
```

- [ ] **Step 2: ビルドが通ることを確認する**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx tsc --noEmit 2>&1 | grep -E "^src/file-profiles/types" | head -20
```

Expected: 型ファイル自体にエラーなし（既存エラーがある場合はその旨を記録するだけでよい）

- [ ] **Step 3: Commit**

```bash
git add src/file-profiles/types.ts
git commit -m "feat: add columnCount and headerlessSuitable to FileProfile type"
```

---

## Task 2: matchProfile に列数スコアリングとヘッダーなしボーナスを追加

**Files:**
- Modify: `src/file-profiles/index.ts:104-173`
- Test: `test/file-profiles/file-profiles.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`test/file-profiles/file-profiles.test.ts` の `describe('matchProfile')` ブロックの末尾に以下を追加する。

```typescript
describe('headerless / column count matching', () => {
  it('列数が一致する場合スコアが上がる（ヘッダーなし、ファイル名が一致しない場合）', () => {
    // customer-list は 6 列
    const result = matchProfile('data_export.csv', [], { columnCount: 6 });
    // スコアは上がるが confidence は low 止まり（filename もヘッダーも一致しない）
    expect(result.profile).not.toBeNull();
    expect(['low', 'medium']).toContain(result.confidence);
  });

  it('列数が大きくズレると候補が弱くなる（または落ちる）', () => {
    // 6 列プロファイルに対して 1 列ファイルを渡す
    const result6 = matchProfile('data.csv', [], { columnCount: 6 });
    const result1 = matchProfile('data.csv', [], { columnCount: 1 });
    const score6 = result6.profile ? (result6.confidence === 'high' ? 3 : result6.confidence === 'medium' ? 2 : 1) : 0;
    const score1 = result1.profile ? (result1.confidence === 'high' ? 3 : result1.confidence === 'medium' ? 2 : 1) : 0;
    // 列数が一致する方が同等かそれ以上のスコア
    expect(score6).toBeGreaterThanOrEqual(score1);
  });

  it('ヘッダーなしファイルで headerlessSuitable プロファイルがボーナスを得る', () => {
    // registry にヘッダーなし適合プロファイルを追加してテスト
    const { saveProfiles, getProfiles } = await import('../../src/file-profiles/index.js');
    const profiles = getProfiles();
    const headerlessProfile: FileProfile = {
      id: 'test-headerless',
      label: 'ヘッダーなしテスト',
      filenameHints: [],
      defaultEncoding: 'cp932',
      defaultHasHeader: false,
      columns: [
        { position: 0, label: '会社名', key: 'company_name', required: true },
        { position: 1, label: '電話番号', key: 'phone', required: false },
      ],
      previewColumns: [0, 1],
      category: 'テスト',
      provisional: true,
      columnCount: 2,
      headerlessSuitable: true,
    };
    saveProfiles(TMP_DIR, [...profiles, headerlessProfile]);

    const result = matchProfile('data.csv', [], { isHeaderless: true, columnCount: 2 });
    // headerlessSuitable プロファイルが candidates に含まれるはず
    const allCandidates = [result.profile, ...result.alternatives.map(a => a.profile)].filter(Boolean);
    expect(allCandidates.some(p => p?.id === 'test-headerless')).toBe(true);
  });

  it('ファイル名が一致し列数も一致する場合、最高スコアになる', () => {
    // customer-list は filename で +100、column count 一致で +25
    const result = matchProfile('顧客一覧.csv', [], { columnCount: 6 });
    expect(result.profile?.id).toBe('customer-list');
    expect(result.confidence).toBe('high');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx vitest run test/file-profiles/file-profiles.test.ts 2>&1 | tail -30
```

Expected: `headerless / column count matching` の一部テストが FAIL

- [ ] **Step 3: matchProfile の実装を変更する**

`src/file-profiles/index.ts` の `matchProfile` 関数を以下に変更する。

```typescript
/**
 * ファイル名・列名・列数からプロファイル候補をマッチングする。
 *
 * マッチング優先度:
 * 1. ファイル名ヒント一致（高信頼、+100）
 * 2. 列ヘッダーヒント一致（中信頼、補助、max +50）— ヘッダーありファイル向け
 * 3. 列数近似（+25/+15/+8）— ヘッダーなしファイルでも有効
 * 4. ヘッダーなしファイル × headerlessSuitable プロファイル（+20）
 * 5. マッチなし → 新規ファイル
 */
export function matchProfile(
  filename: string,
  columns: string[],
  options?: { isHeaderless?: boolean; columnCount?: number },
): ProfileMatchResult {
  const name = basename(filename);
  const { isHeaderless = false, columnCount } = options ?? {};
  const scored: Array<{ profile: FileProfile; score: number; reason: string }> = [];

  for (const profile of registry) {
    let score = 0;
    const reasons: string[] = [];

    // 1. Filename hint match (+100)
    for (const hint of profile.filenameHints) {
      if (globMatch(hint, name)) {
        score += 100;
        reasons.push('ファイル名が近い');
        break;
      }
    }

    // 2. Header hint match (max +50) — ヘッダーありの場合のみ有効
    if (!isHeaderless && columns.length > 0) {
      let headerMatches = 0;
      for (const colDef of profile.columns) {
        if (!colDef.headerHints) continue;
        for (const hint of colDef.headerHints) {
          if (columns.some(c => c.trim() === hint)) {
            headerMatches++;
            break;
          }
        }
      }
      if (headerMatches > 0) {
        const matchRatio = headerMatches / profile.columns.length;
        score += Math.round(matchRatio * 50);
        reasons.push(`列名が ${headerMatches} 件一致`);
      }
    }

    // 3. Column count scoring (+25/+15/+8)
    // profile.columnCount があればそちらを使い、なければ profile.columns.length にフォールバック
    if (columnCount !== undefined && columnCount > 0) {
      const expected = profile.columnCount ?? profile.columns.length;
      const diff = Math.abs(expected - columnCount);
      if (diff === 0) {
        score += 25;
        reasons.push('列の数が一致');
      } else if (diff <= 1) {
        score += 15;
        reasons.push('列の数が近い');
      } else if (diff <= 2) {
        score += 8;
        reasons.push('列の数がほぼ近い');
      }
      // diff > 2 はスコアなし
    }

    // 4. Headerless bonus (+20) — ヘッダーなしファイル × headerlessSuitable
    if (isHeaderless) {
      if (profile.headerlessSuitable === true) {
        score += 20;
        reasons.push('前に保存した設定が使えそうです');
      } else if (profile.defaultHasHeader === false) {
        score += 10;
        reasons.push('ヘッダーなし向けの設定');
      }
    }

    if (score > 0) {
      scored.push({ profile, score, reason: reasons.join('・') });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      profile: null,
      confidence: 'none',
      reason: '一致するファイル種別が見つかりませんでした',
      alternatives: [],
    };
  }

  const best = scored[0];
  const confidence = best.score >= 100 ? 'high' : best.score >= 30 ? 'medium' : 'low';

  return {
    profile: best.profile,
    confidence,
    reason: best.reason,
    alternatives: scored.slice(1).map(s => ({
      profile: s.profile,
      confidence: s.score >= 100 ? 'high' as const : s.score >= 30 ? 'medium' as const : 'low' as const,
      reason: s.reason,
    })),
  };
}
```

- [ ] **Step 4: テストを実行してパスを確認する**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx vitest run test/file-profiles/file-profiles.test.ts 2>&1 | tail -30
```

Expected: `headerless / column count matching` の全テストが PASS

ただし `ヘッダーなしファイルで headerlessSuitable プロファイルがボーナスを得る` テストは async import を使っているため、テスト構造の修正が必要な場合はインポート構造をトップレベルに移動する。

- [ ] **Step 5: Commit**

```bash
git add src/file-profiles/index.ts test/file-profiles/file-profiles.test.ts
git commit -m "feat: add column count scoring and headerless bonus to matchProfile"
```

---

## Task 3: buildCandidateProfile に columnCount / headerlessSuitable を追加

**Files:**
- Modify: `src/file-profiles/candidate-profile.ts:30-81`
- Test: `test/file-profiles/candidate-profile.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`test/file-profiles/candidate-profile.test.ts` の `describe('buildCandidateProfile')` ブロックの末尾に追加する。

```typescript
it('columnCount が em.columns.length と一致する', () => {
  const candidate = buildCandidateProfile('run-001', 'test.csv', sampleEffectiveMapping, {});
  // sampleEffectiveMapping.columns.length === 3
  expect(candidate.columnCount).toBe(3);
});

it('headerlessSuitable を override で指定できる', () => {
  const candidate = buildCandidateProfile(
    'run-001',
    'test.csv',
    sampleEffectiveMapping,
    { headerlessSuitable: true },
  );
  expect(candidate.headerlessSuitable).toBe(true);
});

it('headerlessSuitable 未指定の場合は defaultHasHeader=false から推定される', () => {
  const candidate = buildCandidateProfile(
    'run-001',
    'test.csv',
    sampleEffectiveMapping,
    { defaultHasHeader: false },
  );
  // defaultHasHeader: false の場合、headerlessSuitable は true になる
  expect(candidate.headerlessSuitable).toBe(true);
});

it('headerlessSuitable: true かつ defaultHasHeader: true は共存できる', () => {
  const candidate = buildCandidateProfile(
    'run-001',
    'test.csv',
    sampleEffectiveMapping,
    { headerlessSuitable: true, defaultHasHeader: true },
  );
  expect(candidate.headerlessSuitable).toBe(true);
  expect(candidate.defaultHasHeader).toBe(true);
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx vitest run test/file-profiles/candidate-profile.test.ts 2>&1 | tail -20
```

Expected: 追加した4テストが FAIL

- [ ] **Step 3: buildCandidateProfile を変更する**

`src/file-profiles/candidate-profile.ts` の `buildCandidateProfile` 関数の overrides 型と本体を変更する。

```typescript
/**
 * 列レビュー結果（effective mapping）から candidate profile を生成する。
 *
 * @param runId - 生成元 run ID
 * @param sourceFilename - アップロード元のファイル名（basename のみ）
 * @param em - 保存済み effective mapping
 * @param overrides - UI から渡す上書き値（label, defaultEncoding, defaultHasHeader, headerlessSuitable）
 */
export function buildCandidateProfile(
  runId: string,
  sourceFilename: string,
  em: EffectiveMappingResult,
  overrides: {
    label?: string;
    defaultEncoding?: 'cp932' | 'utf8' | 'auto';
    defaultHasHeader?: boolean;
    headerlessSuitable?: boolean;
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

  // defaultHasHeader が false の場合は headerlessSuitable を自動で true にする
  const resolvedDefaultHasHeader = overrides.defaultHasHeader ?? true;
  const resolvedHeaderlessSuitable =
    overrides.headerlessSuitable ?? (resolvedDefaultHasHeader === false ? true : undefined);

  return {
    id,
    label,
    filenameHints,
    defaultEncoding: overrides.defaultEncoding ?? 'auto',
    defaultHasHeader: resolvedDefaultHasHeader,
    columns,
    previewColumns,
    category: '生成された設定',
    provisional: true,
    candidate: true,
    generatedFromRunId: runId,
    generatedAt: new Date().toISOString(),
    sourceFilename,
    // ヘッダーなし CSV とのマッチング精度向上のため列数を記録
    columnCount: em.columns.length,
    // ヘッダーなし適合フラグ
    ...(resolvedHeaderlessSuitable !== undefined && { headerlessSuitable: resolvedHeaderlessSuitable }),
  };
}
```

- [ ] **Step 4: テストを実行してパスを確認する**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx vitest run test/file-profiles/candidate-profile.test.ts 2>&1 | tail -20
```

Expected: 全テスト PASS

- [ ] **Step 5: Commit**

```bash
git add src/file-profiles/candidate-profile.ts test/file-profiles/candidate-profile.test.ts
git commit -m "feat: add columnCount and headerlessSuitable to buildCandidateProfile"
```

---

## Task 4: upload-identify API でヘッダーなし情報を matchProfile に渡す

**Files:**
- Modify: `src/ui/server.ts:449`

- [ ] **Step 1: upload-identify の matchProfile 呼び出しを変更する**

`src/ui/server.ts` の `app.post('/api/upload-identify', ...)` 内の `matchProfile` 呼び出し部分を変更する。

変更前（約 449 行目）:
```typescript
const profileMatch = matchProfile(uploaded.originalname, ir.columns);
```

変更後:
```typescript
// ヘッダーなし CSV かどうかを判定（hasHeader=false で読み込んだ場合）
const isHeaderless = ir.diagnosis.headerApplied === false;
// 実際の列数を取得（ヘッダーなしの場合でもデータ列数は ingest で確定している）
const actualColumnCount = ir.columns.length;
const profileMatch = matchProfile(uploaded.originalname, ir.columns, {
  isHeaderless,
  columnCount: actualColumnCount,
});
```

- [ ] **Step 2: ビルドが通ることを確認する**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx tsc --noEmit 2>&1 | grep -E "^src/ui/server" | head -20
```

Expected: server.ts に新しいエラーが出ないこと

- [ ] **Step 3: Commit**

```bash
git add src/ui/server.ts
git commit -m "feat: pass isHeaderless and columnCount to matchProfile in upload-identify"
```

---

## Task 5: candidate profile のヘッダーなし判定テスト（matchProfile + loadProfiles 統合）

**Files:**
- Modify: `test/file-profiles/file-profiles.test.ts`

- [ ] **Step 1: 統合テストを追加する**

`test/file-profiles/file-profiles.test.ts` の末尾に新しい `describe` ブロックを追加する。

```typescript
describe('candidate profile + headerless matching', () => {
  it('保存済み candidate profile が filename + column count だけで候補に出る', () => {
    // candidate profile を作成して保存
    const { buildCandidateProfile, saveCandidateProfile } = await import('../../src/file-profiles/candidate-profile.js');
    // ↑ async import は describe/it の外では使えないので、テスト内で動的インポートせず
    // 代わりに既にインポート済みの SEED_PROFILES を使う
    // 実際は TMP_DIR に候補を書き込んで loadProfiles してから matchProfile するテスト
  });
});
```

注: 上記は async import の構造上の制約により、以下のように書き直す。

`test/file-profiles/file-profiles.test.ts` の先頭 import に追加:
```typescript
import {
  buildCandidateProfile,
  saveCandidateProfile,
} from '../../src/file-profiles/candidate-profile.js';
import type { EffectiveMappingResult } from '../../src/core/effective-mapping.js';
```

次に、ファイル末尾に以下の `describe` ブロックを追加:
```typescript
describe('candidate profile + headerless matching 統合', () => {
  const sampleEM: EffectiveMappingResult = {
    runId: 'run-headerless-001',
    profileId: 'call-history',
    generatedAt: '2026-04-01T00:00:00.000Z',
    mapping: { '電話番号': 'phone', '会社名': 'company_name' },
    activeCount: 2,
    unusedCount: 0,
    pendingCount: 0,
    columns: [
      { position: 0, sourceHeader: '電話番号', canonicalKey: 'phone', label: '電話番号', status: 'active', required: 'yes' },
      { position: 1, sourceHeader: '会社名', canonicalKey: 'company_name', label: '会社名', status: 'active', required: 'no' },
      { position: 2, sourceHeader: '日時', canonicalKey: 'call_datetime', label: '日時', status: 'active', required: 'yes' },
      { position: 3, sourceHeader: '結果', canonicalKey: 'result', label: '結果', status: 'active', required: 'no' },
    ],
  };

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    // candidate profile を保存して registry を更新
    const candidate = buildCandidateProfile(
      'run-headerless-001',
      'コール履歴_20260401.csv',
      sampleEM,
      { defaultHasHeader: false },
    );
    saveCandidateProfile(TMP_DIR, candidate);
    loadProfiles(TMP_DIR); // candidate を registry に反映
  });

  it('保存済み candidate profile が filename hint で候補に出る（ヘッダーなし CSV）', () => {
    // 同じファイル名パターンで matchProfile
    const result = matchProfile('コール履歴_20260402.csv', [], {
      isHeaderless: true,
      columnCount: 4,
    });
    expect(result.profile).not.toBeNull();
    // candidate または call-history が最上位に来るはず
    const topId = result.profile?.id;
    const isCallRelated = topId === 'call-history' || topId?.includes('run-headerless-001');
    expect(isCallRelated).toBe(true);
  });

  it('ヘッダーなし CSV でも known file 候補が出る（filename + column count）', () => {
    // ファイル名が全く違っても column count で候補が出る
    const result = matchProfile('output_20260401.csv', [], {
      isHeaderless: true,
      columnCount: 4,
    });
    // 何らかの profile が候補として返るはず（score > 0）
    const allCandidates = result.profile
      ? [result.profile, ...result.alternatives.map(a => a.profile)]
      : result.alternatives.map(a => a.profile);
    // 4列プロファイルが何らかの形で候補に含まれる
    expect(allCandidates.length).toBeGreaterThan(0);
  });

  it('列数が大きくズレると候補スコアが弱くなる', () => {
    // 4列プロファイルに対して 10 列ファイルを渡す
    const result4 = matchProfile('output.csv', [], { isHeaderless: true, columnCount: 4 });
    const result10 = matchProfile('output.csv', [], { isHeaderless: true, columnCount: 10 });
    // 4列一致の方が同等かそれ以上のスコア（同じファイル名なので比較可能）
    const toScore = (r: typeof result4) =>
      r.confidence === 'high' ? 3 : r.confidence === 'medium' ? 2 : r.confidence === 'low' ? 1 : 0;
    expect(toScore(result4)).toBeGreaterThanOrEqual(toScore(result10));
  });

  it('built-in と candidate が混在しても matchProfile が壊れない', () => {
    // TMP_DIR には seed + candidate が混在している
    const profiles = getProfiles();
    const seedCount = profiles.filter(p => !('candidate' in p)).length;
    const candidateCount = profiles.filter(p => 'candidate' in p && (p as any).candidate === true).length;
    expect(seedCount).toBeGreaterThan(0);
    expect(candidateCount).toBeGreaterThan(0);

    // matchProfile が例外なく動作する
    expect(() => matchProfile('テスト.csv', [], { isHeaderless: true, columnCount: 4 })).not.toThrow();
  });
});
```

- [ ] **Step 2: テストを実行する**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx vitest run test/file-profiles/file-profiles.test.ts 2>&1 | tail -40
```

Expected: 全テスト PASS。もし失敗する場合はエラーメッセージを見て対処する。

- [ ] **Step 3: Commit**

```bash
git add test/file-profiles/file-profiles.test.ts
git commit -m "test: add headerless known file matching integration tests"
```

---

## Task 6: UI confirm 画面の候補理由表示を改善

**Files:**
- Modify: `src/ui/public/app.js:1174-1189`（known file choice card の部分）

- [ ] **Step 1: confirm 画面の known file カードの reason 表示を改善する**

`src/ui/public/app.js` の `renderConfirmPage` 関数内の known file choice card を変更する。

変更前（約 1174-1188 行目）:
```javascript
    html += `
      <div class="confirm-choice-card selected" id="choice-known">
        <div class="confirm-choice-header">
          <input type="radio" name="file-type-choice" value="known" checked>
          <strong>「${escapeHtml(pm.profile.label)}」として扱う</strong>${provLabel}${candidateBadge}
          <span class="badge badge-info">${escapeHtml(pm.reason)}</span>
        </div>
        <p style="font-size:12px;color:var(--text-secondary);margin:4px 0 0 24px">
          分類: ${escapeHtml(pm.profile.category)} ｜ 列数: ${pm.profile.columns.length}
        </p>
      </div>
    `;
```

変更後:
```javascript
    const confidenceLabel = pm.confidence === 'high' ? '✓ よく一致' : pm.confidence === 'medium' ? 'だいたい一致' : '候補';
    const confidenceColor = pm.confidence === 'high' ? 'var(--success)' : pm.confidence === 'medium' ? '#f59e0b' : 'var(--text-secondary)';
    html += `
      <div class="confirm-choice-card selected" id="choice-known">
        <div class="confirm-choice-header">
          <input type="radio" name="file-type-choice" value="known" checked>
          <strong>「${escapeHtml(pm.profile.label)}」として扱う</strong>${provLabel}${candidateBadge}
        </div>
        <p style="font-size:12px;margin:4px 0 0 24px">
          <span style="color:${confidenceColor};font-weight:600">${escapeHtml(confidenceLabel)}</span>
          <span style="color:var(--text-secondary)"> — ${escapeHtml(pm.reason)}</span>
        </p>
        <p style="font-size:12px;color:var(--text-secondary);margin:2px 0 0 24px">
          分類: ${escapeHtml(pm.profile.category)} ｜ 列数: ${pm.profile.columns.length}
        </p>
      </div>
    `;
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/public/app.js
git commit -m "feat: improve match reason display in confirm page with confidence label"
```

---

## Task 7: 全テスト・ビルド・リント実行と結果確認

**Files:** なし（検証のみ）

- [ ] **Step 1: TypeScript ビルドチェック**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx tsc --noEmit 2>&1 | head -60
```

Expected: 今回追加した変更に関連する新しいエラーがないこと（既存エラーは除く）

- [ ] **Step 2: 全テスト実行**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench
npx vitest run 2>&1 | tail -40
```

Expected: 追加したテストが全て PASS、既存テストも引き続き PASS

- [ ] **Step 3: 失敗テストがある場合はエラーを記録する**

既存エラー（`detectHeaderLikelihood`, `scanForMojibake`, `bundleDir`）に関係するものであれば許容。今回の変更に起因する新しい失敗のみ対処する。

- [ ] **Step 4: 最終 Commit（必要な場合）**

テスト失敗の修正が必要だった場合にのみコミット。

---

## 自己レビュー

### Spec coverage チェック

| 要件 | 対応タスク |
|------|-----------|
| ヘッダーなし CSV でも profile が候補として出やすい | Task 2, 4 |
| filename hints で候補を出す | Task 2（既存維持） |
| column count を判定材料にする | Task 2 |
| defaultHasHeader を判定材料にする | Task 2（headerless bonus） |
| positional columns shape を使う | Task 1+2（columnCount で代替） |
| candidate profile に columnCount を持たせる | Task 3 |
| headerlessSuitable メタデータを持たせる | Task 1, 3 |
| upload-identify で isHeaderless を渡す | Task 4 |
| 候補理由を日本語で表示 | Task 2（reason 文字列）, Task 6（UI） |
| confirm 画面で主候補を自然に提示 | Task 6 |
| 既存 built-in / candidate の再利用を壊さない | Task 2（後方互換シグネチャ） |
| 保存済み candidate が filename + column count で候補に出る | Task 5 |
| 列数が大きくズレると候補が弱くなる | Task 5 |
| built-in と candidate が混在しても壊れない | Task 5 |
| テスト追加 | Task 2, 3, 5 |

### 後方互換性

- `matchProfile` の第3引数は `options?`（任意）— 既存の呼び出し側はそのまま動く
- `FileProfile` の新フィールドはいずれも `?`（任意）— 既存 JSON / seed が壊れない
- `buildCandidateProfile` の overrides は既存フィールドを維持したまま拡張

### 仮置きにした点

- `positional columns の形` による高度なマッチングは未実装（今回は column count で代替）
- seed profiles に `columnCount` / `headerlessSuitable` は未設定（columns.length からフォールバック）
- `headerlessSuitable` は候補サジェストのみ使用（自動確定しない）
