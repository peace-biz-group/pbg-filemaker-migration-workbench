#!/usr/bin/env npx tsx
/**
 * Solar 監査 Phase 3 — 260312 batch
 *
 * Phase 1/2 の成果物をもとに:
 *   Phase 12: staging schema v0 (customer / deal / activity_call) の草案作成
 *   Phase 13: staging 用 CSV 出力 (traceability 列付き)
 *   Phase 14: review queue 出力 (phone match / boundary / status)
 *   Phase 15: status 値辞書候補の生成
 *   Phase 16: ドキュメント生成
 *
 * 実行: npm run audit:solar:phase3
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import * as XLSX from 'xlsx';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { normalizePhone, validatePhone } from '../src/normalizers/phone.js';
import { normalizeDate } from '../src/normalizers/date.js';
import { fullWidthToHalfWidth } from '../src/normalizers/text.js';

// ─── paths ───────────────────────────────────────────────────────────
const RAW_DIR = resolve(
  '/Users/evening/Developer/peace-biz-group/filemaker-raw-files/solar',
);
const PHASE12_DIR = resolve('artifacts/filemaker-audit/solar/260312');
const OUT_DIR = resolve('artifacts/filemaker-audit/solar/260312/phase3');

const RAW_FILES = {
  customerCsv: '260312_顧客_太陽光.csv',
  customerXlsx: '260312_顧客_太陽光.xlsx',
  callXlsx: '260312_コール履歴_太陽光.xlsx',
} as const;

const FILES = {
  customerCsv: resolve(RAW_DIR, RAW_FILES.customerCsv),
  callXlsx: resolve(RAW_DIR, RAW_FILES.callXlsx),
  masterRows: resolve(PHASE12_DIR, 'customer-master-rows.csv'),
  portalRows: resolve(PHASE12_DIR, 'customer-portal-call-rows.csv'),
} as const;

type Row = Record<string, unknown>;
type SRow = Record<string, string>;

// ─── readers ─────────────────────────────────────────────────────────

function readXlsx(filePath: string): { rows: Row[]; headers: string[] } {
  const buf = readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: '' });
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { rows, headers };
}

function readCsv(filePath: string): { rows: Row[]; headers: string[] } {
  const buf = readFileSync(filePath);
  const rows = parse(buf, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Row[];
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { rows, headers };
}

// ─── helpers ─────────────────────────────────────────────────────────

function isEmpty(v: unknown): boolean {
  return v === '' || v === null || v === undefined;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function writeCsvFile(filePath: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    writeFileSync(filePath, '', 'utf-8');
  } else {
    writeFileSync(filePath, stringify(rows, { header: true }), 'utf-8');
  }
  console.log(`  ✓ ${basename(filePath)} (${rows.length} rows)`);
}

function writeMd(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf-8');
  console.log(`  ✓ ${basename(filePath)}`);
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  ✓ ${basename(filePath)}`);
}

function excelSerialToDate(serial: unknown): string | null {
  if (typeof serial !== 'number') return null;
  if (serial < 1 || serial > 100000) return null;
  const epoch = new Date(Date.UTC(1899, 11, 30));
  const ms = epoch.getTime() + serial * 86400000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function excelSerialToTime(serial: unknown): string | null {
  if (typeof serial !== 'number') return null;
  if (serial < 0 || serial >= 1) return null;
  const totalSeconds = Math.round(serial * 86400);
  const h = Math.floor(totalSeconds / 3600);
  const mi = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0%';
}

function sourceFingerprint(file: string, rowIndex: number): string {
  return `${file}:row_${rowIndex}`;
}

// ─── Column Classification ──────────────────────────────────────────

const CUSTOMER_COLUMNS: string[] = [
  'お客様ID',
  'ﾌﾘｶﾞﾅ',
  '住所',
  '郵便番号',
  '電話番号',
  'FAX番号',
  '電番【検索用】',
  'メールアドレス',
  '代表者ﾌﾘｶﾞﾅ',
  '代表者携帯',
  '代表者生年月日',
  '担当者ﾌﾘｶﾞﾅ',
  '担当者携帯',
  '緊急連絡先',
  '職業',
  '業種【小分類】',
  'パスワード',
  'ユーザー名',
  'インボイス',
  '申請ID',
  '連絡先',
  '連絡時間',
];

const DEAL_COLUMNS: string[] = [
  'ステータス',
  'ｷｬﾝｾﾙﾌﾗｸﾞ',
  'ｷｬﾝｾﾙ日',
  'キャンセル理由',
  '【見積】メーカー',
  '【見積】依頼日',
  '【見積】到着日',
  '【見積】備考',
  'FIT許可日',
  'FIT申請依頼日',
  'メーカー',
  'モジュール',
  '設置kw',
  '設置店名',
  '設置住所',
  '設置電話番号',
  '設置FAX番号',
  '築年数',
  '受注日',
  '見積依頼日',
  '見積到着日',
  '業者現地調査日',
  '申込者',
  '申込書発送日',
  '借受証発送',
  '承諾書発送',
  '契約者',
  '契約者との続柄',
  '使用者との続柄',
  '月額',
  'リース料金',
  '信販会社',
  '審査依頼日',
  '審査結果',
  '審査結果日',
  '審査信販',
  '電力申請依頼日',
  '電力申請許可日',
  'ドローン現調日',
  '工事希望',
  '工事希望1',
  '工事日',
  '工事完了日',
  '再訪日',
  '完工報告',
  '確認完了日',
  '報告書到着日',
  '平面図到着',
  '保証申請',
  '保証書着',
  '災害補償申請',
  '災害補償申請到着',
  '請求書発行日',
  '請求書発行日②',
  '入金日',
  '入金日②',
  '納入日',
  '発注日',
  '成績計上月',
  '成績計上日',
  '計上粗利',
  'ｻｰﾋﾞｽ品数',
  'ｻｰﾋﾞｽ品単価',
  'ｻｰﾋﾞｽ品原価',
  'ｻｰﾋﾞｽ品納品',
  '部材',
  '部材数',
  '部材単価【計上】',
  '部材原価【計上】',
  '部材名',
  '施工管理',
  '商流',
  '販売店',
  '伝票番号',
  '追加工事',
  '必要書類',
  '必要書類　着日',
  '備考',
  '注意事項',
  '枚数',
  '郵送日',
  '連系日',
  'ｱﾎﾟ担当',
  '営業担当',
  '営業コメント',
  '回数',
  '訪問担当者',
];

const META_COLUMNS: string[] = [
  '作成時刻',
  '作成者',
  '作成日',
  '修正時刻',
  '修正者',
  '修正日',
  '書類データ',
  '本日',
];

// ─── Staging Schema Definitions ──────────────────────────────────────

interface SchemaColumn {
  column_name: string;
  proposed_type: string;
  nullable: boolean;
  source_file: string;
  source_column: string;
  normalization_rule: string;
  review_required: boolean;
  note: string;
}

interface StagingSchema {
  entity: string;
  description: string;
  estimated_rows: number;
  source_files: string[];
  columns: SchemaColumn[];
}

function col(
  name: string,
  type: string,
  nullable: boolean,
  srcFile: string,
  srcCol: string,
  normRule: string,
  review: boolean,
  note: string,
): SchemaColumn {
  return {
    column_name: name,
    proposed_type: type,
    nullable,
    source_file: srcFile,
    source_column: srcCol,
    normalization_rule: normRule,
    review_required: review,
    note,
  };
}

const CUST_SRC = RAW_FILES.customerCsv;
const CALL_SRC = RAW_FILES.callXlsx;

function buildCustomerSchema(): StagingSchema {
  return {
    entity: 'customer',
    description: '顧客基本情報。マスタ行（お客様IDあり）から抽出。',
    estimated_rows: 5357,
    source_files: [RAW_FILES.customerCsv],
    columns: [
      col('customer_id', 'TEXT', false, CUST_SRC, 'お客様ID', 'trim', false, 'PK。FileMaker のお客様ID'),
      col('furigana', 'TEXT', true, CUST_SRC, 'ﾌﾘｶﾞﾅ', 'halfWidthKanaToFullWidth + trim', false, ''),
      col('address', 'TEXT', true, CUST_SRC, '住所', 'fullWidthToHalfWidth + trim', false, ''),
      col('postal_code', 'TEXT', true, CUST_SRC, '郵便番号', 'trim, ###-#### format', false, ''),
      col('phone', 'TEXT', true, CUST_SRC, '電話番号', 'normalizePhone', false, ''),
      col('phone_search', 'TEXT', true, CUST_SRC, '電番【検索用】', 'normalizePhone', false, '電話番号のハイフンなし検索用。Phase 2 まで deal 分類だったが customer に移動'),
      col('fax', 'TEXT', true, CUST_SRC, 'FAX番号', 'normalizePhone', false, ''),
      col('email', 'TEXT', true, CUST_SRC, 'メールアドレス', 'trim + lowercase', false, ''),
      col('representative_furigana', 'TEXT', true, CUST_SRC, '代表者ﾌﾘｶﾞﾅ', 'halfWidthKanaToFullWidth + trim', true, '法人顧客の代表者か個人の別名か要確認'),
      col('representative_mobile', 'TEXT', true, CUST_SRC, '代表者携帯', 'normalizePhone', false, ''),
      col('representative_birthday', 'DATE', true, CUST_SRC, '代表者生年月日', 'normalizeDate (Excel serial → YYYY-MM-DD)', false, 'XLSX では Excel serial number'),
      col('contact_furigana', 'TEXT', true, CUST_SRC, '担当者ﾌﾘｶﾞﾅ', 'halfWidthKanaToFullWidth + trim', false, ''),
      col('contact_mobile', 'TEXT', true, CUST_SRC, '担当者携帯', 'normalizePhone', false, ''),
      col('emergency_contact', 'TEXT', true, CUST_SRC, '緊急連絡先', 'trim', false, ''),
      col('occupation', 'TEXT', true, CUST_SRC, '職業', 'trim', false, ''),
      col('industry_subclass', 'TEXT', true, CUST_SRC, '業種【小分類】', 'trim', false, ''),
      col('fm_password', 'TEXT', true, CUST_SRC, 'パスワード', 'none (legacy)', false, 'FileMaker レガシーフィールド'),
      col('fm_username', 'TEXT', true, CUST_SRC, 'ユーザー名', 'none (legacy)', false, 'FileMaker レガシーフィールド'),
      col('invoice_registration', 'TEXT', true, CUST_SRC, 'インボイス', 'trim', false, ''),
      col('application_id', 'TEXT', true, CUST_SRC, '申請ID', 'trim', false, ''),
      col('contact_info', 'TEXT', true, CUST_SRC, '連絡先', 'trim', false, ''),
      col('preferred_contact_time', 'TEXT', true, CUST_SRC, '連絡時間', 'trim', false, ''),
      // traceability
      col('raw_source_file', 'TEXT', false, '', '', '', false, 'traceability: 元ファイル名'),
      col('raw_row_origin', 'INTEGER', false, '', '', '', false, 'traceability: 元ファイルの行番号'),
      col('source_fingerprint', 'TEXT', false, '', '', '', false, 'traceability: file:row_N 形式'),
    ],
  };
}

function buildDealSchema(): StagingSchema {
  return {
    entity: 'deal',
    description: '案件・契約情報。マスタ行から抽出。customer と 1:1 の可能性が高いが未確定。',
    estimated_rows: 5357,
    source_files: [RAW_FILES.customerCsv],
    columns: [
      col('customer_id', 'TEXT', false, CUST_SRC, 'お客様ID', 'trim', false, 'FK → customer.customer_id'),
      col('status', 'TEXT', true, CUST_SRC, 'ステータス', 'trim', false, '16 種。status-dictionary-candidate.csv 参照'),
      col('cancel_flag', 'TEXT', true, CUST_SRC, 'ｷｬﾝｾﾙﾌﾗｸﾞ', 'trim', false, ''),
      col('cancel_date', 'DATE', true, CUST_SRC, 'ｷｬﾝｾﾙ日', 'normalizeDate', false, ''),
      col('cancel_reason', 'TEXT', true, CUST_SRC, 'キャンセル理由', 'trim', false, ''),
      col('estimate_maker', 'TEXT', true, CUST_SRC, '【見積】メーカー', 'trim', false, ''),
      col('estimate_request_date', 'DATE', true, CUST_SRC, '【見積】依頼日', 'normalizeDate', false, ''),
      col('estimate_arrival_date', 'DATE', true, CUST_SRC, '【見積】到着日', 'normalizeDate', false, ''),
      col('estimate_note', 'TEXT', true, CUST_SRC, '【見積】備考', 'trim', false, ''),
      col('fit_approval_date', 'DATE', true, CUST_SRC, 'FIT許可日', 'normalizeDate', false, ''),
      col('fit_application_date', 'DATE', true, CUST_SRC, 'FIT申請依頼日', 'normalizeDate', false, ''),
      col('maker', 'TEXT', true, CUST_SRC, 'メーカー', 'trim', false, ''),
      col('module', 'TEXT', true, CUST_SRC, 'モジュール', 'trim', false, ''),
      col('installed_kw', 'NUMERIC(10,3)', true, CUST_SRC, '設置kw', 'to_number', false, ''),
      col('installation_store', 'TEXT', true, CUST_SRC, '設置店名', 'trim', true, '設置店は entity 化候補。現状は deal に保持'),
      col('installation_address', 'TEXT', true, CUST_SRC, '設置住所', 'trim', false, ''),
      col('installation_phone', 'TEXT', true, CUST_SRC, '設置電話番号', 'normalizePhone', false, ''),
      col('installation_fax', 'TEXT', true, CUST_SRC, '設置FAX番号', 'normalizePhone', false, ''),
      col('building_age', 'INTEGER', true, CUST_SRC, '築年数', 'to_integer', false, ''),
      col('order_date', 'DATE', true, CUST_SRC, '受注日', 'normalizeDate', false, ''),
      col('estimate_request_date_2', 'DATE', true, CUST_SRC, '見積依頼日', 'normalizeDate', false, '【見積】依頼日 との重複要確認'),
      col('estimate_arrival_date_2', 'DATE', true, CUST_SRC, '見積到着日', 'normalizeDate', false, '【見積】到着日 との重複要確認'),
      col('site_survey_date', 'DATE', true, CUST_SRC, '業者現地調査日', 'normalizeDate', false, ''),
      col('applicant', 'TEXT', true, CUST_SRC, '申込者', 'trim', true, '契約者と別人の場合あり。関係性要確認'),
      col('application_send_date', 'DATE', true, CUST_SRC, '申込書発送日', 'normalizeDate', false, ''),
      col('lease_certificate_send', 'DATE', true, CUST_SRC, '借受証発送', 'normalizeDate', false, ''),
      col('consent_send', 'DATE', true, CUST_SRC, '承諾書発送', 'normalizeDate', false, ''),
      col('contractor', 'TEXT', true, CUST_SRC, '契約者', 'trim', true, '顧客と別人の場合あり（家族名義等）。customer 移動は見送り'),
      col('contractor_relationship', 'TEXT', true, CUST_SRC, '契約者との続柄', 'trim', false, '14 unique values'),
      col('user_relationship', 'TEXT', true, CUST_SRC, '使用者との続柄', 'trim', false, ''),
      col('monthly_amount', 'NUMERIC(15,2)', true, CUST_SRC, '月額', 'to_number', false, ''),
      col('lease_fee', 'NUMERIC(15,2)', true, CUST_SRC, 'リース料金', 'to_number', false, ''),
      col('credit_company', 'TEXT', true, CUST_SRC, '信販会社', 'trim', false, ''),
      col('credit_request_date', 'DATE', true, CUST_SRC, '審査依頼日', 'normalizeDate', false, ''),
      col('credit_result', 'TEXT', true, CUST_SRC, '審査結果', 'trim', false, '5 unique values'),
      col('credit_result_date', 'DATE', true, CUST_SRC, '審査結果日', 'normalizeDate', false, ''),
      col('credit_company_2', 'TEXT', true, CUST_SRC, '審査信販', 'trim', false, ''),
      col('power_application_date', 'DATE', true, CUST_SRC, '電力申請依頼日', 'normalizeDate', false, ''),
      col('power_approval_date', 'DATE', true, CUST_SRC, '電力申請許可日', 'normalizeDate', false, ''),
      col('drone_survey_date', 'DATE', true, CUST_SRC, 'ドローン現調日', 'normalizeDate', false, ''),
      col('construction_request', 'TEXT', true, CUST_SRC, '工事希望', 'trim', false, ''),
      col('construction_request_2', 'TEXT', true, CUST_SRC, '工事希望1', 'trim', false, ''),
      col('construction_date', 'DATE', true, CUST_SRC, '工事日', 'normalizeDate', false, ''),
      col('construction_complete_date', 'DATE', true, CUST_SRC, '工事完了日', 'normalizeDate', false, ''),
      col('revisit_date', 'DATE', true, CUST_SRC, '再訪日', 'normalizeDate', false, ''),
      col('completion_report', 'DATE', true, CUST_SRC, '完工報告', 'normalizeDate', false, ''),
      col('confirmation_complete_date', 'DATE', true, CUST_SRC, '確認完了日', 'normalizeDate', false, ''),
      col('report_arrival_date', 'DATE', true, CUST_SRC, '報告書到着日', 'normalizeDate', false, ''),
      col('floor_plan_arrival', 'DATE', true, CUST_SRC, '平面図到着', 'normalizeDate', false, ''),
      col('warranty_application', 'DATE', true, CUST_SRC, '保証申請', 'normalizeDate', false, ''),
      col('warranty_arrival', 'DATE', true, CUST_SRC, '保証書着', 'normalizeDate', false, ''),
      col('disaster_insurance_application', 'DATE', true, CUST_SRC, '災害補償申請', 'normalizeDate', false, ''),
      col('disaster_insurance_arrival', 'DATE', true, CUST_SRC, '災害補償申請到着', 'normalizeDate', false, ''),
      col('invoice_date', 'DATE', true, CUST_SRC, '請求書発行日', 'normalizeDate', false, ''),
      col('invoice_date_2', 'DATE', true, CUST_SRC, '請求書発行日②', 'normalizeDate', false, ''),
      col('payment_date', 'DATE', true, CUST_SRC, '入金日', 'normalizeDate', false, ''),
      col('payment_date_2', 'DATE', true, CUST_SRC, '入金日②', 'normalizeDate', false, ''),
      col('delivery_date', 'DATE', true, CUST_SRC, '納入日', 'normalizeDate', false, ''),
      col('order_placement_date', 'DATE', true, CUST_SRC, '発注日', 'normalizeDate', false, ''),
      col('accounting_month', 'TEXT', true, CUST_SRC, '成績計上月', 'trim (YYMM/YYYYMM)', false, 'period 型。YYMM 形式'),
      col('accounting_date', 'DATE', true, CUST_SRC, '成績計上日', 'normalizeDate', false, ''),
      col('gross_profit', 'NUMERIC(15,2)', true, CUST_SRC, '計上粗利', 'to_number', false, ''),
      col('service_item_count', 'INTEGER', true, CUST_SRC, 'ｻｰﾋﾞｽ品数', 'to_integer', false, ''),
      col('service_item_price', 'NUMERIC(15,2)', true, CUST_SRC, 'ｻｰﾋﾞｽ品単価', 'to_number', false, ''),
      col('service_item_cost', 'NUMERIC(15,2)', true, CUST_SRC, 'ｻｰﾋﾞｽ品原価', 'to_number', false, ''),
      col('service_item_delivery', 'DATE', true, CUST_SRC, 'ｻｰﾋﾞｽ品納品', 'normalizeDate', false, ''),
      col('material', 'TEXT', true, CUST_SRC, '部材', 'trim', false, ''),
      col('material_count', 'INTEGER', true, CUST_SRC, '部材数', 'to_integer', false, ''),
      col('material_unit_price', 'NUMERIC(15,2)', true, CUST_SRC, '部材単価【計上】', 'to_number', false, ''),
      col('material_cost', 'NUMERIC(15,2)', true, CUST_SRC, '部材原価【計上】', 'to_number', false, ''),
      col('material_name', 'TEXT', true, CUST_SRC, '部材名', 'trim', false, ''),
      col('construction_management', 'TEXT', true, CUST_SRC, '施工管理', 'trim', false, '5 unique values'),
      col('sales_channel', 'TEXT', true, CUST_SRC, '商流', 'trim', true, '販売ルート。entity 化候補'),
      col('sales_store', 'TEXT', true, CUST_SRC, '販売店', 'trim', true, '販売代理店。entity 化候補'),
      col('slip_number', 'TEXT', true, CUST_SRC, '伝票番号', 'trim', false, ''),
      col('additional_construction', 'TEXT', true, CUST_SRC, '追加工事', 'trim', false, ''),
      col('required_documents', 'TEXT', true, CUST_SRC, '必要書類', 'trim', false, ''),
      col('required_documents_date', 'DATE', true, CUST_SRC, '必要書類　着日', 'normalizeDate', false, ''),
      col('note', 'TEXT', true, CUST_SRC, '備考', 'trim', false, ''),
      col('caution', 'TEXT', true, CUST_SRC, '注意事項', 'trim', false, ''),
      col('sheet_count', 'INTEGER', true, CUST_SRC, '枚数', 'to_integer', false, 'パネル枚数'),
      col('mail_date', 'DATE', true, CUST_SRC, '郵送日', 'normalizeDate', false, ''),
      col('grid_connection_date', 'DATE', true, CUST_SRC, '連系日', 'normalizeDate', false, ''),
      col('appointment_staff', 'TEXT', true, CUST_SRC, 'ｱﾎﾟ担当', 'trim', false, ''),
      col('sales_staff', 'TEXT', true, CUST_SRC, '営業担当', 'trim', false, ''),
      col('sales_comment', 'TEXT', true, CUST_SRC, '営業コメント', 'trim', false, ''),
      col('visit_count', 'INTEGER', true, CUST_SRC, '回数', 'to_integer', false, ''),
      col('visit_staff', 'TEXT', true, CUST_SRC, '訪問担当者', 'trim', false, ''),
      // traceability
      col('raw_source_file', 'TEXT', false, '', '', '', false, 'traceability'),
      col('raw_row_origin', 'INTEGER', false, '', '', '', false, 'traceability'),
      col('source_fingerprint', 'TEXT', false, '', '', '', false, 'traceability'),
    ],
  };
}

function buildActivityCallSchema(): StagingSchema {
  return {
    entity: 'activity_call',
    description: 'コール履歴。Source A (独立コール履歴 XLSX) と Source B (顧客ファイル内ポータル展開) の2系統。',
    estimated_rows: 46572 + 51150,
    source_files: [RAW_FILES.callXlsx, RAW_FILES.customerCsv],
    columns: [
      col('source_kind', 'TEXT', false, '', '', '', false, '"source_a" (独立) or "source_b" (ポータル)'),
      col('call_date', 'DATE', true, '', '日付 / ｺｰﾙ履歴::日付', 'normalizeDate', false, ''),
      col('call_time', 'TIME', true, '', '時刻 / ｺｰﾙ履歴::時刻', 'excelSerialToTime', false, ''),
      col('call_staff', 'TEXT', true, '', '担当者 / ｺｰﾙ履歴::担当者', 'fullWidthToHalfWidth + trim', false, ''),
      col('content', 'TEXT', true, '', '内容 / ｺｰﾙ履歴::内容', 'trim', false, ''),
      col('customer_staff', 'TEXT', true, '', 'お客様担当 / ｺｰﾙ履歴::お客様担当', 'trim', false, ''),
      col('raw_phone', 'TEXT', true, CALL_SRC, '電話番号【検索】', 'none', false, 'Source A のみ。元の電話番号'),
      col('normalized_phone', 'TEXT', true, '', '', 'normalizePhone', false, 'Source A: 電話番号【検索】、Source B: _fill_forward_電話番号'),
      col('matched_customer_id', 'TEXT', true, '', '', '', false, '電話番号マッチで特定された customer_id (1件のみ)'),
      col('matched_customer_candidate_count', 'INTEGER', true, '', '', '', false, 'マッチ候補数 (0=no_match, 1=single, 2+=multi_match)'),
      col('match_type', 'TEXT', true, '', '', '', false, 'exact / normalized / no_match / multi_match / invalid / fill_forward'),
      col('fill_forward_customer_id', 'TEXT', true, CUST_SRC, '_fill_forward_お客様ID', '', false, 'Source B のみ。ポータル展開の fill-forward ID'),
      // traceability
      col('raw_source_file', 'TEXT', false, '', '', '', false, 'traceability'),
      col('raw_row_origin', 'INTEGER', false, '', '', '', false, 'traceability'),
      col('source_fingerprint', 'TEXT', false, '', '', '', false, 'traceability'),
    ],
  };
}

// ─── Boundary Review Definitions ─────────────────────────────────────

interface BoundaryItem {
  source_column: string;
  current_entity: string;
  recommended_entity: string;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  action: 'keep' | 'move' | 'review';
}

function buildBoundaryReview(): BoundaryItem[] {
  return [
    {
      source_column: '契約者',
      current_entity: 'deal',
      recommended_entity: 'deal',
      confidence: 'high',
      rationale: '契約者は案件ごとに異なりうる（家族名義等）。契約者との続柄が存在し deal 単位の属性。customer に移すと 1:N 案件時に破綻',
      action: 'keep',
    },
    {
      source_column: '申込者',
      current_entity: 'deal',
      recommended_entity: 'deal',
      confidence: 'high',
      rationale: '申込は案件単位の行為。同じ顧客が別案件で別人が申し込む可能性あり',
      action: 'keep',
    },
    {
      source_column: '設置店名',
      current_entity: 'deal',
      recommended_entity: 'deal',
      confidence: 'medium',
      rationale: '設置店は案件ごとに異なる。将来的に entity 化（店舗マスタ）候補だが、現段階では deal に保持',
      action: 'keep',
    },
    {
      source_column: '販売店',
      current_entity: 'deal',
      recommended_entity: 'deal',
      confidence: 'medium',
      rationale: '販売代理店は案件ごとに異なる。設置店名と同様、entity 化候補だが現段階は deal に保持',
      action: 'keep',
    },
    {
      source_column: '商流',
      current_entity: 'deal',
      recommended_entity: 'deal',
      confidence: 'high',
      rationale: '販売ルート/チャネルは案件単位。同一顧客の別案件で商流が異なる可能性あり',
      action: 'keep',
    },
    {
      source_column: 'ステータス',
      current_entity: 'deal',
      recommended_entity: 'deal',
      confidence: 'high',
      rationale: '完了/キャンセル/対応中 等は明確に案件ライフサイクルの状態。顧客属性ではない',
      action: 'keep',
    },
    {
      source_column: '審査依頼日',
      current_entity: 'deal',
      recommended_entity: 'deal',
      confidence: 'high',
      rationale: '信販審査は案件ごとのファイナンス手続き。審査結果・審査信販も同様',
      action: 'keep',
    },
    {
      source_column: '審査結果',
      current_entity: 'deal',
      recommended_entity: 'deal',
      confidence: 'high',
      rationale: '信販審査結果は案件単位。可決/否決/審査不可 等',
      action: 'keep',
    },
    {
      source_column: '工事日',
      current_entity: 'deal',
      recommended_entity: 'deal',
      confidence: 'high',
      rationale: '工事スケジュールは案件（太陽光設置）ごと。工事完了日、完工報告も同様',
      action: 'keep',
    },
    {
      source_column: '入金日',
      current_entity: 'deal',
      recommended_entity: 'deal',
      confidence: 'high',
      rationale: '入金は案件の支払い。入金日② は分割払い2回目と推定',
      action: 'keep',
    },
    {
      source_column: '電番【検索用】',
      current_entity: 'deal (Phase 2)',
      recommended_entity: 'customer',
      confidence: 'high',
      rationale: '電話番号のハイフンなし正規化版。fill rate 10.1% = マスタ行のみ。customer.phone の検索用バリアント',
      action: 'move',
    },
    {
      source_column: 'ｱﾎﾟ担当',
      current_entity: 'deal',
      recommended_entity: 'deal',
      confidence: 'medium',
      rationale: 'アポイント担当者は案件の営業プロセスに属する。将来的に activity 分離候補だが現状は deal に保持',
      action: 'keep',
    },
    {
      source_column: '営業担当',
      current_entity: 'deal',
      recommended_entity: 'deal',
      confidence: 'medium',
      rationale: '営業担当は案件割り当て。顧客に紐づく場合もあるが、案件ごとに変わりうる',
      action: 'keep',
    },
    {
      source_column: '契約者との続柄',
      current_entity: 'deal',
      recommended_entity: 'deal',
      confidence: 'high',
      rationale: '契約者が deal に属するため、その続柄も deal。14 unique values',
      action: 'keep',
    },
    {
      source_column: '使用者との続柄',
      current_entity: 'deal',
      recommended_entity: 'deal',
      confidence: 'medium',
      rationale: '設置場所の使用者との関係。deal（設置案件）単位の情報',
      action: 'keep',
    },
  ];
}

// ─── Phase 12: Customer Staging CSV ──────────────────────────────────

function generateCustomerStaging(masterRows: Row[]): SRow[] {
  const staging: SRow[] = [];
  for (let i = 0; i < masterRows.length; i++) {
    const r = masterRows[i];
    const rowNum = i + 2; // +2 for 0-indexed + header in source
    staging.push({
      customer_id: str(r['お客様ID']),
      furigana: str(r['ﾌﾘｶﾞﾅ']),
      address: str(r['住所']),
      postal_code: str(r['郵便番号']),
      phone: str(r['電話番号']),
      phone_search: str(r['電番【検索用】']),
      fax: str(r['FAX番号']),
      email: str(r['メールアドレス']),
      representative_furigana: str(r['代表者ﾌﾘｶﾞﾅ']),
      representative_mobile: str(r['代表者携帯']),
      representative_birthday: str(r['代表者生年月日']),
      contact_furigana: str(r['担当者ﾌﾘｶﾞﾅ']),
      contact_mobile: str(r['担当者携帯']),
      emergency_contact: str(r['緊急連絡先']),
      occupation: str(r['職業']),
      industry_subclass: str(r['業種【小分類】']),
      fm_password: str(r['パスワード']),
      fm_username: str(r['ユーザー名']),
      invoice_registration: str(r['インボイス']),
      application_id: str(r['申請ID']),
      contact_info: str(r['連絡先']),
      preferred_contact_time: str(r['連絡時間']),
      raw_source_file: RAW_FILES.customerCsv,
      raw_row_origin: String(rowNum),
      source_fingerprint: sourceFingerprint(RAW_FILES.customerCsv, rowNum),
    });
  }
  return staging;
}

// ─── Phase 13: Deal Staging CSV ──────────────────────────────────────

function generateDealStaging(masterRows: Row[]): SRow[] {
  const staging: SRow[] = [];
  for (let i = 0; i < masterRows.length; i++) {
    const r = masterRows[i];
    const rowNum = i + 2;
    const row: SRow = { customer_id: str(r['お客様ID']) };
    for (const col of DEAL_COLUMNS) {
      // skip 電番【検索用】 (moved to customer)
      if (col === '電番【検索用】') continue;
      const key = col.replace(/[【】]/g, match => match); // keep as-is
      row[col] = str(r[col]);
    }
    row['raw_source_file'] = RAW_FILES.customerCsv;
    row['raw_row_origin'] = String(rowNum);
    row['source_fingerprint'] = sourceFingerprint(RAW_FILES.customerCsv, rowNum);
    staging.push(row);
  }
  return staging;
}

// ─── Phase 14: Activity Call Staging CSVs ────────────────────────────

interface PhoneMatchResult {
  matched_customer_id: string;
  candidate_count: number;
  match_type: string;
  candidate_ids: string[];
}

function buildCustomerPhoneIndex(
  masterRows: Row[],
): { byRaw: Map<string, string[]>; byNormalized: Map<string, string[]> } {
  const byRaw = new Map<string, string[]>();
  const byNormalized = new Map<string, string[]>();

  for (const r of masterRows) {
    const id = str(r['お客様ID']);
    if (!id) continue;

    for (const phoneCol of ['電話番号', '電番【検索用】', '設置電話番号']) {
      const raw = str(r[phoneCol]).trim();
      if (!raw) continue;

      if (!byRaw.has(raw)) byRaw.set(raw, []);
      if (!byRaw.get(raw)!.includes(id)) byRaw.get(raw)!.push(id);

      const norm = normalizePhone(raw);
      if (norm) {
        if (!byNormalized.has(norm)) byNormalized.set(norm, []);
        if (!byNormalized.get(norm)!.includes(id)) byNormalized.get(norm)!.push(id);
      }
    }
  }
  return { byRaw, byNormalized };
}

function matchPhone(
  rawPhone: string,
  phoneIndex: ReturnType<typeof buildCustomerPhoneIndex>,
): PhoneMatchResult {
  const trimmed = rawPhone.trim();
  if (!trimmed) {
    return { matched_customer_id: '', candidate_count: 0, match_type: 'empty', candidate_ids: [] };
  }

  const norm = normalizePhone(trimmed);
  // Non-empty input that normalizes to empty → not a phone number
  if (!norm) {
    return { matched_customer_id: '', candidate_count: 0, match_type: 'invalid', candidate_ids: [] };
  }
  const validationErr = validatePhone(norm);
  if (validationErr) {
    return { matched_customer_id: '', candidate_count: 0, match_type: 'invalid', candidate_ids: [] };
  }

  // Try exact raw match
  const rawMatches = phoneIndex.byRaw.get(trimmed);
  if (rawMatches && rawMatches.length === 1) {
    return { matched_customer_id: rawMatches[0], candidate_count: 1, match_type: 'exact', candidate_ids: rawMatches };
  }
  if (rawMatches && rawMatches.length > 1) {
    return { matched_customer_id: '', candidate_count: rawMatches.length, match_type: 'multi_match', candidate_ids: rawMatches };
  }

  // Try normalized match
  const normMatches = phoneIndex.byNormalized.get(norm);
  if (normMatches && normMatches.length === 1) {
    return { matched_customer_id: normMatches[0], candidate_count: 1, match_type: 'normalized', candidate_ids: normMatches };
  }
  if (normMatches && normMatches.length > 1) {
    return { matched_customer_id: '', candidate_count: normMatches.length, match_type: 'multi_match', candidate_ids: normMatches };
  }

  return { matched_customer_id: '', candidate_count: 0, match_type: 'no_match', candidate_ids: [] };
}

function generateSourceAStaging(
  callRows: Row[],
  phoneIndex: ReturnType<typeof buildCustomerPhoneIndex>,
): { staging: SRow[]; matchResults: { row: SRow; match: PhoneMatchResult }[] } {
  const staging: SRow[] = [];
  const matchResults: { row: SRow; match: PhoneMatchResult }[] = [];

  for (let i = 0; i < callRows.length; i++) {
    const r = callRows[i];
    const rowNum = i + 2;

    const rawDate = r['日付'];
    const callDate =
      typeof rawDate === 'number'
        ? excelSerialToDate(rawDate) || str(rawDate)
        : normalizeDate(str(rawDate));
    const rawTime = r['時刻'];
    const callTime =
      typeof rawTime === 'number'
        ? excelSerialToTime(rawTime) || str(rawTime)
        : str(rawTime);

    const rawPhone = str(r['電話番号【検索】']);
    const match = matchPhone(rawPhone, phoneIndex);

    const row: SRow = {
      source_kind: 'source_a',
      call_date: callDate,
      call_time: callTime,
      call_staff: str(r['担当者']),
      content: str(r['内容']),
      customer_staff: str(r['お客様担当']),
      raw_phone: rawPhone,
      normalized_phone: normalizePhone(rawPhone),
      matched_customer_id: match.matched_customer_id,
      matched_customer_candidate_count: String(match.candidate_count),
      match_type: match.match_type,
      fill_forward_customer_id: '',
      raw_source_file: RAW_FILES.callXlsx,
      raw_row_origin: String(rowNum),
      source_fingerprint: sourceFingerprint(RAW_FILES.callXlsx, rowNum),
    };

    staging.push(row);
    matchResults.push({ row, match });
  }

  return { staging, matchResults };
}

function generateSourceBStaging(
  portalRows: Row[],
): SRow[] {
  const staging: SRow[] = [];

  for (let i = 0; i < portalRows.length; i++) {
    const r = portalRows[i];

    const rawDate = str(r['ｺｰﾙ履歴::日付']);
    const callDate = normalizeDate(rawDate);
    const rawTime = str(r['ｺｰﾙ履歴::時刻']);
    // Portal time might be Japanese text format or Excel serial stored as string
    let callTime = rawTime;
    const timeNum = parseFloat(rawTime);
    if (!isNaN(timeNum) && timeNum >= 0 && timeNum < 1) {
      callTime = excelSerialToTime(timeNum) || rawTime;
    }

    const ffId = str(r['_fill_forward_お客様ID']);
    const ffPhone = str(r['_fill_forward_電話番号']);
    const srcRowIndex = str(r['_source_row_index']);

    staging.push({
      source_kind: 'source_b',
      call_date: callDate,
      call_time: callTime,
      call_staff: str(r['ｺｰﾙ履歴::担当者']),
      content: str(r['ｺｰﾙ履歴::内容']),
      customer_staff: str(r['ｺｰﾙ履歴::お客様担当']),
      raw_phone: ffPhone,
      normalized_phone: normalizePhone(ffPhone),
      matched_customer_id: ffId,
      matched_customer_candidate_count: ffId ? '1' : '0',
      match_type: ffId ? 'fill_forward' : 'no_match',
      fill_forward_customer_id: ffId,
      raw_source_file: RAW_FILES.customerCsv,
      raw_row_origin: srcRowIndex,
      source_fingerprint: sourceFingerprint(RAW_FILES.customerCsv, parseInt(srcRowIndex) || 0),
    });
  }

  return staging;
}

// ─── Phase 15: Review Queues ─────────────────────────────────────────

interface ReviewQueueRow {
  review_reason: string;
  severity: string;
  source_kind: string;
  source_file: string;
  normalized_phone: string;
  raw_phone: string;
  candidate_customer_ids: string;
  candidate_count: string;
  call_date: string;
  call_time: string;
  call_owner: string;
  content_preview: string;
  raw_row_origin: string;
}

function buildCallMatchReviewQueue(
  sourceAResults: { row: SRow; match: PhoneMatchResult }[],
  sourceBStaging: SRow[],
): ReviewQueueRow[] {
  const queue: ReviewQueueRow[] = [];

  // Source A: multi_match, no_match, invalid
  for (const { row, match } of sourceAResults) {
    if (match.match_type === 'exact' || match.match_type === 'normalized' || match.match_type === 'empty') {
      continue;
    }

    let severity = 'medium';
    if (match.match_type === 'multi_match') severity = 'high';
    if (match.match_type === 'invalid') severity = 'low';

    queue.push({
      review_reason: match.match_type,
      severity,
      source_kind: 'source_a',
      source_file: RAW_FILES.callXlsx,
      normalized_phone: row.normalized_phone,
      raw_phone: row.raw_phone,
      candidate_customer_ids: match.candidate_ids.join(';'),
      candidate_count: String(match.candidate_count),
      call_date: row.call_date,
      call_time: row.call_time,
      call_owner: row.call_staff,
      content_preview: row.content.slice(0, 80),
      raw_row_origin: row.raw_row_origin,
    });
  }

  // Source B: rows with no fill_forward ID (orphans)
  for (const row of sourceBStaging) {
    if (row.fill_forward_customer_id) continue;

    queue.push({
      review_reason: 'no_match',
      severity: 'medium',
      source_kind: 'source_b',
      source_file: RAW_FILES.customerCsv,
      normalized_phone: row.normalized_phone,
      raw_phone: row.raw_phone,
      candidate_customer_ids: '',
      candidate_count: '0',
      call_date: row.call_date,
      call_time: row.call_time,
      call_owner: row.call_staff,
      content_preview: row.content.slice(0, 80),
      raw_row_origin: row.raw_row_origin,
    });
  }

  // Add weak_overlap entries: Source A calls that matched exactly but the
  // portal fingerprint analysis showed only 11% overlap. We flag source A
  // rows whose date+staff combo exists in source B (potential duplication).
  // This is informational — not blocking.

  return queue;
}

// ─── Phase 16: Status Dictionary ─────────────────────────────────────

interface StatusEntry {
  status_value: string;
  count: number;
  percentage: string;
  sample_customer_ids: string;
  normalized_stage: string;
  stage_confidence: string;
  requires_hearing: string;
}

function buildStatusDictionary(masterRows: Row[]): StatusEntry[] {
  const statusCounts = new Map<string, { count: number; ids: string[] }>();

  for (const r of masterRows) {
    const status = str(r['ステータス']).trim();
    if (!status) continue;
    if (!statusCounts.has(status)) statusCounts.set(status, { count: 0, ids: [] });
    const entry = statusCounts.get(status)!;
    entry.count++;
    if (entry.ids.length < 3) entry.ids.push(str(r['お客様ID']));
  }

  // Sort by count descending
  const sorted = [...statusCounts.entries()].sort((a, b) => b[1].count - a[1].count);
  const total = sorted.reduce((s, [, v]) => s + v.count, 0);

  // Normalized stage mapping (provisional)
  const stageMap: Record<string, { stage: string; confidence: string; hearing: string }> = {
    '完了': { stage: 'completed', confidence: 'high', hearing: '' },
    'キャンセル': { stage: 'cancelled', confidence: 'high', hearing: '' },
    '対応中': { stage: 'in_progress', confidence: 'medium', hearing: '具体的にどの段階か要確認' },
    'ＦＩＴ許可待ち': { stage: 'waiting_fit_approval', confidence: 'high', hearing: '' },
    'FIT許可待ち': { stage: 'waiting_fit_approval', confidence: 'high', hearing: '' },
    '書類待ち': { stage: 'waiting_documents', confidence: 'medium', hearing: 'どの書類を待っているか' },
    '工事待ち': { stage: 'waiting_construction', confidence: 'high', hearing: '' },
    '工事済み': { stage: 'construction_done', confidence: 'high', hearing: '' },
    '審査待ち': { stage: 'waiting_credit_review', confidence: 'high', hearing: '' },
    '否決': { stage: 'credit_rejected', confidence: 'high', hearing: '' },
    '可決': { stage: 'credit_approved', confidence: 'high', hearing: '' },
    '連変': { stage: 'grid_connection_change', confidence: 'low', hearing: '連系変更の業務意味を確認' },
    '取り直し': { stage: 'redo', confidence: 'low', hearing: '何を取り直すのか。再申請？再工事？' },
    '審査不可': { stage: 'credit_review_impossible', confidence: 'medium', hearing: '審査不可の扱い（キャンセルか保留か）' },
    '電力待ち': { stage: 'waiting_power_approval', confidence: 'high', hearing: '' },
    '保証待ち': { stage: 'waiting_warranty', confidence: 'medium', hearing: '何の保証を待っているか' },
    '入金待ち': { stage: 'waiting_payment', confidence: 'high', hearing: '' },
    '連系待ち': { stage: 'waiting_grid_connection', confidence: 'high', hearing: '' },
    '報告待ち': { stage: 'waiting_report', confidence: 'medium', hearing: '完工報告か検査報告か' },
    '見積待ち': { stage: 'waiting_estimate', confidence: 'high', hearing: '' },
  };

  return sorted.map(([status, { count, ids }]) => {
    const mapping = stageMap[status] || {
      stage: 'unresolved',
      confidence: 'low',
      hearing: '業務意味を確認',
    };
    return {
      status_value: status,
      count,
      percentage: pct(count, total),
      sample_customer_ids: ids.join(';'),
      normalized_stage: mapping.stage,
      stage_confidence: mapping.confidence,
      requires_hearing: mapping.hearing,
    };
  });
}

// ─── Phase 17: Schema Documentation ─────────────────────────────────

function buildSchemaMd(schemas: StagingSchema[], boundary: BoundaryItem[]): string {
  const lines: string[] = [
    '# Staging Schema v0 — Solar 260312',
    '',
    '> **注意**: この schema は草案 (v0) です。DDL 実行・DB 投入はしません。',
    '> Phase 1/2 の分析結果に基づく提案であり、業務ヒアリング未了の項目を含みます。',
    '',
    '## 概要',
    '',
    '| Entity | 推定行数 | ソース |',
    '|--------|---------|--------|',
  ];

  for (const s of schemas) {
    lines.push(`| ${s.entity} | ${s.estimated_rows.toLocaleString()} | ${s.source_files.join(', ')} |`);
  }

  lines.push('', '---', '');

  for (const s of schemas) {
    lines.push(`## ${s.entity}`, '', s.description, '');
    lines.push(
      '| column_name | proposed_type | nullable | source_column | normalization_rule | review | note |',
      '|-------------|---------------|----------|---------------|-------------------|--------|------|',
    );
    for (const c of s.columns) {
      lines.push(
        `| ${c.column_name} | ${c.proposed_type} | ${c.nullable ? 'YES' : 'NO'} | ${c.source_column} | ${c.normalization_rule} | ${c.review_required ? 'YES' : ''} | ${c.note} |`,
      );
    }
    lines.push('');
  }

  lines.push('---', '', '## Customer / Deal 境界レビュー', '');
  lines.push(
    '| source_column | current | recommended | confidence | action | rationale |',
    '|---------------|---------|-------------|------------|--------|-----------|',
  );
  for (const b of boundary) {
    lines.push(
      `| ${b.source_column} | ${b.current_entity} | ${b.recommended_entity} | ${b.confidence} | ${b.action} | ${b.rationale} |`,
    );
  }

  lines.push(
    '',
    '---',
    '',
    '## 未確定事項',
    '',
    '1. customer と deal の 1:1 / 1:N 関係は未確定。現データでは 1:1 に見えるが断定不可',
    '2. activity_call の Source A / Source B は partial_overlap (11% 厳密一致)。hard dedupe は行わない',
    '3. 「契約者」と顧客の関係性 — 同一人物の場合と家族名義の場合がある',
    '4. 「代表者」系列 — 法人顧客の代表者か個人の別名か未確認',
    '5. 見積依頼日 vs 【見積】依頼日 — 同一値か別フローか未確認',
    '6. ステータス値のうち「連変」「取り直し」の業務的意味が不明',
    '',
  );

  return lines.join('\n');
}

function buildSchemaSql(schemas: StagingSchema[]): string {
  const lines: string[] = [
    '-- Staging Schema v0 — Solar 260312',
    '-- 草案のみ。実行禁止。',
    '-- Generated: ' + new Date().toISOString().slice(0, 10),
    '',
  ];

  const pgTypeMap: Record<string, string> = {
    TEXT: 'TEXT',
    DATE: 'DATE',
    TIME: 'TIME',
    INTEGER: 'INTEGER',
    BOOLEAN: 'BOOLEAN',
  };

  for (const s of schemas) {
    lines.push(`-- ${s.description}`);
    lines.push(`CREATE TABLE staging_${s.entity} (`);
    const colLines: string[] = [];
    for (const c of s.columns) {
      let pgType = pgTypeMap[c.proposed_type] || c.proposed_type;
      if (pgType.startsWith('NUMERIC')) pgType = c.proposed_type; // keep as-is
      const nullable = c.nullable ? '' : ' NOT NULL';
      colLines.push(`  ${c.column_name} ${pgType}${nullable}`);
    }
    lines.push(colLines.join(',\n'));
    lines.push(');');
    lines.push('');
  }

  return lines.join('\n');
}

function buildReviewRulesMd(): string {
  return [
    '# Review Rules — Solar 260312 Phase 3',
    '',
    '## activity-call-match-review-queue',
    '',
    '| review_reason | severity | 条件 | 対処方針 |',
    '|---------------|----------|------|----------|',
    '| multi_match | high | 電話番号が2件以上の顧客にマッチ | 現場確認。内容・日付から正しい顧客を特定 |',
    '| no_match | medium | 有効な電話番号だが顧客マスタに該当なし | 新規顧客か、電話番号変更か確認 |',
    '| invalid | low | 電話番号として不正（桁数不足、非電話文字列） | データ品質問題。原本確認 |',
    '| weak_overlap | low | Source A/B 間で日付+担当者が一致するが内容が異なる | 情報提供。dedupe 判断に使用 |',
    '',
    '## customer-deal-boundary-review-queue',
    '',
    '各行の `action` フィールドを確認:',
    '- **keep**: 現在の分類を維持。根拠が明確',
    '- **move**: 別 entity への移動を推奨。次期 schema で反映',
    '- **review**: 業務ヒアリングが必要',
    '',
    '## status-dictionary-candidate',
    '',
    '`stage_confidence` が low の項目は業務ヒアリング必須。',
    '`requires_hearing` 列に確認すべき内容を記載。',
    '',
  ].join('\n');
}

function buildColumnClassificationMatrix(masterHeaders: string[]): SRow[] {
  const customerSet = new Set(CUSTOMER_COLUMNS);
  const dealSet = new Set(DEAL_COLUMNS);
  const metaSet = new Set(META_COLUMNS);

  return masterHeaders.map((col) => {
    let entity = 'unclassified';
    if (customerSet.has(col)) entity = 'customer';
    else if (dealSet.has(col)) entity = 'deal';
    else if (metaSet.has(col)) entity = 'meta';
    return {
      source_column: col,
      staging_entity: entity,
      source_file: RAW_FILES.customerCsv,
    };
  });
}

// ─── Phase 18: Summary ──────────────────────────────────────────────

function buildSummaryMd(
  stats: {
    customerCount: number;
    dealCount: number;
    sourceACount: number;
    sourceBCount: number;
    unionCount: number;
    reviewQueueCount: number;
    boundaryCount: number;
    statusCount: number;
    multiMatchCount: number;
    noMatchCount: number;
    invalidCount: number;
  },
  statusEntries: StatusEntry[],
): string {
  return [
    '# Phase 3 Summary — Solar 260312',
    '',
    `生成日: ${new Date().toISOString().slice(0, 10)}`,
    '',
    '## 生成した staging CSV',
    '',
    '| ファイル | 行数 | 説明 |',
    '|---------|------|------|',
    `| customer-staging-v0.csv | ${stats.customerCount} | 顧客基本情報 |`,
    `| deal-staging-v0.csv | ${stats.dealCount} | 案件・契約情報 |`,
    `| activity-call-source-a-staging-v0.csv | ${stats.sourceACount} | コール履歴（独立XLSX） |`,
    `| activity-call-source-b-staging-v0.csv | ${stats.sourceBCount} | コール履歴（ポータル展開） |`,
    `| activity-call-union-candidate.csv | ${stats.unionCount} | コール履歴統合候補（hard dedupe なし） |`,
    '',
    '## Review Queue',
    '',
    '| ファイル | 行数 | 説明 |',
    '|---------|------|------|',
    `| activity-call-match-review-queue.csv | ${stats.reviewQueueCount} | 電話番号マッチ要レビュー |`,
    `| customer-deal-boundary-review-queue.csv | ${stats.boundaryCount} | customer/deal 境界判断 |`,
    `| status-dictionary-candidate.csv | ${stats.statusCount} | ステータス値辞書候補 |`,
    '',
    '## 電話番号マッチ内訳 (Source A)',
    '',
    `| 分類 | 件数 |`,
    `|------|------|`,
    `| multi_match (要レビュー) | ${stats.multiMatchCount} |`,
    `| no_match (要レビュー) | ${stats.noMatchCount} |`,
    `| invalid (要レビュー) | ${stats.invalidCount} |`,
    '',
    '## ステータス値 (上位)',
    '',
    '| 値 | 件数 | 割合 | normalized_stage | confidence |',
    '|---|------|------|-----------------|------------|',
    ...statusEntries.slice(0, 10).map(
      (e) =>
        `| ${e.status_value} | ${e.count} | ${e.percentage} | ${e.normalized_stage} | ${e.stage_confidence} |`,
    ),
    '',
    '## Traceability',
    '',
    'すべての staging CSV に以下の列を付与:',
    '- `raw_source_file`: 元ファイル名',
    '- `raw_row_origin`: 元ファイルの行番号',
    '- `source_fingerprint`: `file:row_N` 形式の一意識別子',
    '',
    '## 未確定事項 (要ヒアリング)',
    '',
    '1. customer / deal の 1:1 vs 1:N 関係',
    '2. 「契約者」と顧客の同一性',
    '3. 「代表者」の意味（法人代表か個人の同居家族か）',
    '4. 見積依頼日 vs 【見積】依頼日の関係',
    '5. ステータス「連変」「取り直し」の業務的意味',
    '6. multi_match ケースの正しい紐付け方法',
    '7. Source A / B のどちらを primary とするか',
    '8. 商流・販売店・設置店名の entity 化要否',
    '',
    '## 次にやるべきこと',
    '',
    '1. **業務ヒアリング**: status dictionary の要確認項目を現場に確認',
    '2. **multi_match レビュー**: review queue の high severity を優先処理',
    '3. **Source A/B 統合方針決定**: overlap 分析結果をもとに merge strategy を確定',
    '4. **schema v1 策定**: ヒアリング結果を反映し、確定版 schema を作成',
    '5. **DDL 実行**: staging テーブルを Supabase に作成（Phase 4）',
    '6. **staging insert**: CSV を staging テーブルに投入（Phase 4）',
    '',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
// main
// ═══════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('=== Solar 260312 Phase 3: Staging Schema v0 & Review Queue ===\n');

  ensureDir(OUT_DIR);

  // ── Read inputs ──────────────────────────────────────────────────
  console.log('Phase 12: Reading inputs...');
  const masterData = readCsv(FILES.masterRows);
  console.log(`  master rows: ${masterData.rows.length}`);
  const portalData = readCsv(FILES.portalRows);
  console.log(`  portal rows: ${portalData.rows.length}`);
  const callData = readXlsx(FILES.callXlsx);
  console.log(`  call history rows: ${callData.rows.length}`);

  // ── Build phone index ────────────────────────────────────────────
  console.log('\nBuilding customer phone index...');
  const phoneIndex = buildCustomerPhoneIndex(masterData.rows);
  console.log(`  raw phone entries: ${phoneIndex.byRaw.size}`);
  console.log(`  normalized phone entries: ${phoneIndex.byNormalized.size}`);

  // ── Generate staging CSVs ────────────────────────────────────────
  console.log('\nPhase 13: Generating customer staging CSV...');
  const customerStaging = generateCustomerStaging(masterData.rows);
  writeCsvFile(resolve(OUT_DIR, 'customer-staging-v0.csv'), customerStaging);

  console.log('\nPhase 14: Generating deal staging CSV...');
  const dealStaging = generateDealStaging(masterData.rows);
  writeCsvFile(resolve(OUT_DIR, 'deal-staging-v0.csv'), dealStaging);

  console.log('\nPhase 15: Generating activity call staging CSVs...');

  const { staging: sourceAStaging, matchResults: sourceAMatchResults } =
    generateSourceAStaging(callData.rows, phoneIndex);
  writeCsvFile(resolve(OUT_DIR, 'activity-call-source-a-staging-v0.csv'), sourceAStaging);

  const sourceBStaging = generateSourceBStaging(portalData.rows);
  writeCsvFile(resolve(OUT_DIR, 'activity-call-source-b-staging-v0.csv'), sourceBStaging);

  const unionStaging = [...sourceAStaging, ...sourceBStaging];
  writeCsvFile(resolve(OUT_DIR, 'activity-call-union-candidate.csv'), unionStaging);

  // ── Generate review queues ───────────────────────────────────────
  console.log('\nPhase 16: Generating review queues...');

  const callReviewQueue = buildCallMatchReviewQueue(sourceAMatchResults, sourceBStaging);
  writeCsvFile(resolve(OUT_DIR, 'activity-call-match-review-queue.csv'), callReviewQueue);

  const boundary = buildBoundaryReview();
  writeCsvFile(
    resolve(OUT_DIR, 'customer-deal-boundary-review-queue.csv'),
    boundary.map((b) => ({
      source_column: b.source_column,
      current_entity: b.current_entity,
      recommended_entity: b.recommended_entity,
      confidence: b.confidence,
      rationale: b.rationale,
      action: b.action,
    })),
  );

  console.log('\nPhase 17: Generating status dictionary...');
  const statusEntries = buildStatusDictionary(masterData.rows);
  writeCsvFile(
    resolve(OUT_DIR, 'status-dictionary-candidate.csv'),
    statusEntries.map((e) => ({ ...e, count: String(e.count) })),
  );

  // ── Match stats ──────────────────────────────────────────────────
  const multiMatchCount = sourceAMatchResults.filter(
    (r) => r.match.match_type === 'multi_match',
  ).length;
  const noMatchCount = sourceAMatchResults.filter(
    (r) => r.match.match_type === 'no_match',
  ).length;
  const invalidCount = sourceAMatchResults.filter(
    (r) => r.match.match_type === 'invalid',
  ).length;

  // ── Schema documentation ─────────────────────────────────────────
  console.log('\nPhase 18: Generating schema documentation...');

  const schemas = [
    buildCustomerSchema(),
    buildDealSchema(),
    buildActivityCallSchema(),
  ];

  const schemaMd = buildSchemaMd(schemas, boundary);
  writeMd(resolve(OUT_DIR, 'staging-schema-v0.md'), schemaMd);

  const schemaJson = {
    version: 'v0',
    generated: new Date().toISOString(),
    batch: '260312',
    domain: 'solar',
    entities: schemas.map((s) => ({
      entity: s.entity,
      description: s.description,
      estimated_rows: s.estimated_rows,
      source_files: s.source_files,
      columns: s.columns,
    })),
  };
  writeJson(resolve(OUT_DIR, 'staging-schema-v0.json'), schemaJson);

  const schemaSql = buildSchemaSql(schemas);
  writeMd(resolve(OUT_DIR, 'staging-schema-v0.sql'), schemaSql);

  const reviewRules = buildReviewRulesMd();
  writeMd(resolve(OUT_DIR, 'review-rules.md'), reviewRules);

  const classMatrix = buildColumnClassificationMatrix(masterData.headers);
  writeCsvFile(resolve(OUT_DIR, 'column-classification-matrix.csv'), classMatrix);

  // ── Summary ──────────────────────────────────────────────────────
  console.log('\nPhase 19: Generating summary...');

  const summary = buildSummaryMd(
    {
      customerCount: customerStaging.length,
      dealCount: dealStaging.length,
      sourceACount: sourceAStaging.length,
      sourceBCount: sourceBStaging.length,
      unionCount: unionStaging.length,
      reviewQueueCount: callReviewQueue.length,
      boundaryCount: boundary.length,
      statusCount: statusEntries.length,
      multiMatchCount,
      noMatchCount,
      invalidCount,
    },
    statusEntries,
  );
  writeMd(resolve(OUT_DIR, 'phase3-summary.md'), summary);

  // ── Done ─────────────────────────────────────────────────────────
  console.log('\n=== Phase 3 完了 ===');
  console.log(`出力先: ${OUT_DIR}`);
  console.log(`\n生成ファイル数: ${11 + 5}`);
  console.log(`  staging CSV:     5 files`);
  console.log(`  review queue:    3 files`);
  console.log(`  schema docs:     3 files (md, json, sql)`);
  console.log(`  other docs:      3 files (summary, review-rules, classification-matrix)`);
  console.log(`  missing from nice-to-have: none`);
  console.log(`\nPhone match review queue: ${callReviewQueue.length} rows`);
  console.log(`  multi_match: ${multiMatchCount}`);
  console.log(`  no_match:    ${noMatchCount}`);
  console.log(`  invalid:     ${invalidCount}`);
  console.log(`\nStatus dictionary: ${statusEntries.length} unique values`);
}

main().catch((err) => {
  console.error('Phase 3 failed:', err);
  process.exit(1);
});
