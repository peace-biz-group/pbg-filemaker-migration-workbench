# FileMaker Data Workbench

> **このシステムの目的・対象・成功条件**: [`docs/workbench-mission.md`](docs/workbench-mission.md) を参照してください。
> **実装・設計の作業前提 (Agent 向け)**: [`CLAUDE.md`](CLAUDE.md) を参照してください。

稼働中の FileMaker を止めずに、データの意味を現場と一緒に解明し、差分に耐える形へ整備するワークベンチ。FileMaker から出力した CSV / XLSX を読み込み、ファイル種別の特定・列の意味確認・正規化・重複候補抽出・差分追跡を行います。CLI とブラウザベースのレビュー UI の両方から使えます。

## 特徴

- **ストリーム / チャンク処理**: 300万レコード規模でも全件メモリ展開を回避
- **設定駆動**: カラムマッピング・正規化ルール・検出キーを設定ファイルで切替
- **複数ファイル横断処理**: 異なるスキーマのファイルをカラムマッピングで canonical 名に統一し、横断で重複候補を抽出
- **表記揺れ吸収**: 株式会社/(株)/㈱ の統一、住所正規化、店舗名正規化
- **候補止め**: 重複検出・分類は「候補」のみ。自動マージ・確定はしない
- **quarantine**: 分類不能な不明データは quarantine へ隔離
- **レビュー UI**: ブラウザから Run 実行・結果確認・データレビューが可能（ローカル専用）

## 重要: 巨大ファイルの取り扱い

**XLSX ファイルが 10万行を超える場合は、事前に CSV に変換してから処理してください。**

XLSX は SheetJS 経由でシート全体をメモリに展開するため、巨大ファイルではメモリ不足になる可能性があります。CSV はストリーム処理で逐次読み込むため、ファイルサイズに関係なく安定して動作します。

```bash
# LibreOffice で CSV に変換する例
libreoffice --headless --convert-to csv large_file.xlsx

# Excel for Mac の場合は「名前を付けて保存」→「CSV UTF-8」で保存
```

## セットアップ

```bash
npm install
npm run build
```

## CLI コマンド

すべてのコマンドは `tsx` 経由で実行可能です。

### profile — データプロファイル

```bash
npx tsx src/cli/index.ts profile <file> [--config workbench.config.json] [--output-dir ./output]
```

出力: `summary.json`, `summary.md`, `anomalies.csv`

### normalize — 正規化

```bash
npx tsx src/cli/index.ts normalize <file> [--config workbench.config.json]
```

出力: `normalized.csv`, `quarantine.csv`

カラムマッピングが設定に定義されていれば、自動的に適用されます。

### detect-duplicates — 重複候補抽出

```bash
npx tsx src/cli/index.ts detect-duplicates <file> [--config workbench.config.json]
```

出力: `duplicates.csv`

### classify — 候補分類

```bash
npx tsx src/cli/index.ts classify <file> [--config workbench.config.json]
```

出力: `classified.csv`

### run-all — 単一ファイルの全パイプライン一括実行

```bash
npx tsx src/cli/index.ts run-all <file> [--config workbench.config.json]
```

出力: 上記すべてのファイル + `source-batches.json`, `import-run.json`, `merge-summary.json`

### run-batch — 複数ファイルの横断一括実行

```bash
# CLI 引数でファイルを指定
npx tsx src/cli/index.ts run-batch file1.csv file2.csv --config workbench.config.json

# 設定ファイルの inputs から読み込み
npx tsx src/cli/index.ts run-batch --config workbench.config.json
```

出力: 全ファイルをマージした `normalized.csv`, `duplicates.csv`（クロスファイル重複含む）, `classified.csv`, レポート + `source-batches.json`, `import-run.json`, `merge-summary.json`

### split — 巨大 CSV の安全分割

```bash
npx tsx src/cli/index.ts split <file> --rows 500000 [--config workbench.config.json]
```

出力: `part-0001.csv` 形式の分割ファイル群 + `split-manifest.json`

### split-run — part 001 実行と resume

```bash
# 1. 分割して part 001 だけ実行
npx tsx src/cli/index.ts split-run <file> --mode normalize --rows 500000 [--config workbench.config.json]

# 2. part 001 を確認後、manifest だけ指定して resume
npx tsx src/cli/index.ts split-run --resume-from-manifest <split-manifest.json> [--config workbench.config.json]

# 3. 候補が複数あるときだけ、確認済みの run を手動指定して resume
npx tsx src/cli/index.ts split-run --manifest <split-manifest.json> --reuse-run <part1-run-id> [--config workbench.config.json]
```

