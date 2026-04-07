# Huge CSV Split Run — 設計仕様

**作成日**: 2026-04-06
**対象**: 巨大 FileMaker CSV の安全分割と順次処理
**方針**: CLI 優先 / 巨大CSV対策に限定 / 既存 ingest fallback 再利用

---

## 概要

270万件超の FileMaker アポリスト CSV を 1 本のまま抱え込まず、Workbench 内で安全に分割し、分割後の part を順次 `normalize` / `run-all` 相当で処理できるようにする。

ユーザーに外部 split スクリプトを要求しない。

ただし汎用 ETL にはしない。対象は「巨大CSVを安全に扱うための補助機能」に絞る。

---

## 解決する問題

- 巨大 CSV を 1 本のまま運ぶと、確認・再実行・切り分けが重い
- FileMaker CSV は quote 崩れを含むことがあるため、OS コマンドの雑な split が使えない
- 1 本目で profile / mapping / routing が自動確定できても、残り part に同じ判断を引き継げない
- 同じ schema の split part ごとに毎回確認させると運用負荷が高い

---

## スコープ

今回やること:

- CLI の `split` コマンド追加
- CLI の `split-run` コマンド追加
- record 単位の安全な CSV 分割
- part 001 実行後の resume 初期実装
- 分割後 part の順次処理
- 1 本目の確認済み設定の残り part への自動適用
- schema 変化時の停止
- manifest / run 結果 / 全体サマリの保存

今回やらないこと:

- 任意フォーマット間変換
- 任意条件による抽出・変換・結合
- UI のフル対応
- 複雑なワークフロー管理 UI

---

## コマンド

### `fm-workbench split <file>`

巨大 CSV を安全に part へ分割する。

主なオプション:

- `--rows <n>`: 1 part のデータ行数。既定 `500000`
- `--output-dir <dir>`: 出力先。既定は `output/splits/<source-stem>/`
- `--encoding <enc>` / `--delimiter <delim>` / `--csv-quote-mode <mode>`: 既存 ingest override をそのまま受ける
- `--no-header`, `--skip-rows <n>`: 既存 ingest と同じ

### `fm-workbench split-run <file>`

まず `split` を実行し、part 001 を実行して停止する。

主なオプション:

- `--mode <mode>`: `normalize` または `run-all`。既定 `normalize`
- `--rows <n>`: split 時の part サイズ。既定 `500000`
- `--output-dir <dir>`: 実行単位の出力先
- ingest override 一式

### `fm-workbench split-run --resume-from-manifest <manifest>`

保存済み manifest / summary を読み、part 002 以降を順次実行する。

### `fm-workbench split-run --reuse-run <part1-run-id> --manifest <manifest>`

part 001 の run を明示指定して、そこから reusable context を作り、残り part を順次実行する。

`split-run` は以下の 3 段階を明示する。

1. split
2. part 001 実行
3. resume 実行（part 002 以降）

---

## アーキテクチャ

```
CLI
  ├─ split command
  │    └─ src/core/huge-csv-split.ts
  │         ├─ ingestFile(...)           # 既存 quote fallback を使って読む
  │         ├─ writeCsv / appendCsv      # part を壊さず書く
  │         └─ split-manifest.json
  │
  └─ split-run command
       └─ src/core/huge-csv-split-run.ts
            ├─ splitCsvFile(...)
            ├─ executeRun(...)           # 既存 pipeline-runner 再利用
            ├─ resumeSplitRun(...)
            ├─ 1本目 run の profileId / effectiveMapping / routing / ingestOptions を採用
            ├─ schemaFingerprint 一致確認
            └─ split-run-summary.json
```

責務:

- `huge-csv-split.ts`: 安全分割だけを担当
- `huge-csv-split-run.ts`: part 001 実行、resume、設定引き継ぎを担当
- `pipeline-runner.ts`: 個別 part の既存 run 実行をそのまま担当

