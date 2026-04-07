-- staging-postcheck.sql — Solar 260312
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