`split-manifest.json` には `part 001` の初回 `runId`、`firstPartPath`、`schemaFingerprint`、最後に採用した reusable `runId` を保持します。

通常運用では `--resume-from-manifest` だけで再開できます。`profileId` または `effectiveMapping` を持つ run が 1 つに特定できない場合だけ fail-closed で停止し、候補 `runId` を表示します。

出力: `split-manifest.json`, 各 part の個別 run, `split-run-summary.json`, `split-run-summary.md`

## 設定ファイル

`workbench.config.sample.json` をコピーして編集してください。

```bash
cp workbench.config.sample.json workbench.config.json
```

### 主要設定項目

| セクション | 説明 |
|---|---|
| `inputs` | バッチ実行時の入力ファイルリスト（path, label, mode） |
| `columnMappings` | ファイル名パターン → カラムリネームマッピング |
| `canonicalFields` | キーフィールド候補名のリスト（電話, メール, 氏名, 会社名, 住所） |
| `normalization` | 正規化ルールの ON/OFF（会社名・住所・店舗名の正規化を含む） |
| `duplicateDetection` | 重複検出キーの ON/OFF + 正規化キー使用フラグ |
| `classification` | 分類判定に使うフィールドリスト + 優先順序 |
| `diffKeys` | ファイル名パターンごとの差分キー戦略（recordIdField, updatedAtField, naturalKeyFields, fingerprintFields, mode） |
| `chunkSize` | チャンク処理サイズ（デフォルト 5000） |
| `outputDir` | 出力ディレクトリ |

### mainline / archive と再投入の挙動（最小仕様）

- `inputs[].mode` または `diffKeys[*].mode` で `mainline` / `archive` を指定できます（未指定は `archive`）。
- `archive` は profile / normalize / review 出力は行いますが、mainline merge ledger には反映しません。
- `run-all` / `run-batch` では `merge-summary.json` に `inserted / updated / unchanged / duplicate / skipped_archive` が出ます。
- ローカル永続状態は `output/.state/workbench-state.json` に保存され、`source_batch` / `import_run` / merge ledger を再起動後も参照できます。

### semantic record identity（差分再投入の土台）

- `normalized.csv` には次の identity 列が付与されます。  
  `_source_record_key`, `_source_record_key_method(native|deterministic|fallback)`, `_entity_match_key`, `_structural_fingerprint`, `_structural_fingerprint_full`, `_structural_fingerprint_mainline`, `_merge_eligibility(mainline_ready|review|archive_only)`, `_review_reason`, `_semantic_owner`。
- `_structural_fingerprint_full` はレコード全体の構造指紋、`_structural_fingerprint_mainline` は mainline 反映対象フィールドのみの指紋です。`_structural_fingerprint` は後方互換のため mainline 指紋と同値を保持します。
- fallback key (`_source_record_key_method=fallback`) は `mainline_ready` にしません（`review`）。
- 顧客管理系（`recordFamily=customer_master_like`）で `_semantic_owner=unknown/hybrid` のレコードは `review` になり、mainline 自動 merge しません。
- archive は `archive_only` として mainline merge 対象外です。
- `_review_reason` は最低限 `fallback_key / semantic_owner_unknown / semantic_owner_hybrid / deterministic_collision / activity_timestamp_insufficient / archive_mode` を使います。
- deterministic key 衝突時は `deterministic-collisions.json` を run 出力し、該当行は `review` に降格します。
- activity 系（`call_activity / visit_activity / retry_followup`）は unsafe を優先的に review へ寄せます。`activity_timestamp_insufficient` は「日時はあるが担当/結果など識別に必要な補助情報が不足」の意味です。

### semantic identity v2 テスト（golden fixture）

- 同一内容で行順のみ変更しても `_source_record_key` が不変。
- 同一内容で列順のみ変更しても `_source_record_key` が不変。
- 非 mainline 列のみ変更時は full 指紋は変わり得るが mainline 指紋は不変で、mainline update にならない。
- activity family（call/visit/retry）でも同じ安定性を fixture で検証し、識別不足ケースは `review + activity_timestamp_insufficient` になることを確認。

### dry-run runbook（主要4系統）

> 実データは repo に commit せず、ローカルパス指定で実行してください。

- アポリスト
  - `npx tsx src/cli/index.ts run-all /path/to/apo_list.csv --config workbench.config.json`
- 顧客管理系（1本）
  - `npx tsx src/cli/index.ts run-all /path/to/customer_master.csv --config workbench.config.json`
- コール履歴系（1本）
  - `npx tsx src/cli/index.ts run-all /path/to/call_history.csv --config workbench.config.json`