---

## データフロー

### split

1. `ingestFile(filePath, ingestOptions, chunkSize)` で元 CSV を読む
2. `records` を chunk 単位で受け取る
3. part の現在行数が `rowsPerPart` に達したら次 part を開始
4. 各 part の先頭で同じ header を書く
5. 行は `writeCsv` / `appendCsv` でシリアライズし直す
6. part ごとの件数・path・schemaFingerprint・appliedQuoteMode を manifest に保存
7. 元 CSV の diagnosis も manifest に保存

### split-run

1. `splitCsvFile(...)` で part 一覧を作る
2. part 001 を `executeRun(mode, [part1], config, ...)` で実行
3. summary に `stage = 'part1_completed'` を保存して停止する
4. resume 実行時、1 本目 run から以下を取得する
   - `schemaFingerprint`
   - `profileId`（存在するとき）
   - `effectiveMapping`（存在するとき）
   - `sourceRouting`
   - `ingestOptions`
5. 1 本目が「自動確定済み」と判定できる場合だけ reusable context を作る
6. 2 本目以降の split manifest の `schemaFingerprint` が 1 本目と一致するか確認
7. 一致した part のみ、reusable context を付けて `executeRun` を順次実行
8. 不一致が出た時点で停止し、全体 summary に記録

---

## 自動適用ルール

### reusable context の生成条件

後続 part に自動適用してよいのは、1 本目で次のどちらかを満たした場合だけ:

1. `profileId` が確定している
2. `effectiveMapping` が保存済みで、かつ空でない

今回の初期実装では、人手確認をまたいだ後に CLI resume で続行できる。
ただし複雑な承認ワークフロー管理は持たない。

### 後続 part に渡すもの

- `profileId`
- `effectiveMapping`
- `sourceRouting`
- `ingestOptions`（encoding / delimiter / csvQuoteMode など）
- `reusedFromRunId`

### 停止条件

- 2 本目以降の `schemaFingerprint` が 1 本目と異なる
- 1 本目で reusable context を作れない
- part run が failed になる

停止時は、どの part で止まったか、なぜ止まったかを全体 summary に残す。
`stopReason` は必須。

---

## 新規型

### `SplitPartMeta`

```ts
interface SplitPartMeta {
  partIndex: number;
  filePath: string;
  rowCount: number;
  schemaFingerprint: string;
  sourceFileHash: string;
  diagnosis: {
    appliedEncoding?: string;
    appliedDelimiter?: string;
    requestedQuoteMode?: string;
    appliedQuoteMode?: string;
  };
}
```

### `SplitManifest`

```ts
interface SplitManifest {
  version: 1;
  sourceFile: string;
  generatedAt: string;
  rowsPerPart: number;
  totalParts: number;
  totalRows: number;
  columns: string[];
  schemaFingerprint: string;
  stage: 'split_completed' | 'part1_completed' | 'resume_completed';
  sourceDiagnosis: {
    appliedEncoding?: string;
    appliedDelimiter?: string;
    requestedQuoteMode?: string;
    appliedQuoteMode?: string;
  };
  parts: SplitPartMeta[];
}
```

### `SplitRunPartResult`

```ts
interface SplitRunPartResult {
  partIndex: number;
  filePath: string;
  runId?: string;
  status: 'completed' | 'failed' | 'skipped';
  reason?: string;
  schemaFingerprint: string;
  normalizedCount?: number;
  quarantineCount?: number;
  parseFailCount?: number;
}
```

### `SplitRunSummary`

