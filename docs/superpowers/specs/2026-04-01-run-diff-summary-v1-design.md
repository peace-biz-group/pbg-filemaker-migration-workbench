# Run Diff Summary v1 — 設計仕様

**作成日**: 2026-04-01
**対象ブランチ**: feature/candidate-profile-polish

---

## 概要

同じ FileMaker ファイルを繰り返し取り込む前提で、前回と今回の run の違いを軽量な summary として保存・表示する。

全件 row diff はしない。metadata と artifact の比較のみ。

---

## 解決する問題

- 同じファイルを2回目に取り込んだとき「前回と何が変わったか」がわからない
- 列構成が変わったのか、件数が変わっただけなのか、再投入なのか判別できない
- 283万件規模でも動くこと（全件比較禁止）

---

## 設計方針

- metadata（RunMeta の JSON）と保存済みファイル（effective mapping JSON など）を比較するだけ
- 全件ロード・全件比較は行わない
- 比較相手が曖昧なら「比較対象なし」に倒す
- classification は最小限（5分類）

---

## 型定義

### `DiffClassification`

```ts
type DiffClassification =
  | 'same_content'       // 同じ内容の再投入（raw fingerprint 一致）
  | 'row_count_changed'  // データ件数だけ変化
  | 'schema_changed'     // 列構成が変化
  | 'profile_changed'    // 設定が変化（profile / effective mapping の差異）
  | 'no_comparable';     // 比較対象なし
```

### `RunDiffSummaryV1`

```ts
interface RunDiffSummaryV1 {
  version: 1;
  // backward compat (既存 RunDiff と共存できるフィールド)
  previousRunId: string;
  currentRunId: string;
  logicalSourceKey: string;
  totals: {
    recordCountDelta: number;
    normalizedCountDelta: number;
    quarantineCountDelta: number;
    parseFailDelta: number;
  };
  // 新規フィールド
  profileId?: string;
  sameProfile: boolean;
  sameSchemaFingerprint: boolean;
  sameRawFingerprint: boolean;
  sameEffectiveMapping: boolean;
  rowCountPrev: number;
  rowCountCurr: number;
  columnCountPrev: number;
  columnCountCurr: number;
  hasHeaderPrev?: boolean;
  hasHeaderCurr?: boolean;
  sourceFilenamesPrev: string[];
  sourceFilenamesCurr: string[];
  addedColumns: string[];
  removedColumns: string[];
  classification: DiffClassification;
  classificationLabel: string;  // 日本語
  generatedAt: string;
}
```

---

## RunMeta への追加フィールド（backward compat）

```ts
interface RunMeta {
  // 既存フィールドはそのまま
  // 追加（省略可）
  profileId?: string;           // 使用した profile ID（fast-path または column review）
  inputColumns?: Record<string, string[]>;  // ファイルパス → 列名リスト
}
```

---

## Comparable Run 判定

優先順位:
1. `RunMeta.logicalSourceKey` が一致 AND `RunMeta.profileId` が一致 → 最優先
2. `RunMeta.logicalSourceKey` が一致（existing logic） → fallback

条件:
- status === 'completed'
- 自分自身 (runId === currentRunId) を除く
- 最新順で1件目を採用

---

## Classification ロジック

```
if (sameRawFingerprint)           → 'same_content'
else if (!sameSchemaFingerprint)  → 'schema_changed'
else if (!sameProfile || !sameEffectiveMapping) → 'profile_changed'
else if (rowCountDelta !== 0)     → 'row_count_changed'
else                              → 'same_content'
```

---

## 保存場所

- `runs/{runId}/run-diff.json` — 既存と同じ場所、形式を V1 に更新
- 既存テストが `previousRunId`, `totals.recordCountDelta` を確認しているため backward compat フィールドを保持

---

## 新規ファイル

### `src/core/run-diff-summary.ts`

- `DiffClassification` 型
- `RunDiffSummaryV1` 型
- `findComparableRun(outputDir, currentMeta)` → `RunMeta | null`
- `buildRunDiffSummaryV1(outputDir, currentMeta)` → `RunDiffSummaryV1 | null`

---

## 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/types/index.ts` | 既存 `RunDiff` は残す（型は別途 V1 を追加） |
| `src/core/pipeline-runner.ts` | `RunMeta` に `profileId`, `inputColumns` 追加; `executeRun` options に `profileId` 追加; `buildRunDiffSummaryV1` を呼ぶ |
| `src/ui/server.ts` | fast-path/rerun-with-review で `profileId` を pass; `GET /api/runs/:id/diff` 追加 |
| `src/ui/public/app.js` | `renderRunDetail` に差分カードを追加 |
| `test/core/diff.test.ts` | 新ケースを追加（comparable なし・schema 変化・件数変化・same raw fingerprint） |

---

## API

### `GET /api/runs/:id/diff`

- 現在の RunMeta を読み込み、`buildRunDiffSummaryV1` を呼ぶ
- 結果を `run-diff.json` に保存（毎回更新）し、JSON を返す
- comparable run が見つからない場合は `{ classification: 'no_comparable', ... }` を返す

---

## UI 変更（run detail）

サマリカードの直後に「前回との比較」カードを非同期で追加:

```
前回との比較
  比較対象: run_20260401_xxxx（2026/04/01 10:30）
  判定: 件数が変わった
  件数: +1,234 件（前回: 100,000 → 今回: 101,234）
  列数: 変化なし
```

カードは optional — エラーや「比較対象なし」でも UI は壊れない。

---

## 制約

- 全件 row diff は行わない
- `schemaFingerprints` の key は file path — 比較は値（fingerprint hash）の集合で行う
- `sameProfile` は両方 `profileId` が定義されているときのみ `true` になる
- `sameEffectiveMapping` は effective mapping JSON が両方存在するときのみ比較する

---

## テストケース

1. comparable previous run あり → diff summary が生成される（既存）
2. comparable previous run なし → classification = 'no_comparable'
3. 同じファイルの再実行 → sameRawFingerprint = true, classification = 'same_content'
4. 行数だけ変化 → classification = 'row_count_changed'
5. schema fingerprint が異なる → classification = 'schema_changed'
6. built-in / candidate どちらでも comparable 判定が動く

---

*未確定: profile_changed の細かい判定は v1 では簡略化（sameProfile のみ確認、effective mapping 比較は best-effort）*
