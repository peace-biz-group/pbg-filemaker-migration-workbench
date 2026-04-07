-- staging-precheck.sql — Solar 260312
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