- 詰め直し履歴（1本）
  - `npx tsx src/cli/index.ts run-all /path/to/retry_followup.csv --config workbench.config.json`

確認ポイント（各 run ディレクトリ）:
- `summary.json` の `mainlineReadyCount / reviewCount / archiveOnlyCount / identityWarningCount / skippedReviewCount`
- `review-reason-summary.json`（reason 内訳）
- `merge-eligibility-summary.json`（`mainline_ready / review / archive_only`）

異常値の見方:
- `reviewCount` が多い場合は、まず対象 family と必要識別列（日時・担当・結果系）が入っているか確認する。
- `activity_timestamp_insufficient` が多い場合は、activity 系の日時・担当/結果列不足を疑う。
- `deterministic_collision` が多い場合は、同一 deterministic key で mainline 対象値が衝突している可能性が高い。
- `mainlineReadyCount` が少なすぎる場合でも、まず列の実在・マッピング・family 判定を確認し、ロジック緩和は最後に検討する。

### 実データ dry-run 最短手順（実行補助）

```bash
APO_FILE=/path/to/apo_list.csv \
CUSTOMER_FILE=/path/to/customer_master.csv \
CALL_FILE=/path/to/call_history.csv \
RETRY_FILE=/path/to/retry_followup.csv \
CONFIG=./workbench.config.json \
OUTPUT_DIR=./output \
npm run dry-run:4
```

- 4系統を順に `run-all` 実行し、最後に `OUTPUT_DIR/dry-run-compare.json` と `OUTPUT_DIR/dry-run-compare.md` を出力します。
- 横並びで確認する項目は `totalRecordCount / mainlineReadyCount / reviewCount / archiveOnlyCount / identityWarningCount / skippedReviewCount` です。
- 詳細は `reviewReasonBreakdown / mergeEligibilityBreakdown / sourceRecordKeyMethodBreakdown / recordFamilyBreakdown / topReviewReasons / topWarningIndicators` を確認してください。
- 各 run ディレクトリには `identity-tuning-hints.json` も出力され、config 調整の優先確認ポイントを機械可読で確認できます。
- 各 run ディレクトリには `identity-review-samples.json` も出力され、主要 review reason ごとの代表行を少量サンプリングして確認できます（全件ではありません）。

実データ実行後の確認順（最短）:
1. `dry-run-compare.md` で `reviewRatio` が高い系統を特定
2. `dry-run-compare.md` の `dominant_reasons` を確認
3. 対象 run の `identity-tuning-hints.json` の `likely_tuning_targets / likely_next_checks` を確認
4. `identity-review-samples.json` の代表行を確認（reason ごとに capped sample）

補助で必要に応じて:
- `identity-diagnosis.json` の `reviewRecordFamilyBreakdown`（どの family に偏っているか）
- `reviewSourceRecordKeyMethodBreakdown`（fallback / deterministic / native のどれに偏っているか）

よくある読み分け:
   - `fallback_key` 多発: 元データに stable key 候補が不足
   - `activity_timestamp_insufficient` 多発: activity 系の日時/担当/結果列不足
   - `semantic_owner_unknown` 多発: customer 系の owner 判定に必要な列不足
   - `semantic_owner_hybrid` 多発: customer_like 判定と owner 判定入力の不整合を確認
   - `deterministic_collision` 多発: deterministic key 設計に対して mainline 内容が衝突
   - `archive_mode` 多発: sourceMode と intended archive routing を確認

### カラムマッピングの仕組み

`columnMappings` にファイル名パターン（`*` ワイルドカード対応）をキーとして、ソースカラム名 → canonical 名のマッピングを定義します。

```json
{
  "columnMappings": {
    "apo_list_*.csv": {
      "顧客名": "customer_name",
      "電話番号": "phone",
      "メールアドレス": "email"
    },
    "product_*_customers.csv": {
      "氏名": "customer_name",
      "TEL": "phone",
      "Eメール": "email"
    }
  }
}
```

異なるスキーマのファイルでも、canonical 名に統一されるため、横断的な重複検出・分類が可能になります。

## 正規化ルール

| ルール | 内容 |
|---|---|
| 電話番号整形 | 全角→半角, ハイフン除去, +81→0 変換 |
| メール小文字化 | 全角→半角, lowercase |
| trim | 前後の空白除去 |
| 全角半角統一 | ASCII 全角→半角, 半角カナ→全角カナ |
| 空白/改行整理 | 改行→スペース, 連続空白→1つ, 制御文字除去 |
| 日付正規化 | 和暦・スラッシュ・コンパクト形式 → YYYY-MM-DD |
| 会社名正規化 | (株)/㈱→株式会社, (有)/㈲→有限会社 等 |
| 住所正規化 | 全角数字→半角, 〒除去 |
| 店舗名正規化 | 全角→半角, 空白整理 |

