# FileMaker Data Workbench

FileMaker から出力した CSV / XLSX を読み込み、データの調査・正規化・重複候補抽出・候補分類・レビュー用レポート出力を行うローカル CLI ツールです。

## 特徴

- **ストリーム / チャンク処理**: 300万レコード規模でも全件メモリ展開を回避
- **設定駆動**: カラムマッピング・正規化ルール・検出キーを設定ファイルで切替
- **複数ファイル横断処理**: 異なるスキーマのファイルをカラムマッピングで canonical 名に統一し、横断で重複候補を抽出
- **表記揺れ吸収**: 株式会社/(株)/㈱ の統一、住所正規化、店舗名正規化
- **候補止め**: 重複検出・分類は「候補」のみ。自動マージ・確定はしない
- **quarantine**: 分類不能な不明データは quarantine へ隔離

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

## テスト

```bash
npm test
```

## 開発

```bash
npm run typecheck  # 型チェック
npm run lint       # ESLint
npm test           # テスト実行
```
