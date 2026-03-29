# FileMaker Lossless Ingest Engine — Design Spec

**Date:** 2026-03-29
**Branch:** claude/filemaker-data-workbench-k6OIx
**Approach:** B+ (Ingest Layer 分離 + Raw Immutable 保全)

---

## 目的

FileMaker Data Workbench を「実データの業務意味を知らなくても FileMaker export を壊さず受け、全件再投入・差分比較・raw 保全・後追い mapping 育成に耐える lossless ingest engine」に引き上げる。

semantic perfection は今回の目的ではない。parse / staging / replay / observability の完成度を本番前段レベルまで上げる。

---

## Section 1: アーキテクチャ

### 責務境界

```
CLI / UI
    │  IngestOptions (encoding/delimiter/hasHeader/skipRows/previewRows override)
    ▼
src/ingest/                         ← 新設: bytes → records の責務
  ingest-options.ts
  encoding-detector.ts              # BOM/UTF-8/CP932 判定
  delimiter-detector.ts             # comma/tab/semicolon 判定
  fingerprint.ts                    # fileHash / rowFingerprint / sourceBatchId 等
  csv-ingest.ts                     # decode → parse → fingerprint → parse-level quarantine
  xlsx-ingest.ts                    # XLSX → IngestResult (同 interface)

    ├── ParseOkRecord  → src/core/ へ渡す
    └── ParseFailRecord → parse-quarantine.csv（normalizer まで届かない）

src/io/
  csv-reader.ts    # 薄い facade（既存 ChunkProcessor API を維持）
  file-reader.ts   # IngestOptions を受け取り csv/xlsx に振り分け
  xlsx-reader.ts   # 変更最小限

src/core/
  normalizer.ts         # business-level quarantine のみ
  pipeline-runner.ts    # run meta / diff / sourceBatchId / fingerprints 管理
  column-mapper.ts      # schemaMappings / indexMappings 追加
  profiler.ts           # valueCounts CAP 導入
  classifier.ts         # allClassified 廃止 → chunk 逐次書き出し
  duplicate-detector.ts # index size 警告のみ
```

**key boundary**: `csv-ingest.ts` より上流は「bytes → records」の責任。
parse 由来の失敗は絶対に normalizer まで届かない。

---

## Section 2: 型・インターフェース

### IngestOptions

```typescript
export interface IngestOptions {
  encoding?: 'auto' | 'utf8' | 'cp932';
  delimiter?: 'auto' | ',' | '\t' | ';';
  hasHeader?: boolean;     // デフォルト: true
  skipRows?: number;       // デフォルト: 0
  previewRows?: number;    // preview コマンド用
}
```

### QuarantineReason（parse / business 分離）

```typescript
// parse 段階で失敗 — normalizer まで届かない
export type ParseQuarantineReason =
  | 'DECODE_FAILED'        // 行全体が実用不能
  | 'COLUMN_MISALIGNMENT'  // 列数がヘッダと不一致
  | 'PARSE_ERROR';         // csv-parse 内部エラー

// business 段階で quarantine 判定
export type BusinessQuarantineReason =
  | 'BUSINESS_KEY_EMPTY'   // phone/email/name/company が全欠落
  | 'ALL_COLUMNS_EMPTY';   // 全フィールドが空

export type QuarantineReason = ParseQuarantineReason | BusinessQuarantineReason;
```

Note: `MAPPING_UNKNOWN` は quarantine reason にしない。マッピング未定列は列名保持で処理続行。

### IngestDiagnosis（discriminated union）

```typescript
export interface CsvIngestDiagnosis {
  format: 'csv';
  detectedEncoding: 'utf8' | 'utf8bom' | 'cp932' | 'unknown';
  encodingConfidence: 'bom' | 'valid_utf8' | 'heuristic' | 'fallback';
  appliedEncoding: 'utf8' | 'cp932';  // utf8bom → utf8 で適用
  detectedDelimiter: ',' | '\t' | ';';
  appliedDelimiter: ',' | '\t' | ';';
  headerApplied: boolean;
  totalRowsRead: number;
  parseFailCount: number;
  parseWarnings: string[];  // 最大50件
}

export interface XlsxIngestDiagnosis {
  format: 'xlsx';
  sheetName: string;
  headerApplied: boolean;
  totalRowsRead: number;
  parseFailCount: number;
  parseWarnings: string[];
}

export type IngestDiagnosis = CsvIngestDiagnosis | XlsxIngestDiagnosis;
```

### IngestResult（CSV / XLSX 共通 interface）

```typescript
export interface ParseFailRecord {
  rowIndex: number;
  rawLine: string;
  rawLineHash: string;
  rawLinePreview: string;   // 先頭200文字
  reason: ParseQuarantineReason;
  detail: string;
}

export interface IngestResult {
  diagnosis: IngestDiagnosis;
  sourceFileHash: string;        // full streaming SHA-256
  schemaFingerprint: string;     // SHA-256(sorted columns joined)
  columns: string[];
  records: AsyncIterable<RawRecord[]>;  // streaming chunk
  parseFailures: ParseFailRecord[];
}
```

