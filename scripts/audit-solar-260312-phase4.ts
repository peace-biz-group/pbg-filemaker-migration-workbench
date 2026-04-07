#!/usr/bin/env npx tsx
/**
 * Solar 監査 Phase 4 — 260312 batch
 *
 * Phase 3 の成果物をもとに staging load plan を確定する。
 * DB 実行前の最終整理に限定。DDL 実行・Supabase 接続・本番 insert はしない。
 *
 * 生成物:
 *   1. staging-load-spec.md / staging-load-spec.json
 *   2. key-policy.md
 *   3. dedupe-policy.md
 *   4. activity-call-merge-policy.md
 *   5. activity-call-match-review-queue-prioritized.csv
 *   6. status-dictionary-candidate-v2.csv / status-hearing-guide.md
 *   7. staging-load-order.md / staging-precheck.sql / staging-postcheck.sql / staging-ddl-draft-v1.sql
 *   8. phase4-summary.md
 *
 * 実行: npm run audit:solar:phase4
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

// ─── paths ───────────────────────────────────────────────────────────
const PHASE3_DIR = resolve('artifacts/filemaker-audit/solar/260312/phase3');
const OUT_DIR = resolve('artifacts/filemaker-audit/solar/260312/phase4');

const INPUTS = {
  customerStaging: resolve(PHASE3_DIR, 'customer-staging-v0.csv'),
  reviewQueue: resolve(PHASE3_DIR, 'activity-call-match-review-queue.csv'),
  statusDict: resolve(PHASE3_DIR, 'status-dictionary-candidate.csv'),
  schemaJson: resolve(PHASE3_DIR, 'staging-schema-v0.json'),
  schemamd: resolve(PHASE3_DIR, 'staging-schema-v0.md'),
  schemaSql: resolve(PHASE3_DIR, 'staging-schema-v0.sql'),
} as const;

type Row = Record<string, string>;

// ─── helpers ─────────────────────────────────────────────────────────
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function readCsv(filePath: string): Row[] {
  const buf = readFileSync(filePath, 'utf-8');
  return parse(buf, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  }) as Row[];
}

function writeCsvFile(filePath: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    writeFileSync(filePath, '', 'utf-8');
  } else {
    writeFileSync(filePath, stringify(rows, { header: true }), 'utf-8');
  }
  console.log(`  -> ${basename(filePath)} (${rows.length} rows)`);
}

function writeMd(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf-8');
  console.log(`  -> ${basename(filePath)}`);
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  -> ${basename(filePath)}`);
}

function writeSql(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf-8');
  console.log(`  -> ${basename(filePath)}`);
}

// ─── main ────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Solar 260312 Phase 4: Staging Load Plan ===\n');
  ensureDir(OUT_DIR);

  // ── read inputs ──
  console.log('[1/8] Reading Phase 3 inputs...');
  const customers = readCsv(INPUTS.customerStaging);
  const reviewQueue = readCsv(INPUTS.reviewQueue);
  const statusDict = readCsv(INPUTS.statusDict);
  const schemaJson = JSON.parse(readFileSync(INPUTS.schemaJson, 'utf-8'));

  console.log(`  customers: ${customers.length} rows`);
  console.log(`  reviewQueue: ${reviewQueue.length} rows`);
  console.log(`  statusDict: ${statusDict.length} rows`);

  // Build customer lookup
  const customerMap = new Map<string, Row>();
  for (const c of customers) {
    if (c.customer_id) customerMap.set(c.customer_id, c);
  }

  // ── 1. staging-load-spec ──
  console.log('\n[2/8] Generating staging-load-spec...');
  generateStagingLoadSpec(schemaJson);

  // ── 2. key-policy / dedupe-policy ──
  console.log('\n[3/8] Generating key-policy and dedupe-policy...');
  generateKeyPolicy();
  generateDedupePolicy();

  // ── 3. activity-call-merge-policy ──
  console.log('\n[4/8] Generating activity-call-merge-policy...');
  generateMergePolicy();

  // ── 4. prioritized review queue ──
  console.log('\n[5/8] Generating prioritized review queue...');
  generatePrioritizedReviewQueue(reviewQueue, customerMap);

  // ── 5. status dictionary v2 ──
  console.log('\n[6/8] Generating status dictionary v2 and hearing guide...');
  generateStatusDictionaryV2(statusDict);
  generateStatusHearingGuide(statusDict);

  // ── 6. DB load package ──
  console.log('\n[7/8] Generating DB load package (draft, NOT for execution)...');
  generateLoadOrder();
  generatePrecheckSql();
  generatePostcheckSql();
  generateDdlDraft();

  // ── 7. phase4 summary ──
  console.log('\n[8/8] Generating phase4-summary...');
  generatePhase4Summary(reviewQueue, statusDict);

  console.log('\n=== Phase 4 complete. All artifacts in:', OUT_DIR, '===');
}

// ═══════════════════════════════════════════════════════════════════════
// Generators
// ═══════════════════════════════════════════════════════════════════════

function generateStagingLoadSpec(schemaJson: any) {
  const now = new Date().toISOString();

  const spec = {
    version: 'v0',
    generated: now,
    batch: '260312',
    domain: 'solar',
    load_order: [
      {
        order: 1,
        entity: 'customer',
        staging_table: 'staging_customer',
        primary_staging_file: 'customer-staging-v0.csv',
        load_source: '260312_顧客_太陽光.csv (マスタ行のみ)',
        estimated_rows: 5357,
        nullable_policy: 'customer_id, raw_source_file, raw_row_origin, source_fingerprint は NOT NULL。他は全て nullable',
        rejected_row_policy: 'customer_id が空の行は reject → rejected_rows テーブルへ。reject 理由を記録',
        rerun_policy: 'TRUNCATE staging_customer → 全件再投入。source_fingerprint で同一性を保証',
        audit_policy: 'raw_source_file + raw_row_origin + source_fingerprint で原本追跡可能。load_timestamp を付与',
        dependencies: [],
        notes: 'deal より先にロード。activity_call の customer_id 参照先',
      },
      {
        order: 2,
        entity: 'deal',
        staging_table: 'staging_deal',
        primary_staging_file: 'deal-staging-v0.csv',
        load_source: '260312_顧客_太陽光.csv (マスタ行のみ)',
        estimated_rows: 5357,
        nullable_policy: 'customer_id, raw_source_file, raw_row_origin, source_fingerprint は NOT NULL。他は全て nullable',
        rejected_row_policy: 'customer_id が空の行は reject。staging_customer に存在しない customer_id は warning ログ（reject はしない）',
        rerun_policy: 'TRUNCATE staging_deal → 全件再投入',
        audit_policy: 'raw_source_file + raw_row_origin + source_fingerprint で原本追跡可能',
        dependencies: ['staging_customer'],
        notes: 'customer と現時点で 1:1。1:N の可能性は未確定のまま保持',
      },
      {
        order: 3,
        entity: 'activity_call',
        staging_table: 'staging_activity_call',
        primary_staging_file: 'activity-call-union-candidate.csv',
        load_source: [
          '260312_コール履歴_太陽光.xlsx (source_a: 46572 rows)',
          '260312_顧客_太陽光.csv ポータル展開行 (source_b: 51150 rows)',
        ],
        estimated_rows: 97722,
        nullable_policy: 'source_kind, raw_source_file, raw_row_origin, source_fingerprint は NOT NULL。他は全て nullable',
        rejected_row_policy: 'call_date と content が両方空の行は reject。source_kind が不正な行は reject',
        rerun_policy: 'TRUNCATE staging_activity_call → 全件再投入。source_fingerprint で同一性を保証',
        audit_policy: 'source_kind で出元区別。raw_source_file + raw_row_origin で原本追跡',
        dependencies: ['staging_customer'],
        notes: 'source_a/source_b の merge は staging 投入後に行う。staging では両方保持',
      },
    ],
    global_policies: {
      encoding: 'UTF-8 (staging CSV は UTF-8 変換済み。raw は cp932)',
      load_strategy: 'TRUNCATE + INSERT (idempotent)',
      transaction: 'entity ごとに1トランザクション。失敗時は該当 entity のみ rollback',
      provenance: '全行に raw_source_file, raw_row_origin, source_fingerprint を付与',
      load_timestamp: '投入時に _loaded_at TIMESTAMPTZ を自動付与',
      schema_version: 'v0 (provisional)',
    },
  };

  writeJson(resolve(OUT_DIR, 'staging-load-spec.json'), spec);

  const md = `# Staging Load Spec — Solar 260312

> **注意**: この仕様は草案 (v0) です。DB 実行はしません。
> Phase 3 の staging schema v0 に基づく staging load 計画です。

生成日: ${now.split('T')[0]}

## Load Order

| # | Entity | Staging Table | Primary File | Rows | Dependencies |
|---|--------|---------------|-------------|------|-------------|
| 1 | customer | staging_customer | customer-staging-v0.csv | 5,357 | なし |
| 2 | deal | staging_deal | deal-staging-v0.csv | 5,357 | staging_customer |
| 3 | activity_call | staging_activity_call | activity-call-union-candidate.csv | 97,722 | staging_customer |

## Entity 別仕様

### 1. customer (staging_customer)

| 項目 | 内容 |
|------|------|
| Load Source | 260312_顧客_太陽光.csv (マスタ行のみ) |
| Primary File | customer-staging-v0.csv |
| Rows | 5,357 |
| NOT NULL | customer_id, raw_source_file, raw_row_origin, source_fingerprint |
| Rejected Row | customer_id が空 → rejected_rows テーブルへ |
| Re-run | TRUNCATE → 全件再投入 (idempotent) |
| Audit | raw_source_file + raw_row_origin + source_fingerprint で原本追跡 |

### 2. deal (staging_deal)

| 項目 | 内容 |
|------|------|
| Load Source | 260312_顧客_太陽光.csv (マスタ行のみ) |
| Primary File | deal-staging-v0.csv |
| Rows | 5,357 |
| NOT NULL | customer_id, raw_source_file, raw_row_origin, source_fingerprint |
| Rejected Row | customer_id が空 → reject。customer 不在は warning のみ |
| Re-run | TRUNCATE → 全件再投入 |
| Audit | raw_source_file + raw_row_origin + source_fingerprint |
| Note | customer と 1:1 の可能性が高いが未確定 |

### 3. activity_call (staging_activity_call)

| 項目 | 内容 |
|------|------|
| Load Source | コール履歴 XLSX (source_a: 46,572) + ポータル展開 (source_b: 51,150) |
| Primary File | activity-call-union-candidate.csv |
| Rows | 97,722 |
| NOT NULL | source_kind, raw_source_file, raw_row_origin, source_fingerprint |
| Rejected Row | call_date + content が両方空 → reject |
| Re-run | TRUNCATE → 全件再投入 |
| Audit | source_kind で出元区別 + raw_source_file + raw_row_origin |
| Note | source_a/source_b は staging では両方保持。merge は staging 後 |

## Global Policies

| Policy | 内容 |
|--------|------|
| Encoding | UTF-8 (staging CSV は変換済み) |
| Load Strategy | TRUNCATE + INSERT (idempotent) |
| Transaction | entity ごとに1トランザクション |
| Provenance | 全行に raw_source_file, raw_row_origin, source_fingerprint |
| Load Timestamp | _loaded_at TIMESTAMPTZ を自動付与 |
| Schema Version | v0 (provisional) |

## 未確定事項

1. customer / deal の 1:1 vs 1:N → ヒアリング後に確定
2. activity_call の source_a/source_b merge strategy → activity-call-merge-policy.md 参照
3. status dictionary の low confidence 項目 → status-hearing-guide.md 参照
4. unique key / fingerprint → key-policy.md 参照
`;

  writeMd(resolve(OUT_DIR, 'staging-load-spec.md'), md);
}

function generateKeyPolicy() {
  const md = `# Key Policy — Solar 260312

> **注意**: このポリシーは草案 (v0) です。unique 制約は provisional であり、ヒアリング後に確定します。

生成日: ${new Date().toISOString().split('T')[0]}

---

## customer

### Primary Key

| 項目 | 内容 |
|------|------|
| Candidate PK | customer_id (お客様ID) |
| Type | TEXT |
| Source | 260312_顧客_太陽光.csv の「お客様ID」列 |
| Uniqueness | マスタ行 5,357 件中ユニーク (Phase 1 で検証済み) |
| Format | \`RC[0-9][A-Z][0-9]{3}\` パターン (例: RC0L001, RC5E067) |
| Confidence | **high** — FileMaker が自動採番した ID。重複なし |

### Natural Key 候補

| Candidate | 構成列 | Uniqueness | Confidence | Note |
|-----------|--------|------------|------------|------|
| phone | phone (電話番号) | 低 — multi_match が 6.1% | low | 同一電話番号を複数顧客が共有 (家族/法人) |
| furigana + address | furigana + address | 中 — 未検証 | medium | 同姓同名同住所は稀だが皆無ではない |
| phone + furigana | phone + furigana | 高 — 未検証 | medium | 同一電話番号でもフリガナが異なれば区別可能 |

### Duplicate Warning 条件

以下の条件に合致する行は重複候補として警告:

1. **同一電話番号 + 同一住所**: 同じ電話番号と住所を持つ別 customer_id → 統合候補
2. **同一フリガナ + 同一電話番号**: 同じフリガナと電話番号 → 重複入力の可能性
3. **同一住所 + 類似フリガナ**: 住所一致 + フリガナのレーベンシュタイン距離 ≤ 2 → 入力揺れ候補

---

## deal

### Primary Key

| 項目 | 内容 |
|------|------|
| Candidate PK | (自動採番) — 現時点で deal 固有 ID は元データに存在しない |
| Surrogate Key | staging 投入時に deal_id (SERIAL/UUID) を自動生成 |
| FK | customer_id → staging_customer.customer_id |

### Customer との Relation

| 仮説 | 根拠 | Confidence |
|------|------|------------|
| **1:1** | 現データでは customer_id ごとに deal 行が1行。マスタ行 5,357 = deal 行 5,357 | high (現データ上) |
| 1:N | FileMaker 上で同一顧客に複数案件がある可能性 (太陽光 + 蓄電池など)。ただし 260312 batch は太陽光のみ | low (現 batch では) |

**判定**: 現 batch では 1:1 として staging。ただし schema は 1:N に対応可能な形（deal_id 独立、customer_id FK）で設計済み。

### 1:1 仮説と 1:N 仮説の保持

\`\`\`
staging_deal に deal_id (surrogate) を付与することで、
将来的に 1:N が判明した場合にも既存データの再投入なしで対応可能。
現時点では customer_id が実質的な unique key として機能する。
\`\`\`

---

## activity_call

### Source A / B 共通 Fingerprint

| 項目 | 内容 |
|------|------|
| 構成 | \`normalizeDate(call_date) + '|' + call_staff + '|' + content_first_80\` |
| 用途 | Source A / B 間の同一レコード検出 |
| 一致率 | 11.0% (Phase 2 で検証済み) |
| Confidence | **medium** — 内容テキストの差異で一致率が下がっている可能性あり |

### Source-Specific Fingerprint

| Source | 構成 | 用途 |
|--------|------|------|
| Source A | \`source_fingerprint\` = \`260312_コール履歴_太陽光.xlsx:row_N\` | raw 原本追跡 |
| Source B | \`source_fingerprint\` = \`260312_顧客_太陽光.csv:row_N\` | raw 原本追跡 |

### Soft Dedupe Key

| Key | 構成 | 用途 | Note |
|-----|------|------|------|
| date_staff | \`call_date + call_staff\` | ルーズ一致 (日付+担当者) で候補抽出 | 一致率 8.4% (ルーズ) |
| date_staff_content80 | \`call_date + call_staff + content_first_80\` | 厳密一致で同一レコード判定 | 一致率 11.0% |
| phone_date | \`normalized_phone + call_date\` | 同一顧客の同日コール検出 | Source A のみ (B は phone なし) |

### Hard Dedupe

**Phase 4 では実施しない。** 以下の理由:

1. Source A/B が同一 FileMaker DB の異なるエクスポートパスである可能性が高いが、確証がない
2. 内容テキストの微差（全角/半角、改行、切り捨て長）で fingerprint が一致しないケースがある
3. 統合判断は merge policy に基づき、ヒアリング後に Phase 5 で実施

---

## Fingerprint Format Summary

| Entity | Fingerprint | Format | Example |
|--------|-------------|--------|---------|
| customer | source_fingerprint | \`{filename}:row_{N}\` | \`260312_顧客_太陽光.csv:row_2\` |
| deal | source_fingerprint | \`{filename}:row_{N}\` | \`260312_顧客_太陽光.csv:row_2\` |
| activity_call | source_fingerprint | \`{filename}:row_{N}\` | \`260312_コール履歴_太陽光.xlsx:row_80\` |
| activity_call | cross_source_fp | \`{date}|{staff}|{content80}\` | \`2021-02-25|篠原里代|工事完了\` |
`;

  writeMd(resolve(OUT_DIR, 'key-policy.md'), md);
}

function generateDedupePolicy() {
  const md = `# Dedupe Policy — Solar 260312

> **注意**: このポリシーは草案 (v0) です。hard dedupe は Phase 4 では実施しません。

生成日: ${new Date().toISOString().split('T')[0]}

---

## 原則

1. **staging では dedupe しない** — 全件を投入し、重複候補のフラグのみ付与
2. **soft dedupe = 候補抽出** — 人手レビューの対象を絞る
3. **hard dedupe = 確定統合** — ヒアリング後に Phase 5 以降で実施
4. **元データの保全** — 統合後も source_fingerprint で原本に遡れること

---

## customer dedupe

### 方針

customer_id (お客様ID) が FileMaker 自動採番のため、同一 customer_id の重複は発生しない。
ただし、**同一人物が異なる customer_id で登録されている可能性** がある。

### Soft Dedupe Rules

| Rule | 条件 | 期待件数 | Action |
|------|------|---------|--------|
| same_phone_same_address | phone が一致 AND 住所の都道府県+市区が一致 | 要調査 | 統合候補として review queue へ |
| same_furigana_same_phone | furigana が一致 AND phone が一致 | 要調査 | 高確率重複。review queue (priority: high) |
| same_address_similar_name | 住所完全一致 AND フリガナのレーベンシュタイン距離 ≤ 2 | 要調査 | 入力ゆれ候補。review queue (priority: medium) |

### Hard Dedupe

Phase 4 では **実施しない**。理由:
- 家族共有電話番号のケースが存在 (multi_match の原因)
- 法人の複数担当者が同一電話番号を使うケースがある
- 統合の判断には現場の業務知識が必要

---

## deal dedupe

### 方針

deal は customer と 1:1 の状態。customer が統合された場合に deal の統合が必要になるが、
現 batch ではこの状況は発生しない。

### 注意事項

- 同一 customer_id に複数 deal がないことは Phase 3 で確認済み
- 将来的に他 batch (蓄電池等) のデータが入った場合に 1:N が発生する可能性あり

---

## activity_call dedupe

### Source 内 dedupe

Source A / Source B それぞれの内部で同一レコードが重複する可能性は低い（各 source は FileMaker の単一エクスポート）。

### Source 間 dedupe (A ↔ B)

| 項目 | 値 |
|------|-----|
| 厳密一致 (date + staff + content80) | 4,280 件 (11.0%) |
| ルーズ一致 (date + staff のみ) | 3,285 件 (8.4%) |
| Source A のみ | 35,372 件 |
| Source B のみ | 34,689 件 |
| 判定 | **partial_overlap** |

### Phase 4 の対応

1. staging には **両方 (A + B) を投入** する
2. \`source_kind\` 列で出元を区別
3. cross_source_fingerprint (\`call_date|call_staff|content_first_80\`) を付与
4. 統合は merge policy に基づき Phase 5 で実施

### 将来の Hard Dedupe 手順 (Phase 5 予定)

\`\`\`
Step 1: cross_source_fp が完全一致 → 同一レコードとして片方を inactive 化
Step 2: date + staff が一致 + content のレーベンシュタイン距離 ≤ 10 → 同一候補
Step 3: 残りは review queue → 人手判断
\`\`\`

---

## Dedupe Flag Schema

staging テーブルに将来追加予定の列:

| Column | Type | Description |
|--------|------|------------|
| _dedupe_group_id | TEXT | 同一グループと判定されたレコードをグループ化 |
| _dedupe_status | TEXT | 'active' / 'inactive' / 'pending_review' |
| _dedupe_method | TEXT | 'exact_fp' / 'loose_fp' / 'manual' |
| _dedupe_decided_at | TIMESTAMPTZ | 判定日時 |
| _dedupe_decided_by | TEXT | 判定者 |

**Phase 4 では上記列は定義のみ。データ投入は Phase 5 以降。**
`;

  writeMd(resolve(OUT_DIR, 'dedupe-policy.md'), md);
}

function generateMergePolicy() {
  const md = `# Activity Call Merge Policy — Solar 260312

> **注意**: この方針は草案です。ヒアリング後に確定します。

生成日: ${new Date().toISOString().split('T')[0]}

---

## 背景

activity_call は 2 つのソースから構成される:

| Source | File | Rows | 特徴 |
|--------|------|------|------|
| **A** | 260312_コール履歴_太陽光.xlsx | 46,572 | 独立テーブル。電話番号【検索】あり。担当者25名。日時が秒単位 |
| **B** | 260312_顧客_太陽光.csv (ポータル展開) | 51,150 | 顧客レコードに紐づく。customer_id (fill-forward) あり。電話番号なし |

### Overlap 分析 (Phase 2)

| 指標 | 値 |
|------|-----|
| 厳密一致 (date + staff + content80) | 4,280 件 (11.0%) |
| ルーズ一致 (date + staff) | 3,285 件 (8.4%) |
| A のみ | 35,372 件 |
| B のみ | 34,689 件 |

**結論**: 同一 FileMaker DB の異なるエクスポートパスだが、各 source に固有のレコードが存在。単純な A ⊇ B でも B ⊇ A でもない。

---

## 3 案比較

### 案 1: A 正 / B 補完

Source A を primary、Source B を補完情報として使う。

| 項目 | 内容 |
|------|------|
| **長所** | A は電話番号があり customer 紐付けに使える。独立テーブルで構造がクリーン |
| **欠点** | B にしかない 34,689 件を捨てるか、secondary として扱う必要がある |
| **件数影響** | primary: 46,572 + secondary: ~34,689 = 約 81,261 件 |
| **review 増減** | multi_match/no_match の review は A 基準で 3,806 件のまま |
| **Ops Core 接続** | A の電話番号紐付けが Ops Core の customer 参照に使える |

### 案 2: B 正 / A 補完

Source B を primary、Source A を補完情報として使う。

| 項目 | 内容 |
|------|------|
| **長所** | B は customer_id (fill-forward) で直接紐付け済み。紐付け精度が高い |
| **欠点** | A にしかない 35,372 件を secondary 扱い。B の fill-forward customer_id は推定値 |
| **件数影響** | primary: 51,150 + secondary: ~35,372 = 約 86,522 件 |
| **review 増減** | B 側の review は少ない (fill-forward で紐付け済み) が、A の secondary 分で増加 |
| **Ops Core 接続** | B の fill-forward customer_id は Ops Core に直接使えるが、精度保証なし |

### 案 3: 並存保持 + Downstream Review (推奨)

両方を staging に投入し、downstream で統合判断。

| 項目 | 内容 |
|------|------|
| **長所** | データ欠損なし。source_kind で出元を区別。11% の重複は cross_source_fp で検出可能 |
| **欠点** | staging 行数が最大 (97,722)。downstream の統合ロジックが必要 |
| **件数影響** | staging: 97,722 件 (うち推定重複 4,280 件) |
| **review 増減** | 重複判定の review が追加で必要 (~4,280 件) |
| **Ops Core 接続** | source_kind ごとに異なる紐付け方法を Ops Core 側で選択可能 |

---

## 比較マトリクス

| 評価軸 | 案1 (A正) | 案2 (B正) | 案3 (並存) |
|--------|----------|----------|----------|
| データ完全性 | △ B固有を失うリスク | △ A固有を失うリスク | ◎ 全件保持 |
| 紐付け精度 | ○ 電話番号ベース | ○ fill-forward ID | ○ 両方利用可能 |
| review 負荷 | ○ 既存 3,806 件 | ○ 少ない | △ +4,280 件 |
| staging 複雑度 | ○ シンプル | ○ シンプル | △ 両 source 管理 |
| 可逆性 | △ 判断を先行 | △ 判断を先行 | ◎ 判断を後回し |
| Ops Core 接続 | ○ | ○ | ◎ 柔軟 |
| 安全性 | ○ | ○ | ◎ fail-safe |

---

## 推奨案: 案 3 (並存保持 + Downstream Review)

### 推奨理由

1. **安全側に倒す原則** — CLAUDE.md の最優先事項「unsafe な自動確定をしない」に合致
2. **データ欠損リスクゼロ** — A にしかない 35,372 件、B にしかない 34,689 件の両方を保持
3. **判断を後回しにできる** — merge 判断は Phase 5 でヒアリング結果を踏まえて行う
4. **可逆性** — staging に全件あれば、どの merge strategy にも後から切り替え可能
5. **Phase 3 の方針と整合** — Phase 3 で activity-call-union-candidate.csv (97,722 行) を生成済み

### 実装方針

\`\`\`
1. staging_activity_call に A + B を全件投入 (97,722 行)
2. source_kind 列で 'source_a' / 'source_b' を区別
3. cross_source_fp (date|staff|content80) を計算列として追加
4. Phase 5 で merge 判断:
   - cross_source_fp 一致 → 重複として片方を inactive 化
   - A の電話番号紐付け + B の fill-forward ID を相互補完
   - 不一致分は review queue へ
\`\`\`

### リスクと対策

| リスク | 対策 |
|--------|------|
| staging 行数が多い (97K) | staging テーブルにインデックスを適切に設定 |
| downstream で merge 忘れ | Phase 5 のタスクとして明示的に追跡 |
| 重複行が Ops Core に流入 | staging → production の間に merge gate を設ける |
`;

  writeMd(resolve(OUT_DIR, 'activity-call-merge-policy.md'), md);
}

function generatePrioritizedReviewQueue(
  reviewQueue: Row[],
  customerMap: Map<string, Row>,
) {
  const prioritized: Record<string, unknown>[] = [];

  for (const row of reviewQueue) {
    const reason = row.review_reason;
    if (!reason || !['multi_match', 'no_match', 'invalid'].includes(reason)) {
      continue; // skip malformed rows
    }

    const candidateIds = (row.candidate_customer_ids || '')
      .split(';')
      .filter(Boolean);
    const candidateCount = parseInt(row.candidate_count || '0', 10);

    let priority: string;
    let suggestedAction: string;
    let reviewBucket: string;
    let expectedResolutionPath: string;

    if (reason === 'multi_match') {
      // Subcategorize multi_match
      const bucket = classifyMultiMatch(candidateIds, customerMap);
      reviewBucket = bucket;

      if (candidateCount >= 10) {
        priority = 'low';
        suggestedAction = 'bulk_pattern_review';
        expectedResolutionPath =
          'shared_phone_number — 電話番号が営業担当の携帯等である可能性。現場に電話番号の持ち主を確認';
      } else if (candidateCount >= 3) {
        priority = 'medium';
        suggestedAction = 'manual_review';
        expectedResolutionPath =
          'content/日付から正しい customer を特定。3件以上候補があるため慎重に';
      } else {
        // candidateCount === 2
        if (bucket === 'family_shared_phone') {
          priority = 'medium';
          suggestedAction = 'content_based_match';
          expectedResolutionPath =
            '同一住所の家族。コール内容から対象者を特定';
        } else if (bucket === 'same_phone_different_name') {
          priority = 'high';
          suggestedAction = 'manual_review';
          expectedResolutionPath =
            '異なる人物が同一電話番号を使用。コール内容/日付/担当者名から正しい顧客を特定';
        } else {
          priority = 'high';
          suggestedAction = 'manual_review';
          expectedResolutionPath =
            '候補顧客の情報を比較し、コール内容から正しい紐付け先を特定';
        }
      }
    } else if (reason === 'no_match') {
      priority = 'medium';
      suggestedAction = 'investigate_phone';
      reviewBucket = 'no_match';
      expectedResolutionPath =
        '電話番号が顧客マスタに未登録。新規顧客か電話番号変更か現場に確認';
    } else {
      // invalid
      priority = 'low';
      suggestedAction = 'data_quality_fix';
      reviewBucket = 'invalid_phone';
      expectedResolutionPath =
        '電話番号フィールドに非電話データ (住所・メモ等) が入力されている。原本を確認し正しい電話番号を特定';
    }

    prioritized.push({
      review_reason: reason,
      severity: row.severity,
      priority,
      review_bucket: reviewBucket,
      suggested_action: suggestedAction,
      expected_resolution_path: expectedResolutionPath,
      source_kind: row.source_kind,
      source_file: row.source_file,
      normalized_phone: row.normalized_phone,
      raw_phone: row.raw_phone,
      candidate_customer_ids: row.candidate_customer_ids,
      candidate_count: row.candidate_count,
      call_date: row.call_date,
      call_time: row.call_time,
      call_owner: row.call_owner,
      content_preview: row.content_preview,
      raw_row_origin: row.raw_row_origin,
    });
  }

  // Sort by priority
  const priorityOrder: Record<string, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  prioritized.sort(
    (a, b) =>
      (priorityOrder[a.priority as string] ?? 9) -
      (priorityOrder[b.priority as string] ?? 9),
  );

  writeCsvFile(
    resolve(OUT_DIR, 'activity-call-match-review-queue-prioritized.csv'),
    prioritized,
  );

  // Print summary
  const bucketCounts: Record<string, number> = {};
  const priorityCounts: Record<string, number> = {};
  for (const r of prioritized) {
    const b = r.review_bucket as string;
    const p = r.priority as string;
    bucketCounts[b] = (bucketCounts[b] || 0) + 1;
    priorityCounts[p] = (priorityCounts[p] || 0) + 1;
  }
  console.log('  Priority summary:', priorityCounts);
  console.log('  Bucket summary:', bucketCounts);
}

function classifyMultiMatch(
  candidateIds: string[],
  customerMap: Map<string, Row>,
): string {
  if (candidateIds.length < 2) return 'unclear';

  const candidates = candidateIds
    .map((id) => customerMap.get(id))
    .filter(Boolean) as Row[];

  if (candidates.length < 2) return 'unclear';

  // Check if candidates share the same address (family)
  const addresses = candidates.map((c) => c.address || '').filter(Boolean);
  if (addresses.length >= 2) {
    const uniqueAddresses = new Set(addresses);
    if (uniqueAddresses.size === 1) {
      return 'family_shared_phone';
    }

    // Check if addresses share the same city/district (first ~15 chars)
    const prefixes = addresses.map((a) => a.substring(0, 15));
    const uniquePrefixes = new Set(prefixes);
    if (uniquePrefixes.size === 1) {
      return 'same_phone_different_name';
    }
  }

  // Check if names are similar
  const names = candidates.map((c) => c.furigana || '').filter(Boolean);
  if (names.length >= 2) {
    const uniqueNames = new Set(names);
    if (uniqueNames.size === 1) {
      // Same name, same phone — likely duplicate customer record
      return 'same_name_same_phone';
    }
  }

  return 'unclear';
}

function generateStatusDictionaryV2(statusDict: Row[]) {
  const enriched: Record<string, unknown>[] = [];

  const hearingQuestions: Record<string, string> = {
    再訪問調整中:
      '「再訪問調整中」は、初回訪問後に再度の訪問が必要な状態ですか？ どのような場合に使われますか？',
    回収保留:
      '「回収保留」は、工事完了後の代金回収が止まっている状態ですか？ 保留の判断基準は何ですか？',
    現調待ち:
      '「現調待ち」は「現地調査待ち」の略ですか？ 見積依頼後の段階ですか？',
    工事日調整中:
      '「工事日調整中」は契約済みで工事日程を決めている段階ですか？',
    現調申込:
      '「現調申込」は現地調査の依頼を業者に出した段階ですか？ 「現調待ち」との違いは？',
    発注待ち:
      '「発注待ち」は契約済みで部材の発注を待っている段階ですか？',
    現調日調整中:
      '「現調日調整中」は現地調査の日程を調整している段階ですか？ 「現調待ち」「現調申込」との違いは？',
    電力申請依頼要:
      '「電力申請依頼要」は電力会社への申請がまだ出ていない状態ですか？ 誰が申請しますか？',
    対応中:
      '「対応中」は具体的にどの段階ですか？ 見積段階？ 工事段階？ それとも包括的な状態ですか？',
    書類待ち:
      '「書類待ち」は何の書類を待っていますか？ 契約書？ 補助金申請書類？',
  };

  const provisionalRevisions: Record<string, string> = {
    再訪問調整中: 'follow_up_scheduling',
    回収保留: 'payment_on_hold',
    現調待ち: 'waiting_site_survey',
    工事日調整中: 'construction_scheduling',
    現調申込: 'site_survey_requested',
    発注待ち: 'waiting_order',
    現調日調整中: 'site_survey_scheduling',
    電力申請依頼要: 'power_application_needed',
  };

  // Calculate impact scores (count * confidence weight)
  const confidenceWeight: Record<string, number> = {
    high: 1,
    medium: 2,
    low: 3,
  };

  for (const row of statusDict) {
    const count = parseInt(row.count || '0', 10);
    const confidence = row.stage_confidence || 'low';
    const statusVal = row.status_value || '';
    const impactScore = count * (confidenceWeight[confidence] || 3);

    enriched.push({
      status_value: statusVal,
      count: row.count,
      percentage: row.percentage,
      sample_customer_ids: row.sample_customer_ids,
      normalized_stage:
        provisionalRevisions[statusVal] || row.normalized_stage,
      stage_confidence: confidence,
      normalized_stage_v0: row.normalized_stage,
      revised_in_v2:
        provisionalRevisions[statusVal] && provisionalRevisions[statusVal] !== row.normalized_stage
          ? 'yes'
          : 'no',
      impact_score: impactScore,
      priority_rank: '', // filled after sort
      hearing_question: hearingQuestions[statusVal] || '',
      requires_hearing: row.requires_hearing || '',
    });
  }

  // Sort by impact_score descending
  enriched.sort(
    (a, b) => (b.impact_score as number) - (a.impact_score as number),
  );

  // Assign priority rank
  enriched.forEach((r, i) => {
    r.priority_rank = i + 1;
  });

  writeCsvFile(
    resolve(OUT_DIR, 'status-dictionary-candidate-v2.csv'),
    enriched,
  );
}

function generateStatusHearingGuide(statusDict: Row[]) {
  const lowConfidence = statusDict.filter(
    (r) => r.stage_confidence === 'low' || r.stage_confidence === 'medium',
  );

  let md = `# ステータスヒアリングガイド — Solar 260312

> このガイドは、status dictionary の confidence が low/medium の項目について、
> 現場に確認すべき質問をまとめたものです。

生成日: ${new Date().toISOString().split('T')[0]}

---

## ヒアリング目的

Phase 3 で生成した status-dictionary-candidate.csv には 16 種のステータス値があります。
そのうち **8 件が low confidence**、**2 件が medium confidence** です。
正しい normalized_stage を確定するために、現場の業務知識が必要です。

## ヒアリング優先順位

影響度（件数 × confidence 低さ）で並べています。

| # | ステータス値 | 件数 | 割合 | 現在の仮 stage | confidence | 質問 |
|---|-------------|------|------|---------------|------------|------|
`;

  const sorted = [...lowConfidence].sort((a, b) => {
    const weightA = parseInt(a.count || '0', 10) * (a.stage_confidence === 'low' ? 3 : 2);
    const weightB = parseInt(b.count || '0', 10) * (b.stage_confidence === 'low' ? 3 : 2);
    return weightB - weightA;
  });

  sorted.forEach((row, i) => {
    const questions: Record<string, string> = {
      再訪問調整中:
        '初回訪問後に再度訪問が必要な状態ですか？ どんな場合に使いますか？',
      回収保留:
        '代金回収が止まっている状態ですか？ 保留の判断基準は？',
      現調待ち:
        '「現地調査待ち」の略ですか？ 見積依頼後の段階ですか？',
      対応中:
        '具体的にどの段階ですか？ 見積？ 工事？ 包括的な状態？',
      書類待ち: '何の書類を待っていますか？ 契約書？ 補助金申請書類？',
      工事日調整中: '契約済みで工事日程を決めている段階ですか？',
      現調申込:
        '現地調査の依頼を業者に出した段階ですか？ 「現調待ち」との違いは？',
      発注待ち: '契約済みで部材の発注を待っている段階ですか？',
      現調日調整中:
        '現地調査の日程を調整している段階ですか？ 「現調待ち」との違いは？',
      電力申請依頼要:
        '電力会社への申請がまだ出ていない状態ですか？ 誰が申請しますか？',
    };

    const q = questions[row.status_value] || '業務上の意味を確認してください';
    md += `| ${i + 1} | ${row.status_value} | ${row.count} | ${row.percentage} | ${row.normalized_stage} | ${row.stage_confidence} | ${q} |\n`;
  });

  md += `
---

## ヒアリング時の注意事項

1. **選択肢を出す** — 「これは〇〇の意味ですか？ それとも△△ですか？」と具体的に聞く
2. **使用頻度を確認** — 今も使われているステータスか、過去のものか
3. **フローを確認** — このステータスの前は何か、次は何に変わるか
4. **例外を確認** — 「通常はこうだが、たまにこういうケースもある」を拾う
5. **記録者に聞く** — sample_customer_ids の行を見せて「これはどういう状況でしたか」と聞く

## 追加で確認すべき事項

### 審査結果の値

| 値 | 件数 | 質問 |
|----|------|------|
| 連変 | 要調査 | 「連変」とは何ですか？ 連絡変更？ 連系変更？ |
| 取り直し | 要調査 | 何を取り直すのですか？ 審査の再申請？ |
| 審査不可 | 要調査 | 否決とは違いますか？ 審査自体ができなかった？ |

### customer / deal 関連

| 項目 | 質問 |
|------|------|
| 契約者 vs 顧客 | 契約者と顧客 (お客様) は同一人物ですか？ 家族名義の場合はありますか？ |
| 代表者 | 「代表者」は法人の代表ですか？ 個人の場合の世帯主ですか？ |
| 申込者 | 「申込者」は契約者と同一ですか？ 別の人が申し込むケースはありますか？ |
| 見積依頼日 vs 【見積】依頼日 | この2つの日付は同じ意味ですか？ 別のフローですか？ |
`;

  writeMd(resolve(OUT_DIR, 'status-hearing-guide.md'), md);
}

function generateLoadOrder() {
  const md = `# Staging Load Order — Solar 260312

> **注意**: この load order は草案です。実行はしません。

生成日: ${new Date().toISOString().split('T')[0]}

---

## Load Sequence

\`\`\`
Step 0: Pre-check (staging-precheck.sql)
  ↓
Step 1: CREATE TABLE (staging-ddl-draft-v1.sql)
  ↓
Step 2: LOAD staging_customer (5,357 rows)
  ├─ Source: customer-staging-v0.csv
  ├─ Method: COPY FROM CSV / bulk INSERT
  └─ Validation: customer_id NOT NULL, unique check
  ↓
Step 3: LOAD staging_deal (5,357 rows)
  ├─ Source: deal-staging-v0.csv
  ├─ Method: COPY FROM CSV / bulk INSERT
  ├─ Validation: customer_id NOT NULL
  └─ FK check: customer_id EXISTS IN staging_customer (warning only)
  ↓
Step 4: LOAD staging_activity_call (97,722 rows)
  ├─ Source: activity-call-union-candidate.csv
  ├─ Method: COPY FROM CSV / bulk INSERT
  ├─ Validation: source_kind IN ('source_a', 'source_b')
  └─ Validation: raw_source_file NOT NULL
  ↓
Step 5: Post-check (staging-postcheck.sql)
\`\`\`

## Load 方法

### 推奨: PostgreSQL COPY

\`\`\`sql
-- Step 2
\\COPY staging_customer FROM 'customer-staging-v0.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

-- Step 3
\\COPY staging_deal FROM 'deal-staging-v0.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

-- Step 4
\\COPY staging_activity_call FROM 'activity-call-union-candidate.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');
\`\`\`

### 代替: Supabase CLI / REST API

activity_call の 97K 行は REST API のバッチ INSERT では遅い可能性がある。
COPY または pg_dump / pg_restore を推奨。

## Re-run 手順

\`\`\`sql
-- idempotent re-run
BEGIN;
TRUNCATE staging_activity_call;
TRUNCATE staging_deal;
TRUNCATE staging_customer;
-- then re-COPY
COMMIT;
\`\`\`

## 所要時間見積もり

| Step | 推定時間 |
|------|---------|
| Pre-check | < 1 sec |
| DDL | < 1 sec |
| customer COPY | < 1 sec |
| deal COPY | < 2 sec |
| activity_call COPY | 5-15 sec |
| Post-check | < 5 sec |
| **合計** | **< 30 sec** |

## 注意事項

1. **実行禁止** — Phase 4 では DDL / DML を実行しない
2. **Supabase 接続禁止** — Phase 4 ではローカルのみ
3. **raw ファイル非接触** — raw ファイルには触れない
`;

  writeMd(resolve(OUT_DIR, 'staging-load-order.md'), md);
}

function generatePrecheckSql() {
  const sql = `-- staging-precheck.sql — Solar 260312
-- 実行前の事前チェック。staging テーブルの状態を確認する。
-- NOTE: このファイルは草案です。実行は Phase 5 以降。

-- 1. staging テーブルが存在するか確認
SELECT table_name,
       (SELECT count(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
FROM information_schema.tables t
WHERE table_schema = 'public'
  AND table_name IN ('staging_customer', 'staging_deal', 'staging_activity_call')
ORDER BY table_name;

-- 2. 既存データがあるか確認 (re-run 判定用)
SELECT 'staging_customer' as tbl, count(*) as row_count FROM staging_customer
UNION ALL
SELECT 'staging_deal', count(*) FROM staging_deal
UNION ALL
SELECT 'staging_activity_call', count(*) FROM staging_activity_call;

-- 3. 制約の確認
SELECT conname, conrelid::regclass, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid::regclass::text IN ('staging_customer', 'staging_deal', 'staging_activity_call');

-- 4. disk space 概算 (staging テーブルのサイズ)
SELECT relname,
       pg_size_pretty(pg_total_relation_size(oid)) as total_size
FROM pg_class
WHERE relname IN ('staging_customer', 'staging_deal', 'staging_activity_call');
`;

  writeSql(resolve(OUT_DIR, 'staging-precheck.sql'), sql);
}

function generatePostcheckSql() {
  const sql = `-- staging-postcheck.sql — Solar 260312
-- 投入後の整合性チェック。
-- NOTE: このファイルは草案です。実行は Phase 5 以降。

-- ═══════════════════════════════════════════════════════════════
-- 1. Row count validation
-- ═══════════════════════════════════════════════════════════════

SELECT 'staging_customer' as entity,
       count(*) as actual_rows,
       5357 as expected_rows,
       CASE WHEN count(*) = 5357 THEN 'OK' ELSE 'MISMATCH' END as status
FROM staging_customer
UNION ALL
SELECT 'staging_deal',
       count(*),
       5357,
       CASE WHEN count(*) = 5357 THEN 'OK' ELSE 'MISMATCH' END
FROM staging_deal
UNION ALL
SELECT 'staging_activity_call',
       count(*),
       97722,
       CASE WHEN count(*) = 97722 THEN 'OK' ELSE 'MISMATCH' END
FROM staging_activity_call;

-- ═══════════════════════════════════════════════════════════════
-- 2. NOT NULL constraint check
-- ═══════════════════════════════════════════════════════════════

-- customer: customer_id must not be null
SELECT 'customer_null_id' as check_name,
       count(*) as violation_count
FROM staging_customer
WHERE customer_id IS NULL OR customer_id = '';

-- deal: customer_id must not be null
SELECT 'deal_null_customer_id' as check_name,
       count(*) as violation_count
FROM staging_deal
WHERE customer_id IS NULL OR customer_id = '';

-- activity_call: source_kind must not be null
SELECT 'activity_null_source_kind' as check_name,
       count(*) as violation_count
FROM staging_activity_call
WHERE source_kind IS NULL OR source_kind = '';

-- ═══════════════════════════════════════════════════════════════
-- 3. Uniqueness check
-- ═══════════════════════════════════════════════════════════════

-- customer_id should be unique in staging_customer
SELECT 'customer_id_duplicates' as check_name,
       count(*) as duplicate_count
FROM (
  SELECT customer_id, count(*) as cnt
  FROM staging_customer
  GROUP BY customer_id
  HAVING count(*) > 1
) dupes;

-- source_fingerprint should be unique across all entities
SELECT 'fingerprint_duplicates_customer' as check_name,
       count(*) as duplicate_count
FROM (
  SELECT source_fingerprint, count(*) as cnt
  FROM staging_customer
  GROUP BY source_fingerprint
  HAVING count(*) > 1
) dupes;

SELECT 'fingerprint_duplicates_deal' as check_name,
       count(*) as duplicate_count
FROM (
  SELECT source_fingerprint, count(*) as cnt
  FROM staging_deal
  GROUP BY source_fingerprint
  HAVING count(*) > 1
) dupes;

-- ═══════════════════════════════════════════════════════════════
-- 4. Referential integrity check
-- ═══════════════════════════════════════════════════════════════

-- deal.customer_id should exist in customer
SELECT 'deal_orphan_customer_id' as check_name,
       count(*) as orphan_count
FROM staging_deal d
WHERE NOT EXISTS (
  SELECT 1 FROM staging_customer c WHERE c.customer_id = d.customer_id
);

-- activity_call.matched_customer_id should exist in customer (where not null)
SELECT 'activity_orphan_matched_id' as check_name,
       count(*) as orphan_count
FROM staging_activity_call a
WHERE a.matched_customer_id IS NOT NULL
  AND a.matched_customer_id != ''
  AND NOT EXISTS (
    SELECT 1 FROM staging_customer c WHERE c.customer_id = a.matched_customer_id
  );

-- ═══════════════════════════════════════════════════════════════
-- 5. source_kind distribution
-- ═══════════════════════════════════════════════════════════════

SELECT source_kind, count(*) as row_count,
       round(100.0 * count(*) / sum(count(*)) over(), 1) as pct
FROM staging_activity_call
GROUP BY source_kind
ORDER BY source_kind;

-- ═══════════════════════════════════════════════════════════════
-- 6. match_type distribution (activity_call)
-- ═══════════════════════════════════════════════════════════════

SELECT match_type, count(*) as row_count,
       round(100.0 * count(*) / sum(count(*)) over(), 1) as pct
FROM staging_activity_call
GROUP BY match_type
ORDER BY row_count DESC;

-- ═══════════════════════════════════════════════════════════════
-- 7. Status distribution (deal)
-- ═══════════════════════════════════════════════════════════════

SELECT status, count(*) as row_count,
       round(100.0 * count(*) / sum(count(*)) over(), 1) as pct
FROM staging_deal
WHERE status IS NOT NULL AND status != ''
GROUP BY status
ORDER BY row_count DESC;

-- ═══════════════════════════════════════════════════════════════
-- 8. Summary
-- ═══════════════════════════════════════════════════════════════

SELECT 'post_check_complete' as status,
       now() as checked_at;
`;

  writeSql(resolve(OUT_DIR, 'staging-postcheck.sql'), sql);
}

function generateDdlDraft() {
  const sql = `-- staging-ddl-draft-v1.sql — Solar 260312
-- NOTE: このファイルは草案 (v1) です。
-- NOTE: 実行禁止。Supabase 接続禁止。
-- NOTE: unique / index 制約は provisional です。ヒアリング後に確定。

-- ═══════════════════════════════════════════════════════════════
-- staging_customer
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_customer (
  -- PK (provisional)
  customer_id        TEXT NOT NULL,

  -- 基本情報
  furigana            TEXT,
  address             TEXT,
  postal_code         TEXT,
  phone               TEXT,
  phone_search        TEXT,
  fax                 TEXT,
  email               TEXT,

  -- 代表者情報
  representative_furigana TEXT,
  representative_mobile   TEXT,
  representative_birthday DATE,

  -- 担当者情報
  contact_furigana    TEXT,
  contact_mobile      TEXT,
  emergency_contact   TEXT,

  -- 属性
  occupation          TEXT,
  industry_subclass   TEXT,

  -- FileMaker レガシー
  fm_password         TEXT,
  fm_username         TEXT,

  -- その他
  invoice_registration TEXT,
  application_id      TEXT,
  contact_info        TEXT,
  preferred_contact_time TEXT,

  -- traceability
  raw_source_file     TEXT NOT NULL,
  raw_row_origin      INTEGER NOT NULL,
  source_fingerprint  TEXT NOT NULL,

  -- audit (load 時に自動付与)
  _loaded_at          TIMESTAMPTZ DEFAULT now(),
  _batch_id           TEXT DEFAULT '260312',
  _schema_version     TEXT DEFAULT 'v0'
);

-- provisional unique constraint
-- ALTER TABLE staging_customer ADD CONSTRAINT staging_customer_pk PRIMARY KEY (customer_id);
-- provisional index
-- CREATE INDEX IF NOT EXISTS idx_staging_customer_phone ON staging_customer (phone);
-- CREATE INDEX IF NOT EXISTS idx_staging_customer_phone_search ON staging_customer (phone_search);
-- CREATE INDEX IF NOT EXISTS idx_staging_customer_fingerprint ON staging_customer (source_fingerprint);

-- ═══════════════════════════════════════════════════════════════
-- staging_deal
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_deal (
  -- surrogate PK (provisional)
  deal_id             BIGINT GENERATED ALWAYS AS IDENTITY,

  -- FK
  customer_id         TEXT NOT NULL,

  -- ステータス
  status              TEXT,
  cancel_flag         TEXT,
  cancel_date         DATE,
  cancel_reason       TEXT,

  -- 見積
  estimate_maker      TEXT,
  estimate_request_date DATE,
  estimate_arrival_date DATE,
  estimate_note       TEXT,

  -- FIT
  fit_approval_date   DATE,
  fit_application_date DATE,

  -- 設備
  maker               TEXT,
  module              TEXT,
  installed_kw        NUMERIC(10,3),

  -- 設置先
  installation_store  TEXT,
  installation_address TEXT,
  installation_phone  TEXT,
  installation_fax    TEXT,
  building_age        INTEGER,

  -- 受注
  order_date          DATE,
  estimate_request_date_2 DATE,
  estimate_arrival_date_2 DATE,
  site_survey_date    DATE,

  -- 契約
  applicant           TEXT,
  application_send_date DATE,
  lease_certificate_send DATE,
  consent_send        DATE,
  contractor          TEXT,
  contractor_relationship TEXT,
  user_relationship   TEXT,

  -- 金額
  monthly_amount      NUMERIC(15,2),
  lease_fee           NUMERIC(15,2),

  -- 信販
  credit_company      TEXT,
  credit_request_date DATE,
  credit_result       TEXT,
  credit_result_date  DATE,
  credit_company_2    TEXT,

  -- 電力申請
  power_application_date DATE,
  power_approval_date DATE,

  -- 工事
  drone_survey_date   DATE,
  construction_request TEXT,
  construction_request_2 TEXT,
  construction_date   DATE,
  construction_complete_date DATE,
  revisit_date        DATE,
  completion_report   DATE,
  confirmation_complete_date DATE,
  report_arrival_date DATE,
  floor_plan_arrival  DATE,

  -- 保証
  warranty_application DATE,
  warranty_arrival    DATE,
  disaster_insurance_application DATE,
  disaster_insurance_arrival DATE,

  -- 請求・入金
  invoice_date        DATE,
  invoice_date_2      DATE,
  payment_date        DATE,
  payment_date_2      DATE,
  delivery_date       DATE,
  order_placement_date DATE,

  -- 計上
  accounting_month    TEXT,
  accounting_date     DATE,
  gross_profit        NUMERIC(15,2),

  -- サービス品
  service_item_count  INTEGER,
  service_item_price  NUMERIC(15,2),
  service_item_cost   NUMERIC(15,2),
  service_item_delivery DATE,

  -- 部材
  material            TEXT,
  material_count      INTEGER,
  material_unit_price NUMERIC(15,2),
  material_cost       NUMERIC(15,2),
  material_name       TEXT,

  -- 施工・販売
  construction_management TEXT,
  sales_channel       TEXT,
  sales_store         TEXT,
  slip_number         TEXT,
  additional_construction TEXT,
  required_documents  TEXT,
  required_documents_date DATE,

  -- メモ
  note                TEXT,
  caution             TEXT,

  -- その他
  sheet_count         INTEGER,
  mail_date           DATE,
  grid_connection_date DATE,
  appointment_staff   TEXT,
  sales_staff         TEXT,
  sales_comment       TEXT,
  visit_count         INTEGER,
  visit_staff         TEXT,

  -- traceability
  raw_source_file     TEXT NOT NULL,
  raw_row_origin      INTEGER NOT NULL,
  source_fingerprint  TEXT NOT NULL,

  -- audit
  _loaded_at          TIMESTAMPTZ DEFAULT now(),
  _batch_id           TEXT DEFAULT '260312',
  _schema_version     TEXT DEFAULT 'v0'
);

-- provisional constraints
-- ALTER TABLE staging_deal ADD CONSTRAINT staging_deal_pk PRIMARY KEY (deal_id);
-- ALTER TABLE staging_deal ADD CONSTRAINT staging_deal_customer_fk FOREIGN KEY (customer_id) REFERENCES staging_customer(customer_id);
-- provisional index
-- CREATE INDEX IF NOT EXISTS idx_staging_deal_customer_id ON staging_deal (customer_id);
-- CREATE INDEX IF NOT EXISTS idx_staging_deal_status ON staging_deal (status);
-- CREATE INDEX IF NOT EXISTS idx_staging_deal_fingerprint ON staging_deal (source_fingerprint);

-- ═══════════════════════════════════════════════════════════════
-- staging_activity_call
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_activity_call (
  -- surrogate PK (provisional)
  activity_call_id    BIGINT GENERATED ALWAYS AS IDENTITY,

  -- source 識別
  source_kind         TEXT NOT NULL,  -- 'source_a' or 'source_b'

  -- コール情報
  call_date           DATE,
  call_time           TIME,
  call_staff          TEXT,
  content             TEXT,
  customer_staff      TEXT,

  -- 電話番号 (Source A のみ)
  raw_phone           TEXT,
  normalized_phone    TEXT,

  -- customer 紐付け
  matched_customer_id TEXT,
  matched_customer_candidate_count INTEGER,
  match_type          TEXT,
  fill_forward_customer_id TEXT,  -- Source B のみ

  -- traceability
  raw_source_file     TEXT NOT NULL,
  raw_row_origin      INTEGER NOT NULL,
  source_fingerprint  TEXT NOT NULL,

  -- audit
  _loaded_at          TIMESTAMPTZ DEFAULT now(),
  _batch_id           TEXT DEFAULT '260312',
  _schema_version     TEXT DEFAULT 'v0'
);

-- provisional constraints
-- ALTER TABLE staging_activity_call ADD CONSTRAINT staging_activity_call_pk PRIMARY KEY (activity_call_id);
-- provisional index
-- CREATE INDEX IF NOT EXISTS idx_staging_activity_call_source ON staging_activity_call (source_kind);
-- CREATE INDEX IF NOT EXISTS idx_staging_activity_call_date ON staging_activity_call (call_date);
-- CREATE INDEX IF NOT EXISTS idx_staging_activity_call_phone ON staging_activity_call (normalized_phone);
-- CREATE INDEX IF NOT EXISTS idx_staging_activity_call_matched ON staging_activity_call (matched_customer_id);
-- CREATE INDEX IF NOT EXISTS idx_staging_activity_call_fingerprint ON staging_activity_call (source_fingerprint);

-- ═══════════════════════════════════════════════════════════════
-- staging_rejected_rows (rejected row 記録用)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_rejected_rows (
  rejected_id         BIGINT GENERATED ALWAYS AS IDENTITY,
  entity              TEXT NOT NULL,  -- 'customer', 'deal', 'activity_call'
  reject_reason       TEXT NOT NULL,
  raw_source_file     TEXT NOT NULL,
  raw_row_origin      INTEGER NOT NULL,
  source_fingerprint  TEXT NOT NULL,
  raw_data_json       JSONB,         -- 元の行データを JSON で保持
  _rejected_at        TIMESTAMPTZ DEFAULT now(),
  _batch_id           TEXT DEFAULT '260312'
);

-- ═══════════════════════════════════════════════════════════════
-- staging_load_log (load 実行ログ)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_load_log (
  log_id              BIGINT GENERATED ALWAYS AS IDENTITY,
  entity              TEXT NOT NULL,
  action              TEXT NOT NULL,  -- 'truncate', 'copy', 'insert'
  row_count           INTEGER,
  started_at          TIMESTAMPTZ NOT NULL,
  completed_at        TIMESTAMPTZ,
  status              TEXT NOT NULL,  -- 'success', 'error', 'rollback'
  error_message       TEXT,
  _batch_id           TEXT DEFAULT '260312'
);
`;

  writeSql(resolve(OUT_DIR, 'staging-ddl-draft-v1.sql'), sql);
}

function generatePhase4Summary(reviewQueue: Row[], statusDict: Row[]) {
  const multiMatch = reviewQueue.filter(
    (r) => r.review_reason === 'multi_match',
  );
  const noMatch = reviewQueue.filter((r) => r.review_reason === 'no_match');
  const invalid = reviewQueue.filter((r) => r.review_reason === 'invalid');

  const md = `# Phase 4 Summary — Solar 260312

生成日: ${new Date().toISOString().split('T')[0]}

## 概要

Phase 4 は staging load plan の確定を目的とする。
DB 実行前の最終整理に限定し、DDL 実行・Supabase 接続・本番 insert は行わない。

---

## 生成した成果物

| # | ファイル | 説明 |
|---|---------|------|
| 1 | staging-load-spec.md | staging load 仕様書 |
| 2 | staging-load-spec.json | staging load 仕様 (machine-readable) |
| 3 | key-policy.md | unique key / fingerprint / natural key ポリシー |
| 4 | dedupe-policy.md | 重複検出・統合ポリシー |
| 5 | activity-call-merge-policy.md | Source A/B merge 方針 (3案比較 + 推奨) |
| 6 | activity-call-match-review-queue-prioritized.csv | 優先順位付き review queue |
| 7 | status-dictionary-candidate-v2.csv | ステータス辞書 v2 (ヒアリング質問付き) |
| 8 | status-hearing-guide.md | ステータスヒアリングガイド |
| 9 | staging-load-order.md | load 実行順序 |
| 10 | staging-precheck.sql | 実行前チェック SQL (草案・未実行) |
| 11 | staging-postcheck.sql | 実行後チェック SQL (草案・未実行) |
| 12 | staging-ddl-draft-v1.sql | DDL 草案 v1 (草案・未実行) |
| 13 | phase4-summary.md | このファイル |

---

## Load Spec サマリ

| Entity | Table | Rows | Load Order | Dependencies |
|--------|-------|------|-----------|-------------|
| customer | staging_customer | 5,357 | 1 | なし |
| deal | staging_deal | 5,357 | 2 | staging_customer |
| activity_call | staging_activity_call | 97,722 | 3 | staging_customer |

- Load Strategy: TRUNCATE + INSERT (idempotent)
- Provenance: 全行に raw_source_file + raw_row_origin + source_fingerprint
- Schema Version: v0 (provisional)

---

## Key / Dedupe Policy サマリ

### customer
- **PK**: customer_id (FileMaker 自動採番、ユニーク確認済み)
- **Natural Key 候補**: phone + furigana (medium confidence)
- **Dedupe**: staging では実施しない。soft dedupe rules を定義済み

### deal
- **PK**: deal_id (surrogate、staging 投入時に自動生成)
- **FK**: customer_id → staging_customer
- **1:1 / 1:N**: 現 batch では 1:1。schema は 1:N 対応可能

### activity_call
- **PK**: activity_call_id (surrogate)
- **Cross-source FP**: call_date + call_staff + content_first_80
- **Dedupe**: Source A/B 間の 11% 重複は staging 投入後に判断

---

## Merge Policy 推奨案

**案 3: 並存保持 + Downstream Review** を推奨。

| 理由 | 詳細 |
|------|------|
| データ完全性 | A のみ 35,372 件 + B のみ 34,689 件を両方保持 |
| 安全性 | 統合判断を Phase 5 に先送り。可逆性を確保 |
| 柔軟性 | どの merge strategy にも後から切り替え可能 |
| CLAUDE.md 整合 | 「unsafe な自動確定をしない」に合致 |

---

## Prioritized Review Queue サマリ

| 分類 | 件数 | 内訳 |
|------|------|------|
| multi_match | ${multiMatch.length} | 2候補: ~2,130 / 3-5候補: ~383 / 19候補: 337 |
| no_match | ${noMatch.length} | 有効な電話番号だが顧客マスタに該当なし |
| invalid | ${invalid.length} | 電話番号フィールドに非電話データ |
| **合計** | **${multiMatch.length + noMatch.length + invalid.length}** | |

### multi_match サブ分類

| Bucket | 説明 | 対処方針 |
|--------|------|---------|
| family_shared_phone | 同一住所の家族が電話番号を共有 | コール内容から対象者を特定 |
| same_phone_different_name | 異なる人物が同一電話番号を使用 | コール内容/日付から正しい顧客を特定 |
| same_name_same_phone | 同一人物が複数 ID で登録 | 統合候補 |
| unclear | パターン不明 | 個別レビュー |
| (19候補) | 営業担当の携帯番号等 | 電話番号の持ち主を確認 |

---

## Unresolved / 要ヒアリング事項

### 高優先

| # | 項目 | 影響範囲 | 確認先 |
|---|------|---------|--------|
| 1 | Source A/B のどちらが primary か | activity_call 97,722 件 | 現場/FileMaker 管理者 |
| 2 | customer / deal の 1:1 vs 1:N | スキーマ設計 | 業務担当者 |
| 3 | 「連変」「取り直し」の業務的意味 | 審査結果の正規化 | 業務担当者 |
| 4 | multi_match (19候補) の電話番号 09094847774 の持ち主 | 337 コール行 | 営業担当者 |

### 中優先

| # | 項目 | 影響範囲 | 確認先 |
|---|------|---------|--------|
| 5 | 「再訪問調整中」等 8 件の low confidence ステータス | 88 deal 行 | 業務担当者 |
| 6 | 「契約者」と顧客の同一性 | customer/deal 境界 | 業務担当者 |
| 7 | 「代表者」の意味 (法人代表 or 世帯主) | customer スキーマ | 業務担当者 |
| 8 | 見積依頼日 vs 【見積】依頼日の関係 | deal 列の統合判断 | 業務担当者 |

### 低優先

| # | 項目 | 影響範囲 | 確認先 |
|---|------|---------|--------|
| 9 | 設置店名 / 販売店 / 商流の entity 化 | 将来のマスタ設計 | Phase 5 以降 |
| 10 | 「お客様担当」列の意味 | activity_call | 業務担当者 |

---

## 次にやるべきこと

### Phase 5 予定

1. **ヒアリング実施**: status-hearing-guide.md に基づく現場確認
2. **multi_match 優先レビュー**: prioritized review queue の high priority から処理
3. **Source A/B merge 実行**: merge policy に基づく統合
4. **DDL 実行**: staging-ddl-draft-v1.sql を確定版に昇格し、Supabase に作成
5. **staging INSERT**: staging-load-order.md に従い投入
6. **post-check 実行**: staging-postcheck.sql で整合性確認
7. **schema v1 策定**: ヒアリング結果を反映した確定版 schema

---

## 実行コマンド

\`\`\`bash
# Phase 4 成果物の再生成
npm run audit:solar:phase4
\`\`\`

---

## 変更ファイル一覧

### 新規作成

| ファイル | パス |
|---------|------|
| Phase 4 スクリプト | scripts/audit-solar-260312-phase4.ts |
| staging-load-spec.md | artifacts/filemaker-audit/solar/260312/phase4/staging-load-spec.md |
| staging-load-spec.json | artifacts/filemaker-audit/solar/260312/phase4/staging-load-spec.json |
| key-policy.md | artifacts/filemaker-audit/solar/260312/phase4/key-policy.md |
| dedupe-policy.md | artifacts/filemaker-audit/solar/260312/phase4/dedupe-policy.md |
| activity-call-merge-policy.md | artifacts/filemaker-audit/solar/260312/phase4/activity-call-merge-policy.md |
| activity-call-match-review-queue-prioritized.csv | artifacts/filemaker-audit/solar/260312/phase4/activity-call-match-review-queue-prioritized.csv |
| status-dictionary-candidate-v2.csv | artifacts/filemaker-audit/solar/260312/phase4/status-dictionary-candidate-v2.csv |
| status-hearing-guide.md | artifacts/filemaker-audit/solar/260312/phase4/status-hearing-guide.md |
| staging-load-order.md | artifacts/filemaker-audit/solar/260312/phase4/staging-load-order.md |
| staging-precheck.sql | artifacts/filemaker-audit/solar/260312/phase4/staging-precheck.sql |
| staging-postcheck.sql | artifacts/filemaker-audit/solar/260312/phase4/staging-postcheck.sql |
| staging-ddl-draft-v1.sql | artifacts/filemaker-audit/solar/260312/phase4/staging-ddl-draft-v1.sql |
| phase4-summary.md | artifacts/filemaker-audit/solar/260312/phase4/phase4-summary.md |

### 変更

| ファイル | 変更内容 |
|---------|---------|
| package.json | \`audit:solar:phase4\` スクリプト追加 |
`;

  writeMd(resolve(OUT_DIR, 'phase4-summary.md'), md);
}

// ─── run ─────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error('Phase 4 failed:', err);
  process.exit(1);
});
