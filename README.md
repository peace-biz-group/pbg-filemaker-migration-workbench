# FileMaker Data Workbench

FileMaker から出力した CSV / XLSX を読み込み、データの調査・正規化・重複候補抽出・候補分類・レビュー用レポート出力を行うローカルツールです。CLI とブラウザベースのレビュー UI の両方から使えます。

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

出力: 上記すべてのファイル

### run-batch — 複数ファイルの横断一括実行

```bash
# CLI 引数でファイルを指定
npx tsx src/cli/index.ts run-batch file1.csv file2.csv --config workbench.config.json

# 設定ファイルの inputs から読み込み
npx tsx src/cli/index.ts run-batch --config workbench.config.json
```

出力: 全ファイルをマージした `normalized.csv`, `duplicates.csv`（クロスファイル重複含む）, `classified.csv`, レポート

## 設定ファイル

`workbench.config.sample.json` をコピーして編集してください。

```bash
cp workbench.config.sample.json workbench.config.json
```

### 主要設定項目

| セクション | 説明 |
|---|---|
| `inputs` | バッチ実行時の入力ファイルリスト（path, label） |
| `columnMappings` | ファイル名パターン → カラムリネームマッピング |
| `canonicalFields` | キーフィールド候補名のリスト（電話, メール, 氏名, 会社名, 住所） |
| `normalization` | 正規化ルールの ON/OFF（会社名・住所・店舗名の正規化を含む） |
| `duplicateDetection` | 重複検出キーの ON/OFF + 正規化キー使用フラグ |
| `classification` | 分類判定に使うフィールドリスト + 優先順序 |
| `chunkSize` | チャンク処理サイズ（デフォルト 5000） |
| `outputDir` | 出力ディレクトリ |

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

```bash
# 基本の起動（LAN内からアクセス可能）
npm run ui:lan
```

起動すると以下のように表示されます:

```
  FileMaker Data Workbench UI
  Local: http://localhost:3456
  LAN: http://<このPCのIPアドレス>:3456

  Output:  /path/to/output
  Bundles: /path/to/output/review-bundles
  Press Ctrl+C to stop
```

#### サーバーPCのIPアドレスを確認するには

```bash
# Windows
ipconfig

# Mac / Linux
ifconfig
# または
ip addr
```

LAN内のIPアドレス（例: `192.168.1.100`）を確認してください。

#### カスタム設定での起動

```bash
# ポートを変更する場合
PORT=8080 npm run ui:lan

# 出力ディレクトリを変更する場合
OUTPUT_DIR=/home/user/workbench-data npm run ui:lan

# レビューバンドルの保存先を別にする場合
BUNDLE_DIR=/shared/review-bundles npm run ui:lan

# すべてまとめて指定する例
PORT=3456 OUTPUT_DIR=./output BUNDLE_DIR=./review-bundles npm run ui:lan
```

| 環境変数 | 既定値 | 説明 |
|---|---|---|
| `HOST` | `0.0.0.0` | リッスンアドレス（`0.0.0.0` = LAN内全インターフェース） |
| `PORT` | `3456` | ポート番号 |
| `OUTPUT_DIR` | `./output` | Run 結果の出力先 |
| `BUNDLE_DIR` | `{OUTPUT_DIR}/review-bundles` | レビューバンドルの保存先 |

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
