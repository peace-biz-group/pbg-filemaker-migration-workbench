# Staging Load Spec — Solar 260312

> **注意**: この仕様は草案 (v0) です。DB 実行はしません。
> Phase 3 の staging schema v0 に基づく staging load 計画です。

生成日: 2026-04-06

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
