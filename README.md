# FileMaker Data Workbench

FileMaker から出力した CSV / XLSX を読み込み、データの調査・正規化・重複候補抽出・候補分類・レビュー用レポート出力を行うローカル CLI ツールです。

## 特徴

- **ストリーム / チャンク処理**: 300万レコード規模でも全件メモリ展開を回避
- **設定駆動**: カラムマッピング・正規化ルール・検出キーを設定ファイルで切替
- **候補止め**: 重複検出・分類は「候補」のみ。自動マージ・確定はしない
- **quarantine**: 分類不能な不明データは quarantine へ隔離

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

### run-all — 全パイプライン一括実行

```bash
npx tsx src/cli/index.ts run-all <file> [--config workbench.config.json]
```

出力: 上記すべてのファイル

## 設定ファイル

`workbench.config.sample.json` をコピーして編集してください。

```bash
cp workbench.config.sample.json workbench.config.json
```

### 主要設定項目

| セクション | 説明 |
|---|---|
| `columnMappings` | ソースファイルのカラム名 → canonical 名のマッピング |
| `canonicalFields` | キーフィールド候補名のリスト（電話, メール, 氏名, 会社名, 住所） |
| `normalization` | 正規化ルールの ON/OFF |
| `duplicateDetection` | 重複検出キーの ON/OFF |
| `classification` | 分類判定に使うフィールドリスト |
| `chunkSize` | チャンク処理サイズ（デフォルト 5000） |
| `outputDir` | 出力ディレクトリ |

## 正規化ルール

| ルール | 内容 |
|---|---|
| 電話番号整形 | 全角→半角, ハイフン除去, +81→0 変換 |
| メール小文字化 | 全角→半角, lowercase |
| trim | 前後の空白除去 |
| 全角半角統一 | ASCII 全角→半角, 半角カナ→全角カナ |
| 空白/改行整理 | 改行→スペース, 連続空白→1つ, 制御文字除去 |
| 日付正規化 | 和暦・スラッシュ・コンパクト形式 → YYYY-MM-DD |

## 重複検出キー

| キー | 説明 |
|---|---|
| 電話番号一致 | 正規化後の電話番号が完全一致 |
| メール一致 | 小文字化後のメールアドレスが完全一致 |
| 氏名 + 会社名/店舗名 | 氏名と会社名（または店舗名）の組み合わせが一致 |
| 氏名 + 住所 | 氏名と住所の組み合わせが一致 |

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