## 重複検出キー

| キー | 説明 |
|---|---|
| 電話番号一致 | 正規化後の電話番号が完全一致 |
| メール一致 | 小文字化後のメールアドレスが完全一致 |
| 氏名 + 会社名/店舗名 | 揺れ吸収済みの会社名で比較（株式会社/(株)/㈱ を統一） |
| 氏名 + 住所 | 正規化済みの住所で比較（郵便番号・空白差異を吸収） |

## 分類ルール

| 候補タイプ | 説明 |
|---|---|
| Customer | 会社名・氏名・電話・メール・住所など、顧客基本情報が充実 |
| Deal | 商材・サービス・契約日など、案件情報が充実 |
| Activity | 対応日・対応種別・メモなど、履歴情報が充実 |
| Transaction | 金額・入金日・請求番号など（現段階では優先度低） |
| Quarantine | 分類に必要なフィールドが不足 |

**Transaction について**: FileMaker のデータでは、金額・請求情報が顧客や案件レコードに同居していることが多いため、Transaction は優先度を下げています。`priorityOrder` で `["customer", "deal", "activity", "transaction"]` の順に評価し、同スコアの場合は先に記載された候補タイプが優先されます。

## レビュー UI

ブラウザから Run の実行・結果確認・データレビューができるローカル専用の軽量 Web UI です。

### 起動方法

```bash
npm run ui
# → http://localhost:3456 で起動

# ポートを変更する場合
PORT=8080 npm run ui

# 出力ディレクトリを変更する場合
OUTPUT_DIR=./my-output npm run ui
```

### 画面構成

| 画面 | URL | 内容 |
|---|---|---|
| ダッシュボード | `http://localhost:3456/` | 直近の Run 一覧、新規 Run ボタン |
| 新規 Run | `http://localhost:3456/new` | モード選択、ファイル指定、設定選択、実行 |
| Run 結果 | `http://localhost:3456/runs/:id` | サマリ、分類内訳、データレビュー（タブ切替）、出力ファイル一覧 |

### 使い方

1. `npm run ui` で起動
2. ブラウザで `http://localhost:3456` を開く
3. 「新規 Run」をクリック
4. 実行モードを選択（run-all, run-batch, profile 等）
5. 入力ファイルのパスを入力（1行に1ファイル）
6. 設定ファイルを選択（任意）
7. 「実行」をクリック
8. 結果画面で以下を確認:
   - サマリ（レコード数、カラム数、anomalies 件数等）
   - 分類内訳（Customer / Deal / Activity / Quarantine）
   - データレビュー（正規化データ、異常値、重複候補、Quarantine、分類結果をタブ切替）
   - 出力ファイル一覧（クリックでダウンロード可能）

### 技術的な制約

- **ローカル専用**: 外部ネットワークには公開しない前提
- **認証なし**: シングルユーザー、ローカル利用前提
- **重い処理はサーバー側**: ブラウザは結果表示のみ、パイプライン実行は Node.js サーバーが担当
- **CLI と共存**: UI を起動しても CLI コマンドは引き続き使用可能

## 福岡オフィス常設PC運用ガイド

### 概要

福岡オフィスの 1台の常設PC（以下「サーバーPC」）で本ツールを起動し、社内LAN上の他のPCのブラウザからアクセスしてCSVレビューを行う運用です。

- サーバーPC: ツールを起動する PC（常設。Node.js がインストール済み）
- 現場PC: ブラウザからアクセスしてレビューを行う PC（Node.js 不要）
- レビュー結果はサーバーPCの固定ディレクトリに自動保存されます
- 現場の方が「送信」「添付」「メール送付」する必要はありません

### サーバーPCの初期セットアップ

```bash
# 1. プロジェクトを配置
cd /path/to/pbg-filemaker-migration-workbench

# 2. 依存パッケージをインストール
npm install
```

### 起動方法

**Windows（PowerShell）:**

```powershell
npm run ui:lan
```

**Mac / Linux（ターミナル）:**

```bash
npm run ui:lan
```

> `ui:lan` スクリプトは `cross-env` を使用しているため、Windows・Mac・Linux いずれでも同じコマンドで起動できます。

起動すると以下のように表示されます:

```
  FileMaker Data Workbench UI
  Local: http://localhost:3456
  LAN: http://<このPCのIPアドレス>:3456

  Output:  C:\Users\user\workbench\output
  Bundles: C:\Users\user\workbench\output\review-bundles
  Press Ctrl+C to stop
```

