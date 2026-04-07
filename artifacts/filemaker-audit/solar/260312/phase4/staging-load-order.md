# Staging Load Order — Solar 260312

> **注意**: この load order は草案です。実行はしません。

生成日: 2026-04-06

---

## Load Sequence

```
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
```

## Load 方法

### 推奨: PostgreSQL COPY

```sql
-- Step 2
\COPY staging_customer FROM 'customer-staging-v0.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

-- Step 3
\COPY staging_deal FROM 'deal-staging-v0.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

-- Step 4
\COPY staging_activity_call FROM 'activity-call-union-candidate.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');
```

### 代替: Supabase CLI / REST API

activity_call の 97K 行は REST API のバッチ INSERT では遅い可能性がある。
COPY または pg_dump / pg_restore を推奨。

## Re-run 手順

```sql
-- idempotent re-run
BEGIN;
TRUNCATE staging_activity_call;
TRUNCATE staging_deal;
TRUNCATE staging_customer;
-- then re-COPY
COMMIT;
```

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
