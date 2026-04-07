-- staging-precheck-v1.sql — Solar 260312 Phase 6
-- NOTE: 実行禁止。Supabase 接続禁止。dry-run 相当。
-- 目的: staging load 前の環境確認クエリ集
-- 生成日: 2026-04-07

-- ─────────────────────────────────────────────────────────────
-- 1. staging テーブルの存在確認（5 テーブル）
-- ─────────────────────────────────────────────────────────────

SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'staging_customer',
    'staging_deal',
    'staging_activity_call',
    'staging_rejected_rows',
    'staging_load_log'
  )
ORDER BY table_name;

-- 期待: 5行が返ること

-- ─────────────────────────────────────────────────────────────
-- 2. 既存データ行数確認（re-run 判定）
-- ─────────────────────────────────────────────────────────────

SELECT 'staging_customer'     AS table_name, COUNT(*) AS row_count FROM staging_customer
UNION ALL
SELECT 'staging_deal',                        COUNT(*) FROM staging_deal
UNION ALL
SELECT 'staging_activity_call',               COUNT(*) FROM staging_activity_call
UNION ALL
SELECT 'staging_rejected_rows',               COUNT(*) FROM staging_rejected_rows
UNION ALL
SELECT 'staging_load_log',                    COUNT(*) FROM staging_load_log;

-- 期待: 初回は全て 0。再実行時は既存件数を確認し TRUNCATE 必要性を判断する

-- ─────────────────────────────────────────────────────────────
-- 3. 制約の確認
-- ─────────────────────────────────────────────────────────────

SELECT conname, contype, conrelid::regclass AS table_name
FROM pg_constraint
WHERE conrelid::regclass::text IN (
    'staging_customer',
    'staging_deal',
    'staging_activity_call',
    'staging_rejected_rows',
    'staging_load_log'
  )
ORDER BY table_name, conname;

-- 期待: PRIMARY KEY, UNIQUE (source_fingerprint), CHECK (source_kind, review_status, status) が存在すること

-- ─────────────────────────────────────────────────────────────
-- 4. disk space 概算
-- ─────────────────────────────────────────────────────────────

SELECT
  relname AS table_name,
  pg_size_pretty(pg_total_relation_size(oid)) AS total_size
FROM pg_class
WHERE relname IN (
    'staging_customer',
    'staging_deal',
    'staging_activity_call',
    'staging_rejected_rows',
    'staging_load_log'
  )
ORDER BY relname;

-- ─────────────────────────────────────────────────────────────
-- 5. CSV ファイル行数の手動確認（実行前に確認すること）
-- ─────────────────────────────────────────────────────────────

-- 以下をターミナルで実行し、期待値と一致することを確認する:
--
--   wc -l artifacts/filemaker-audit/solar/260312/phase3/customer-staging-v0.csv
--   期待値: 5358 行（ヘッダー含む）= 5357 レコード
--
--   wc -l artifacts/filemaker-audit/solar/260312/phase3/deal-staging-v0.csv
--   期待値: 5358 行（ヘッダー含む）= 5357 レコード
--
--   wc -l artifacts/filemaker-audit/solar/260312/phase3/activity-call-union-candidate.csv
--   期待値: 97723 行（ヘッダー含む）= 97722 レコード
--
-- ミスマッチがあれば load を中止すること。