### RunMeta 拡張

```typescript
export interface RunMeta {
  // 既存フィールド ...
  sourceBatchId: string;                           // SHA-256(sorted(fileHashes))
  logicalSourceKey: string;                        // SHA-256(sorted(sourceKeys or basenames))
  sourceFileHashes: Record<string, string>;
  schemaFingerprints: Record<string, string>;
  ingestDiagnoses: Record<string, IngestDiagnosis>;
  previousRunId?: string;                          // 同 logicalSourceKey の直前 run
}
```

### Lineage 列（全 downstream 出力共通）

```
_source_file, _source_key, _source_batch_id, _import_run_id,
_schema_fingerprint, _row_fingerprint
```

normalized / duplicates / classified / quarantine すべてに付与。

### RunDiff

```typescript
export interface RunDiffBySource {
  sourceKey: string;
  recordCountDelta: number;
  normalizedCountDelta: number;
  quarantineCountDelta: number;
  parseFailDelta: number;
  schemaChanged: boolean;
  schemaFingerprintPrev?: string;
  schemaFingerprintCurr?: string;
}

export interface RunDiff {
  previousRunId: string;
  currentRunId: string;
  logicalSourceKey: string;
  bySource: RunDiffBySource[];
  totals: Omit<RunDiffBySource, 'sourceKey' | 'schemaChanged' | 'schemaFingerprintPrev' | 'schemaFingerprintCurr'>;
}
```

---

## Section 3: Ingest 層の実装

### encoding-detector.ts

先頭8KB を読む。判定順:
1. BOM `EF BB BF` → `utf8bom`, appliedEncoding = `utf8`
2. UTF-8 valid byte sequence（invalid byte なし）→ `utf8`, confidence = `valid_utf8`
3. CP932 heuristic: `0x81-0x9F` or `0xE0-0xFC` の先頭バイトを持つ2バイト対 + 後続 `0x40-0xFC` が存在 → `cp932`, confidence = `heuristic`
4. いずれも不確実 → `unknown`, appliedEncoding = `utf8`, confidence = `fallback`

override が渡された場合は detection をスキップ。

### delimiter-detector.ts

先頭2KB / 5行をサンプル。各候補区切り（`,` `\t` `;`）で分割した時の列数の分散が最小→最安定→当選。引き分けは `,` 優先。

### fingerprint.ts

```typescript
fileHash(filePath): Promise<string>              // full streaming SHA-256
fastFileFingerprint(filePath): Promise<string>   // 先頭512KB + サイズ（明示使用のみ）
schemaFingerprint(columns: string[]): string     // SHA-256(sorted(columns).join('|'))
rowFingerprint(sourceFileHash, rowIndex, rawPayload): string  // SHA-256(all three joined)
sourceBatchId(fileHashes: string[]): string      // SHA-256(sorted(fileHashes).join('|'))
logicalSourceKey(sourceKeys: string[]): string   // SHA-256(sorted(sourceKeys).join('|'))
```

### csv-ingest.ts

フロー:
1. detectEncoding → override 適用 → appliedEncoding 確定
2. 先頭2KB read → detectDelimiter → override 適用 → appliedDelimiter 確定
3. iconv-lite.decodeStream(appliedEncoding) | csv-parse({ columns: hasHeader, delimiter, relax_column_count })
4. hasHeader=false → c0, c1, c2... 仮列名生成。常に RawRecord 形式を保証
5. 各 row:
   - 列数不一致 → ParseFailRecord(COLUMN_MISALIGNMENT)
   - parse エラー → ParseFailRecord(PARSE_ERROR)
   - U+FFFD 含む → warning（行全体の有効文字率 < 50% のみ DECODE_FAILED）
   - 正常 → rowFingerprint を `_row_fingerprint` として付与
6. AsyncGenerator<RawRecord[]> として chunk yield
7. diagnosis + sourceFileHash + schemaFingerprint を集約

### xlsx-ingest.ts

同 IngestResult interface。内部は既存 readXlsxInChunks ラップ。XlsxIngestDiagnosis を生成。encoding 検出なし。

---

## Section 4: IngestOptions 伝搬・Config 拡張・出力契約

### Config 拡張

```jsonc
{
  "ingestOptions": { "encoding": "auto", "delimiter": "auto", "hasHeader": true, "skipRows": 0 },
  "inputs": [
    {
      "path": "./data/legacy.csv",
      "sourceKey": "legacy_customers",
      "label": "旧顧客",
      "ingestOptions": { "encoding": "cp932" }
    }
  ],
  "columnMappings": { ... },
  "indexMappings": { "unnamed_*.csv": { "0": "phone", "1": "customer_name" } },
  "schemaMappings": { "<fingerprint>": { "顧客名": "customer_name" } }
}
```

