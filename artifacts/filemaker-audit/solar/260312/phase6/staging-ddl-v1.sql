-- staging-ddl-v1.sql — Solar 260312
-- NOTE: 実行禁止。Supabase 接続禁止。dry-run 相当。
-- NOTE: Phase 6 確定版 DDL。Phase 4 草案 (v0) から昇格。
-- 生成日: 2026-04-07

-- ═══════════════════════════════════════════════════════════════
-- staging_customer
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_customer (
  -- PK (確定)
  customer_id        TEXT NOT NULL PRIMARY KEY,

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
  source_fingerprint  TEXT NOT NULL UNIQUE,

  -- audit (load 時に自動付与)
  _loaded_at          TIMESTAMPTZ DEFAULT now(),
  _batch_id           TEXT DEFAULT '260312',
  _schema_version     TEXT DEFAULT 'v1'
);

CREATE INDEX IF NOT EXISTS idx_staging_customer_phone       ON staging_customer (phone);
CREATE INDEX IF NOT EXISTS idx_staging_customer_phone_search ON staging_customer (phone_search);
CREATE INDEX IF NOT EXISTS idx_staging_customer_fingerprint ON staging_customer (source_fingerprint);

-- ═══════════════════════════════════════════════════════════════
-- staging_deal
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_deal (
  -- surrogate PK (確定)
  deal_id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- FK
  -- NOTE: customer:deal = 1:1 vs 1:N ヒアリング未確定のため FK はコメントアウトのまま維持
  customer_id         TEXT NOT NULL,
  -- CONSTRAINT staging_deal_customer_fk FOREIGN KEY (customer_id) REFERENCES staging_customer(customer_id),

  -- ステータス
  status              TEXT,
  status_normalized   TEXT,  -- Phase 6 追加: status-dictionary-v3.csv の normalized_stage_v3 を参照
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
  source_fingerprint  TEXT NOT NULL UNIQUE,

  -- audit
  _loaded_at          TIMESTAMPTZ DEFAULT now(),
  _batch_id           TEXT DEFAULT '260312',
  _schema_version     TEXT DEFAULT 'v1'
);

CREATE INDEX IF NOT EXISTS idx_staging_deal_customer_id  ON staging_deal (customer_id);
CREATE INDEX IF NOT EXISTS idx_staging_deal_status       ON staging_deal (status);
CREATE INDEX IF NOT EXISTS idx_staging_deal_fingerprint  ON staging_deal (source_fingerprint);

-- ═══════════════════════════════════════════════════════════════
-- staging_activity_call
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_activity_call (
  -- surrogate PK (確定)
  activity_call_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- source 識別 (確定: CHECK 制約追加)
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('source_a', 'source_b')),

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

  -- merge policy v1 追加列
  cross_source_fp     TEXT,        -- concat_ws('|', date, staff, left(content,80))
  is_duplicate        BOOLEAN DEFAULT FALSE,
  review_status       TEXT DEFAULT 'active' CHECK (review_status IN ('active', 'needs_review', 'duplicate')),

  -- traceability
  raw_source_file     TEXT NOT NULL,
  raw_row_origin      INTEGER NOT NULL,
  source_fingerprint  TEXT NOT NULL,

  -- audit
  _loaded_at          TIMESTAMPTZ DEFAULT now(),
  _batch_id           TEXT DEFAULT '260312',
  _schema_version     TEXT DEFAULT 'v1'
);

CREATE INDEX IF NOT EXISTS idx_staging_activity_call_source     ON staging_activity_call (source_kind);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_date       ON staging_activity_call (call_date);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_phone      ON staging_activity_call (normalized_phone);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_matched    ON staging_activity_call (matched_customer_id);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_fingerprint ON staging_activity_call (source_fingerprint);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_cross_fp   ON staging_activity_call (cross_source_fp);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_review     ON staging_activity_call (review_status);

-- ═══════════════════════════════════════════════════════════════
-- staging_rejected_rows
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_rejected_rows (
  rejected_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity              TEXT NOT NULL,  -- 'customer', 'deal', 'activity_call'
  reject_reason       TEXT NOT NULL,
  raw_source_file     TEXT NOT NULL,
  raw_row_origin      INTEGER NOT NULL,
  source_fingerprint  TEXT NOT NULL,
  raw_data_json       JSONB,
  _rejected_at        TIMESTAMPTZ DEFAULT now(),
  _batch_id           TEXT DEFAULT '260312'
);

-- ═══════════════════════════════════════════════════════════════
-- staging_load_log
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_load_log (
  log_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity              TEXT NOT NULL,
  action              TEXT NOT NULL,
  row_count           INTEGER,
  started_at          TIMESTAMPTZ NOT NULL,
  completed_at        TIMESTAMPTZ,
  status              TEXT NOT NULL CHECK (status IN ('success', 'error', 'rollback')),
  error_message       TEXT,
  _batch_id           TEXT DEFAULT '260312'
);
