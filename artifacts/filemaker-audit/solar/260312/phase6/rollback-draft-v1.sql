-- rollback-draft-v1.sql — Solar 260312 Phase 6
-- NOTE: 実行禁止。Supabase 接続禁止。dry-run 相当。
-- 目的: staging load のロールバック手順（草案）
-- 生成日: 2026-04-07

-- ─────────────────────────────────────────────────────────────
-- Option A: 全件クリア（最も強力）
-- staging_customer / deal / activity_call を全件削除する。
-- ロールバック後は staging-insert-draft-v1.sql を再実行すること。
-- ─────────────────────────────────────────────────────────────

BEGIN;

TRUNCATE staging_activity_call;
TRUNCATE staging_deal;
TRUNCATE staging_customer;

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
VALUES ('all', 'rollback_truncate', NULL, now(), now(), 'rollback', '260312');

COMMIT;

-- ─────────────────────────────────────────────────────────────
-- Option B: soft_dedupe のみ元に戻す
-- is_duplicate フラグと review_status を初期状態に戻す。
-- cross_source_fp は再計算可能なため NULL に戻す。
-- ─────────────────────────────────────────────────────────────

BEGIN;

UPDATE staging_activity_call
SET is_duplicate    = FALSE,
    review_status   = 'active',
    cross_source_fp = NULL;

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
VALUES ('activity_call', 'rollback_soft_dedupe', NULL, now(), now(), 'rollback', '260312');

COMMIT;

-- ─────────────────────────────────────────────────────────────
-- Option C: manual_resolved のみ元に戻す
-- resolved な manual resolution がないため、Option C は不要です。