優先順位: CLI flags > input.ingestOptions > global ingestOptions > defaults

### CLI フラグ（全コマンド共通）

```bash
--encoding auto|utf8|cp932
--delimiter auto|,|\t|;
--no-header
--skip-rows <n>
--preview-rows <n>
```

### 出力ファイル構造

```
runs/<runId>/
  run-meta.json            # run 全体 index（id/status/counts/fingerprints）
  ingest-diagnoses.json    # 各ファイル詳細診断
  parse-quarantine.csv     # parse-level 失敗行
  quarantine.csv           # business-level 失敗行（reason code 付）
  run-diff.json            # 前回 run との count-level 比較
  normalized.csv
  duplicates.csv
  classified.csv
  mapping-suggestions.json
  summary.json / summary.md
```

### parse-quarantine.csv 列

`_row_index, _reason, _detail, _raw_line_hash, _raw_line_preview, _raw_line, _source_file`

### quarantine.csv 列

`_row_index, _quarantine_reason, _source_file, _source_key, _source_batch_id, _import_run_id, _schema_fingerprint, _row_fingerprint, <全データ列>`

---

## Section 5: メモリ・パフォーマンス修正

### profiler.ts

- `VALUE_COUNTS_CAP = 10_000` 導入
- CAP 超過後は新規エントリ追加を止め `overflowed: true` フラグを付与
- `ColumnProfile` に `uniqueCountCapped: boolean` を追加
- summary/markdown では `>= 10000` 表記

### classifier.ts

- `allClassified: RawRecord[]` を廃止
- 最初のチャンクで `writeCsv`（ヘッダ付き）、以降 `appendCsv`
- normalizer.ts と同パターンに統一

### server.ts

- `/api/runs/:id/data/:filename`, `/api/runs/:id/source-data` を非同期ストリーム読みに変更
- `csv-parse` の `from_line` / `to` オプションで offset/limit を適用
- `readFileSync` + `parse/sync` を廃止

### duplicate-detector.ts

- index size > 500,000 で `console.warn` 追加
- 構造変更は今回スコープ外（README に明記）

---

## Section 6: Mapping Evolution + Preview

### column-mapper.ts 拡張

優先順位: `schemaMappings[fingerprint]` → `columnMappings[filename]` → `indexMappings[filename]` → マッピングなし（列名保持）

マッピングなし = quarantine にしない。raw を保持して処理続行。

### mapping-suggestions.json

```jsonc
{
  "schemaFingerprint": "abc123...",
  "columns": ["顧客名", "電話番号"],
  "suggestions": [
    { "sourceColumn": "電話番号", "suggestedCanonical": "phone", "confidence": "high", "reason": "name_pattern" }
  ]
}
```

汎用パターンのみ（業務意味の確定はしない）:
- phone: `tel|phone|電話|携帯|fax` → high
- email: `mail|email` → high
- date: `date|日付|日$|_at$` → medium
- name: `name|氏名|名前` → medium
- address: `address|住所|所在地` → medium

### preview コマンド

```bash
npx tsx src/cli/index.ts preview <file> [--encoding auto|utf8|cp932] [--delimiter ...] [--rows 100]
```

出力: `preview.json` + 標準出力サマリ。diagnosis / sourceFileHash / schemaFingerprint / columns / sampleRows / parseFailures / mappingSuggestions を含む。

UI: `GET /api/preview?file=...&encoding=...` を追加。

---

## Section 7: テスト・Fixture

### 新規 fixture

```
test/fixtures/utf8.csv
test/fixtures/utf8-bom.csv
test/fixtures/shiftjis.csv       # iconv-lite でエンコード生成
test/fixtures/no-header.csv
test/fixtures/malformed.csv      # 列崩れ・空行
test/fixtures/tab-delimited.tsv
```

### 新規テスト

```
test/ingest/encoding-detector.test.ts
test/ingest/delimiter-detector.test.ts
test/ingest/csv-ingest.test.ts
test/ingest/fingerprint.test.ts
test/core/normalizer-quarantine.test.ts
test/core/diff.test.ts
test/cli/preview.test.ts
```

### 既存テスト更新

- lineage 列追加・diagnosis 追加の影響で期待値を更新
- `pipeline.test.ts`, `batch-pipeline.test.ts`, `server.test.ts`

---

## 受け入れ条件

1. 実データの業務意味を知らなくても、FileMaker export に対して parse / preview / quarantine reason までは安定して成立する
2. 文字化けやヘッダ誤認で Normalized=0 / Quarantine=全件 / Classification=全0 になる状態を解消する
3. mapping 未完成でも raw 保全、preview、schema fingerprint、差分追跡が可能
4. 同一ファイルの再投入で import_run を分けて履歴比較できる
5. CSV 300万件級を想定したメモリ破綻しにくい実装
6. parse 失敗と business quarantine が混ざらない
7. typecheck / lint / test / build を通す