```ts
interface SplitRunSummary {
  version: 1;
  mode: 'normalize' | 'run-all';
  sourceFile: string;
  splitManifestPath: string;
  generatedAt: string;
  stage: 'split_completed' | 'part1_completed' | 'resume_completed' | 'stopped';
  totalParts: number;
  completedParts: number;
  failedParts: number;
  skippedParts: number;
  stoppedAtPartIndex?: number;
  stopReason: string | null;
  reusedProfileId?: string;
  reusedEffectiveMapping: boolean;
  reusedSourceRouting: boolean;
  reusedFromRunId?: string;
  schemaFingerprintMatchedAllParts: boolean;
  schemaFingerprint: string;
  partResults: SplitRunPartResult[];
  totals: {
    normalizedCount: number;
    quarantineCount: number;
    parseFailCount: number;
  };
}
```

---

## 保存場所

### split

- `output/splits/<source-stem>/split-manifest.json`
- `output/splits/<source-stem>/part-0001.csv`
- `output/splits/<source-stem>/part-0002.csv`

### split-run

- `output/split-runs/<timestamp>_<stem>/split-manifest.json`
- `output/split-runs/<timestamp>_<stem>/parts/part-0001.csv`
- `output/split-runs/<timestamp>_<stem>/runs/<part-index>/...` （各 part run の outputDir）
- `output/split-runs/<timestamp>_<stem>/split-run-summary.json`
- `output/split-runs/<timestamp>_<stem>/split-run-summary.md`

既存 run artifact は part ごとに個別保存し、全体 summary は split-run 直下に置く。

---

## 既存コードへの変更点

| ファイル | 変更内容 |
|---------|---------|
| `src/types/index.ts` | split/split-run summary 型を追加 |
| `src/core/pipeline-runner.ts` | `executeRun` の options に reusable context を安全に渡せるよう拡張 |
| `src/core/huge-csv-split.ts` | 新規。安全 split 本体 |
| `src/core/huge-csv-split-run.ts` | 新規。part 001 実行と resume 本体 |
| `src/cli/commands/split.ts` | 新規 CLI |
| `src/cli/commands/split-run.ts` | 新規 CLI |
| `src/cli/index.ts` | コマンド追加 |
| `README.md` | CLI 利用例を追加 |
| `test/core/huge-csv-split.test.ts` | split テスト |
| `test/core/huge-csv-split-run.test.ts` | split-run テスト |

---

## エラーハンドリング

- ingest fallback で読めない場合は split 自体を失敗とする
- part 書き込み失敗時は即停止し、manifest は途中状態でも保存する
- 1 本目で reusable context を作れない場合:
  - resume は停止
  - 「1本目で自動確定できなかったため、残りへ自動適用しない」と明示
- schema 変化時:
  - その part 以降を実行しない
  - `stopReason = 'schema_changed'`

fail-open ではなく fail-closed に倒す。

---

## 既存正常系への影響

- 通常の `preview` / `normalize` / `run-all` / `run-batch` は変更しない
- 巨大CSV対策は新コマンド配下に閉じる
- 既存 ingest fallback を使うため、CSV 解釈の一貫性は維持される

---

## テストケース

1. quote 崩れを含む CSV を split できる
2. split 後の各 part に header が付く
3. 50万行未満の小さい CSV は 1 part のみ生成する
4. `rowsPerPart=2` の小 fixture で 3 part に分割され、行欠落・重複がない
5. part 001 実行後に resume で残り part を処理できる
6. reusable context がないと resume できず停止する
7. schemaFingerprint が変わる part が混ざると停止する
8. summary に `reusedFromRunId` / `reusedEffectiveMapping` / `stopReason` が出る
9. `normalize` モードでも `run-all` モードでも全体 summary が出る
10. 既存の通常サイズ CSV ingest テストが壊れない

---

## 制約

- 分割は CSV 専用。XLSX は対象外
- resume は CLI のみ
- 分割後 part を再結合する機能は作らない
- part 間の cross-part duplicate 検出統合は初期実装では行わない

---

## 未確定事項

- `split-run --mode run-all` の全体 summary に duplicate / classify の集計をどこまで統合するかは初期実装では簡易合算でよい
- `sourceRouting` の再利用境界は現状 `schemaFingerprint` 一致を前提とする