> 起動時に `Output:` と `Bundles:` の **絶対パス** が表示されます。保存先がここに表示されているパスであることを確認してください。

> **重要**: ターミナル（コマンドプロンプト / PowerShell）を閉じるとサーバーが停止します。常設PCはターミナルを開いたままにしてください。

> **推奨**: 常設PCはスリープ・画面オフにならないよう、電源設定を変更してください。

#### サーバーPCのIPアドレスを確認するには

```powershell
# Windows
ipconfig
```

```bash
# Mac / Linux
ifconfig
# または
ip addr
```

LAN内のIPアドレス（例: `192.168.1.100`）を確認してください。

#### カスタム設定での起動

**Windows（PowerShell）:**

```powershell
# 出力ディレクトリを絶対パスで指定（推奨）
$env:OUTPUT_DIR="C:\Users\user\workbench\output"; npm run ui:lan

# レビューバンドルの保存先を指定
$env:OUTPUT_DIR="C:\Users\user\workbench\output"; $env:BUNDLE_DIR="C:\Users\user\workbench\review-bundles"; npm run ui:lan
```

**Mac / Linux（ターミナル）:**

```bash
# 出力ディレクトリを絶対パスで指定（推奨）
OUTPUT_DIR=/home/user/workbench/output npm run ui:lan

# レビューバンドルの保存先を指定
OUTPUT_DIR=/home/user/workbench/output BUNDLE_DIR=/home/user/workbench/review-bundles npm run ui:lan
```

| 環境変数 | 既定値 | 説明 |
|---|---|---|
| `HOST` | `0.0.0.0` | リッスンアドレス（`0.0.0.0` = LAN内全インターフェース） |
| `PORT` | `3456` | ポート番号 |
| `OUTPUT_DIR` | `./output` | Run 結果の出力先（**常設運用では絶対パス推奨**） |
| `BUNDLE_DIR` | `{OUTPUT_DIR}/review-bundles` | レビューバンドルの保存先（**常設運用では絶対パス推奨**） |

> **絶対パス推奨の理由**: 相対パス（`./output` など）はサーバーの起動場所（カレントディレクトリ）によって保存先が変わります。常設運用では `C:\Users\user\workbench\output` のような絶対パスを指定することで、起動場所によらず保存先が固定されます。

### 現場担当者の使い方

1. ブラウザを開く（Chrome 推奨）
2. アドレスバーに `http://<サーバーPCのIP>:3456` を入力
3. 「新規 Run」でCSVファイルを指定して実行
4. Run結果画面で「列レビュー」ボタンを押す
5. 各カラムの意味づけを確認・修正する
6. 「サマリへ進む」→ ファイルタイプ選択 → 「バンドル出力」を押す
7. **「保存済み」と表示されたら完了です。追加の作業は不要です**

### レビューバンドルの保存先

バンドル出力時、以下の場所に自動保存されます:

```
review-bundles/
  submitted/     ← レビュー完了分がここに集まる
    rev_YYYYMMDD_xxxx/
      review-meta.json
      human-review.json
      mapping-proposal.json
      section-layout-proposal.json
      summary.md
  checked/       ← オーナーが確認済みのものを移動
  rework/        ← 差し戻しが必要なものを移動
```

### オーナー側の運用フロー

1. サーバーPCの `review-bundles/submitted/` を定期的に確認する
2. 各バンドルの `summary.md` を確認する
3. 問題なければ `checked/` に移動する
4. 修正が必要なら `rework/` に移動し、現場に差し戻す
5. `mapping-proposal.json` の `mapping` を `workbench.config.json` の `columnMappings` に取り込む（手動）

```bash
# 例: 確認済みに移動
mv review-bundles/submitted/rev_20260401_abcd review-bundles/checked/

# 例: 差し戻し
mv review-bundles/submitted/rev_20260401_abcd review-bundles/rework/
```

### 停止方法

サーバーPCのターミナルで `Ctrl+C` を押してください。

### セキュリティに関する注意

- このツールに認証機能はありません
- 社内LAN内でのみ使用してください
- インターネットに公開しないでください
- ファイアウォールでポート 3456 が社内LANにのみ開放されていることを確認してください

## テスト

```bash
npm test
```

## 開発

```bash
npm run typecheck  # 型チェック
npm run lint       # ESLint
npm test           # テスト実行
npm run ui         # レビュー UI 起動（localhost のみ）
npm run ui:lan     # レビュー UI 起動（LAN 内アクセス可能）
```
