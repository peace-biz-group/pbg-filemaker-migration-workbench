-- staging-insert-draft-v1.sql — Solar 260312 Phase 6
-- NOTE: 実行禁止。Supabase 接続禁止。dry-run 相当。
-- 目的: staging テーブルへの初回 load 手順（草案）
-- 生成日: 2026-04-07
-- 前提: staging-ddl-v1.sql 適用済み / precheck-v1.sql 確認済み

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- Step 1: TRUNCATE（再実行時は全件クリア）
-- ─────────────────────────────────────────────────────────────

TRUNCATE staging_activity_call;
TRUNCATE staging_deal;
TRUNCATE staging_customer;
-- staging_rejected_rows / staging_load_log は TRUNCATE しない（ログ保持）

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
VALUES ('all', 'truncate', NULL, now(), now(), 'success', '260312');

-- ─────────────────────────────────────────────────────────────
-- Step 2: staging_customer load
-- ─────────────────────────────────────────────────────────────

\COPY staging_customer FROM 'artifacts/filemaker-audit/solar/260312/phase3/customer-staging-v0.csv'
  WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
VALUES ('customer', 'copy', 5357, now(), now(), 'success', '260312');

-- ─────────────────────────────────────────────────────────────
-- Step 3: staging_deal load
-- ─────────────────────────────────────────────────────────────

\COPY staging_deal (
  customer_id, status, cancel_flag, cancel_date, cancel_reason,
  estimate_maker, estimate_request_date, estimate_arrival_date, estimate_note,
  fit_approval_date, fit_application_date,
  maker, module, installed_kw,
  installation_store, installation_address, installation_phone, installation_fax, building_age,
  order_date, estimate_request_date_2, estimate_arrival_date_2, site_survey_date,
  applicant, application_send_date, lease_certificate_send, consent_send,
  contractor, contractor_relationship, user_relationship,
  monthly_amount, lease_fee,
  credit_company, credit_request_date, credit_result, credit_result_date, credit_company_2,
  power_application_date, power_approval_date,
  drone_survey_date, construction_request, construction_request_2,
  construction_date, construction_complete_date, revisit_date, completion_report,
  confirmation_complete_date, report_arrival_date, floor_plan_arrival,
  warranty_application, warranty_arrival,
  disaster_insurance_application, disaster_insurance_arrival,
  invoice_date, invoice_date_2, payment_date, payment_date_2, delivery_date, order_placement_date,
  accounting_month, accounting_date, gross_profit,
  service_item_count, service_item_price, service_item_cost, service_item_delivery,
  material, material_count, material_unit_price, material_cost, material_name,
  construction_management, sales_channel, sales_store, slip_number,
  additional_construction, required_documents, required_documents_date,
  note, caution,
  sheet_count, mail_date, grid_connection_date, appointment_staff,
  sales_staff, sales_comment, visit_count, visit_staff,
  raw_source_file, raw_row_origin, source_fingerprint
)
FROM 'artifacts/filemaker-audit/solar/260312/phase3/deal-staging-v0.csv'
  WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
VALUES ('deal', 'copy', 5357, now(), now(), 'success', '260312');

-- ─────────────────────────────────────────────────────────────
-- Step 4: staging_activity_call load
-- ─────────────────────────────────────────────────────────────

\COPY staging_activity_call (
  source_kind, call_date, call_time, call_staff, content, customer_staff,
  raw_phone, normalized_phone,
  matched_customer_id, matched_customer_candidate_count, match_type, fill_forward_customer_id,
  raw_source_file, raw_row_origin, source_fingerprint
)
FROM 'artifacts/filemaker-audit/solar/260312/phase3/activity-call-union-candidate.csv'
  WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
VALUES ('activity_call', 'copy', 97722, now(), now(), 'success', '260312');

-- ─────────────────────────────────────────────────────────────
-- Step 5: cross_source_fp を計算
-- ─────────────────────────────────────────────────────────────

UPDATE staging_activity_call
SET cross_source_fp = concat_ws('|',
    to_char(call_date, 'YYYY-MM-DD'),
    call_staff,
    left(content, 80)
  )
WHERE call_date IS NOT NULL;

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
SELECT 'activity_call', 'compute_cross_fp', COUNT(*), now(), now(), 'success', '260312'
FROM staging_activity_call WHERE cross_source_fp IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- Step 6: 厳密重複（Source B 側）を is_duplicate = TRUE にする
-- ─────────────────────────────────────────────────────────────

UPDATE staging_activity_call AS b
SET is_duplicate  = TRUE,
    review_status = 'duplicate'
WHERE b.source_kind = 'source_b'
  AND b.cross_source_fp IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM staging_activity_call AS a
    WHERE a.source_kind    = 'source_a'
      AND a.cross_source_fp = b.cross_source_fp
  );

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
SELECT 'activity_call', 'soft_dedupe_strict', COUNT(*), now(), now(), 'success', '260312'
FROM staging_activity_call WHERE is_duplicate = TRUE;

-- ─────────────────────────────────────────────────────────────
-- Step 7: ルーズ一致を review_status = 'needs_review' にする
-- ─────────────────────────────────────────────────────────────

UPDATE staging_activity_call AS b
SET review_status = 'needs_review'
WHERE b.source_kind   = 'source_b'
  AND b.is_duplicate  = FALSE
  AND b.call_date     IS NOT NULL
  AND b.call_staff    IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM staging_activity_call AS a
    WHERE a.source_kind  = 'source_a'
      AND a.call_date    = b.call_date
      AND a.call_staff   = b.call_staff
      AND (a.cross_source_fp IS DISTINCT FROM b.cross_source_fp)
  );

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
SELECT 'activity_call', 'soft_dedupe_loose', COUNT(*), now(), now(), 'success', '260312'
FROM staging_activity_call WHERE review_status = 'needs_review';

-- ─────────────────────────────────────────────────────────────
-- Step 8: manual resolution 反映
-- ─────────────────────────────────────────────────────────────

-- resolved な manual resolution がありません（反映対象 0 件）
-- manual-resolution-template.csv に decision_status=resolved / chosen_strategy=assign_all の行が記入されれば、
-- ここに UPDATE 文が生成されます。

-- ─────────────────────────────────────────────────────────────
-- Step 9: status_normalized 付与（temp table アプローチ）
-- ─────────────────────────────────────────────────────────────

-- NOTE: 以下はコメントアウト。status-dictionary-v3.csv の内容を確認してから実行すること。
-- status_normalized は unresolved を除いた status にのみ付与する。
--
-- CREATE TEMP TABLE _status_map (
--   status_value      TEXT PRIMARY KEY,
--   normalized_stage  TEXT
-- );
-- -- status-dictionary-v3.csv の normalized_stage_v3 != 'unresolved' の行を INSERT する
-- -- (スクリプトで自動生成 or 手動 INSERT)
--
-- UPDATE staging_deal d
-- SET status_normalized = m.normalized_stage
-- FROM _status_map m
-- WHERE d.status = m.status_value;
--
-- INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
-- SELECT 'deal', 'apply_status_normalized', COUNT(*), now(), now(), 'success', '260312'
-- FROM staging_deal WHERE status_normalized IS NOT NULL;
--
-- DROP TABLE _status_map;

COMMIT;
