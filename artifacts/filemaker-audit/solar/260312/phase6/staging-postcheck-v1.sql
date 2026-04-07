-- staging-postcheck-v1.sql — Solar 260312 Phase 6
-- NOTE: 実行禁止。Supabase 接続禁止。dry-run 相当。
-- 目的: staging load 後の整合性確認クエリ集
-- 生成日: 2026-04-07

-- ─────────────────────────────────────────────────────────────
-- 1. Row count（期待値チェック）
-- ─────────────────────────────────────────────────────────────

SELECT 'staging_customer'     AS table_name, COUNT(*) AS row_count, 5357   AS expected FROM staging_customer
UNION ALL
SELECT 'staging_deal',                        COUNT(*), 5357   FROM staging_deal
UNION ALL
SELECT 'staging_activity_call',               COUNT(*), 97722  FROM staging_activity_call;

-- 期待: row_count = expected の3行

-- ─────────────────────────────────────────────────────────────
-- 2. NOT NULL チェック
-- ─────────────────────────────────────────────────────────────

SELECT 'customer: customer_id NULL',   COUNT(*) FROM staging_customer WHERE customer_id IS NULL
UNION ALL
SELECT 'customer: source_fingerprint NULL', COUNT(*) FROM staging_customer WHERE source_fingerprint IS NULL
UNION ALL
SELECT 'deal: customer_id NULL',       COUNT(*) FROM staging_deal WHERE customer_id IS NULL
UNION ALL
SELECT 'deal: source_fingerprint NULL', COUNT(*) FROM staging_deal WHERE source_fingerprint IS NULL
UNION ALL
SELECT 'activity: source_kind NULL',   COUNT(*) FROM staging_activity_call WHERE source_kind IS NULL
UNION ALL
SELECT 'activity: source_fingerprint NULL', COUNT(*) FROM staging_activity_call WHERE source_fingerprint IS NULL;

-- 期待: 全て 0

-- ─────────────────────────────────────────────────────────────
-- 3. Uniqueness チェック
-- ─────────────────────────────────────────────────────────────

SELECT 'customer: duplicate customer_id',      COUNT(*) - COUNT(DISTINCT customer_id)      FROM staging_customer
UNION ALL
SELECT 'customer: duplicate source_fingerprint', COUNT(*) - COUNT(DISTINCT source_fingerprint) FROM staging_customer
UNION ALL
SELECT 'deal: duplicate source_fingerprint',   COUNT(*) - COUNT(DISTINCT source_fingerprint)   FROM staging_deal;

-- 期待: 全て 0

-- ─────────────────────────────────────────────────────────────
-- 4. Referential integrity チェック
-- ─────────────────────────────────────────────────────────────

SELECT 'deal: orphan customer_id', COUNT(*)
FROM staging_deal d
WHERE NOT EXISTS (
  SELECT 1 FROM staging_customer c WHERE c.customer_id = d.customer_id
);

-- 期待: 0

-- ─────────────────────────────────────────────────────────────
-- 5. source_kind 分布
-- ─────────────────────────────────────────────────────────────

SELECT source_kind, COUNT(*) AS row_count
FROM staging_activity_call
GROUP BY source_kind
ORDER BY source_kind;

-- 期待: source_a ~46572, source_b ~51150

-- ─────────────────────────────────────────────────────────────
-- 6. match_type 分布
-- ─────────────────────────────────────────────────────────────

SELECT match_type, COUNT(*) AS row_count
FROM staging_activity_call
GROUP BY match_type
ORDER BY row_count DESC;

-- ─────────────────────────────────────────────────────────────
-- 7. review_status 分布（新規追加）
-- ─────────────────────────────────────────────────────────────

SELECT review_status, COUNT(*) AS row_count
FROM staging_activity_call
GROUP BY review_status
ORDER BY review_status;

-- 期待例:
--   active       : ~89162 (97722 - 4280 strict dup - 3285 loose ≈ 90157 前後)
--   needs_review : ~3285
--   duplicate    : ~4280

-- ─────────────────────────────────────────────────────────────
-- 8. status / status_normalized 分布（新規追加）
-- ─────────────────────────────────────────────────────────────

SELECT status, status_normalized, COUNT(*) AS row_count
FROM staging_deal
GROUP BY status, status_normalized
ORDER BY row_count DESC
LIMIT 30;

-- ─────────────────────────────────────────────────────────────
-- 9. Load log サマリ
-- ─────────────────────────────────────────────────────────────

SELECT entity, action, row_count, status, completed_at
FROM staging_load_log
ORDER BY log_id;

-- ─────────────────────────────────────────────────────────────
-- 10. 完了マーカー
-- ─────────────────────────────────────────────────────────────

SELECT 'post_check_v1_complete' AS status, now() AS checked_at;
