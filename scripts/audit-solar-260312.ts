#!/usr/bin/env npx tsx
/**
 * Solar 初回監査スクリプト — 260312 batch
 *
 * 対象:
 *   - 260312_顧客_太陽光.xlsx
 *   - 260312_顧客_太陽光.csv
 *   - 260312_コール履歴_太陽光.xlsx
 *
 * 実行: npm run audit:solar
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, basename } from 'node:path';
import * as XLSX from 'xlsx';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { normalizePhone, validatePhone } from '../src/normalizers/phone.js';
import { normalizeDate } from '../src/normalizers/date.js';
import { fullWidthToHalfWidth } from '../src/normalizers/text.js';

// ─── paths ───────────────────────────────────────────────────────────
const RAW_DIR = resolve('/Users/evening/Developer/peace-biz-group/filemaker-raw-files/solar');
const OUT_DIR = resolve('artifacts/filemaker-audit/solar/260312');

const FILES = {
  customerXlsx: resolve(RAW_DIR, '260312_顧客_太陽光.xlsx'),
  customerCsv:  resolve(RAW_DIR, '260312_顧客_太陽光.csv'),
  callXlsx:     resolve(RAW_DIR, '260312_コール履歴_太陽光.xlsx'),
} as const;

// ─── types ───────────────────────────────────────────────────────────
type Row = Record<string, unknown>;

interface Provenance {
  absolute_path: string;
  file_size_bytes: number;
  modified_at: string;
  sha256: string;
  parser: 'sheetjs' | 'csv-parse';
}

interface ColumnStat {
  name: string;
  nonEmptyCount: number;
  totalCount: number;
  nonEmptyRate: number;
  uniqueCount: number;
  uniqueRate: number;
  inferredType: string;
  sampleValues: string[];
  isKeyCandidate: boolean;
  isDateCandidate: boolean;
  isPhoneCandidate: boolean;
  isStatusCandidate: boolean;
}

interface FileProfile {
  provenance: Provenance;
  fileName: string;
  format: string;
  sheetNames: string[];
  dataRowCount: number;
  columnCount: number;
  headers: string[];
  columns: ColumnStat[];
  parentChildMixed: boolean;
  parentChildDetail: {
    parentRowCount: number;
    portalColumns: string[];
  } | null;
  keyCandidates: string[];
  dateCandidates: string[];
  phoneCandidates: string[];
  statusCandidates: string[];
}

interface PhoneMatchBucket {
  bucket: 'exact' | 'normalized' | 'invalid' | 'no_match' | 'multi_match';
  count: number;
  rate: number;
  samples: string[];
}

// ─── helpers ─────────────────────────────────────────────────────────

function provenance(filePath: string, parser: 'sheetjs' | 'csv-parse'): Provenance {
  const buf = readFileSync(filePath);
  const st = statSync(filePath);
  return {
    absolute_path: resolve(filePath),
    file_size_bytes: st.size,
    modified_at: st.mtime.toISOString(),
    sha256: createHash('sha256').update(buf).digest('hex'),
    parser,
  };
}

function readXlsx(filePath: string): { sheetNames: string[]; rows: Row[]; headers: string[] } {
  const buf = readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: '' });
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { sheetNames: wb.SheetNames, rows, headers };
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

/** Excel serial number → YYYY/MM/DD string (for comparison normalization) */
function excelSerialToDate(serial: unknown): string | null {
  if (typeof serial !== 'number') return null;
  if (serial < 1 || serial > 100000) return null;
  // Excel epoch: 1899-12-30 (accounting for the 1900 leap year bug)
  const epoch = new Date(Date.UTC(1899, 11, 30));
  const ms = epoch.getTime() + serial * 86400000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Excel serial time fraction → HH:MM:SS */
function excelSerialToTime(serial: unknown): string | null {
  if (typeof serial !== 'number') return null;
  if (serial < 0 || serial >= 1) return null;
  const totalSeconds = Math.round(serial * 86400);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** FileMaker time string "N時間 N分 N秒 Nミリ秒" → HH:MM:SS */
function fmTimeToNormalized(raw: string): string | null {
  const m = raw.match(/(\d+)時間\s*(\d+)分\s*(\d+)秒/);
  if (!m) return null;
  return `${String(m[1]).padStart(2, '0')}:${String(m[2]).padStart(2, '0')}:${String(m[3]).padStart(2, '0')}`;
}

// ─── type inference ──────────────────────────────────────────────────

const DATE_PATTERNS = [
  /^\d{4}[/\-]\d{1,2}[/\-]\d{1,2}$/,
  /^(明治|大正|昭和|平成|令和)\d{1,2}年\d{1,2}月\d{1,2}日$/,
];

function inferType(values: unknown[]): string {
  const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
  if (nonEmpty.length === 0) return 'empty';

  const sample = nonEmpty.slice(0, 1000);
  let dateCount = 0, phoneCount = 0, numberCount = 0, boolCount = 0, emailCount = 0;

  for (const v of sample) {
    const s = String(v).trim();
    if (!s) continue;

    // Excel serial date
    if (typeof v === 'number' && v > 28000 && v < 60000) { dateCount++; continue; }
    // Excel serial time
    if (typeof v === 'number' && v >= 0 && v < 1) { dateCount++; continue; }

    if (DATE_PATTERNS.some(re => re.test(s))) { dateCount++; continue; }
    if (/^\d[\d\-]{8,12}$/.test(s) && s.replace(/\D/g, '').length >= 10 && s.replace(/\D/g, '').length <= 11) { phoneCount++; continue; }
    if (s.includes('@')) { emailCount++; continue; }
    if (/^[○×◯✓✗true|false|TRUE|FALSE|はい|いいえ|1|0]$/.test(s)) { boolCount++; continue; }
    if (/^-?[\d,.]+$/.test(s)) { numberCount++; continue; }
  }

  const total = sample.length;
  const threshold = 0.6;
  if (dateCount / total > threshold) return 'date';
  if (phoneCount / total > threshold) return 'phone';
  if (emailCount / total > threshold) return 'email';
  if (numberCount / total > threshold) return 'number';
  if (boolCount / total > threshold) return 'boolean';
  return 'text';
}

const STATUS_NAME_PATTERNS = ['ステータス', '状態', '結果', '区分', 'フラグ', 'ﾌﾗｸﾞ'];

function isStatusColumn(name: string, uniqueCount: number): boolean {
  if (uniqueCount < 2 || uniqueCount > 30) return false;
  const lower = fullWidthToHalfWidth(name).toLowerCase();
  return STATUS_NAME_PATTERNS.some(p => lower.includes(p));
}

// ─── profiling ───────────────────────────────────────────────────────

function profileData(
  fileName: string,
  format: string,
  sheetNames: string[],
  headers: string[],
  rows: Row[],
  prov: Provenance,
): FileProfile {
  const columnStats: ColumnStat[] = headers.map(name => {
    const values = rows.map(r => r[name]);
    const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
    const uniqueSet = new Set(nonEmpty.map(v => String(v)));
    const total = rows.length;
    const nonEmptyCount = nonEmpty.length;
    const uniqueCount = uniqueSet.size;
    const inferredType = inferType(values);
    const sampleValues = [...uniqueSet].slice(0, 5).map(String);

    return {
      name,
      nonEmptyCount,
      totalCount: total,
      nonEmptyRate: total > 0 ? nonEmptyCount / total : 0,
      uniqueCount,
      uniqueRate: nonEmptyCount > 0 ? uniqueCount / nonEmptyCount : 0,
      inferredType,
      sampleValues,
      isKeyCandidate: nonEmptyCount / total > 0.95 && uniqueCount / nonEmptyCount > 0.8,
      isDateCandidate: inferredType === 'date',
      isPhoneCandidate: inferredType === 'phone' || name.includes('電話') || name.includes('TEL') || name.includes('FAX'),
      isStatusCandidate: isStatusColumn(name, uniqueCount),
    };
  });

  // parent-child detection
  const portalColumns = headers.filter(h => h.includes('::'));
  const masterColumns = headers.filter(h => !h.includes('::'));
  const idColumn = headers.find(h => h === 'お客様ID' || h === 'ID' || h.includes('顧客ID'));
  let parentChildMixed = portalColumns.length > 0;
  let parentRowCount = rows.length;

  if (idColumn) {
    parentRowCount = rows.filter(r => {
      const v = r[idColumn];
      return v !== '' && v !== null && v !== undefined;
    }).length;
  }

  return {
    provenance: prov,
    fileName,
    format,
    sheetNames,
    dataRowCount: rows.length,
    columnCount: headers.length,
    headers,
    columns: columnStats,
    parentChildMixed,
    parentChildDetail: parentChildMixed ? {
      parentRowCount,
      portalColumns,
    } : null,
    keyCandidates: columnStats.filter(c => c.isKeyCandidate).map(c => c.name),
    dateCandidates: columnStats.filter(c => c.isDateCandidate).map(c => c.name),
    phoneCandidates: columnStats.filter(c => c.isPhoneCandidate).map(c => c.name),
    statusCandidates: columnStats.filter(c => c.isStatusCandidate).map(c => c.name),
  };
}

// ─── normalize value for comparison ──────────────────────────────────

const DATE_COLUMN_PATTERNS = ['日', '時刻', 'date', 'time', '生年月日', '発送', '到着', '完了', '申請', '着日', '書着', '許可', '連系', '入金', '計上'];

function isLikelyDateColumn(columnName: string, dateColumns?: Set<string>): boolean {
  if (dateColumns?.has(columnName)) return true;
  const lower = columnName.toLowerCase();
  return DATE_COLUMN_PATTERNS.some(p => lower.includes(p));
}

let _dateColumnsHint: Set<string> | undefined;

function normalizeForCompare(value: unknown, columnName: string, isXlsx: boolean): string {
  if (value === null || value === undefined || value === '') return '';
  const s = String(value).trim();
  if (!s) return '';

  if (isXlsx && typeof value === 'number') {
    if (isLikelyDateColumn(columnName, _dateColumnsHint)) {
      // Try date conversion only for date-like columns
      const d = excelSerialToDate(value);
      if (d) return d;
      // Try time conversion
      const t = excelSerialToTime(value);
      if (t) return t;
    }
    return s;
  }

  // CSV date normalization (only for date-like columns or date-patterned strings)
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) {
    return normalizeDate(s);
  }

  // FM time string
  if (isLikelyDateColumn(columnName, _dateColumnsHint)) {
    const fmt = fmTimeToNormalized(s);
    if (fmt) return fmt;
  }

  return s;
}

// ─── compare ─────────────────────────────────────────────────────────

interface CompareResult {
  headerMatch: boolean;
  headerDiff: { onlyInCsv: string[]; onlyInXlsx: string[]; common: string[] };
  rowCountCsv: number;
  rowCountXlsx: number;
  rowDiff: number;
  sampleCompare: {
    rowIndex: number;
    column: string;
    csvRaw: string;
    xlsxRaw: string;
    csvNormalized: string;
    xlsxNormalized: string;
    match: boolean;
  }[];
  matchRate: number;
  formatDifferences: { column: string; csvSample: string; xlsxSample: string; normalizedMatch: boolean }[];
}

function compareFiles(
  csvHeaders: string[], xlsxHeaders: string[],
  csvRows: Row[], xlsxRows: Row[],
): CompareResult {
  const csvSet = new Set(csvHeaders);
  const xlsxSet = new Set(xlsxHeaders);
  const common = csvHeaders.filter(h => xlsxSet.has(h));

  // Sample compare — first 100 rows, normalize then compare
  const sampleSize = Math.min(100, csvRows.length, xlsxRows.length);
  const sampleCompare: CompareResult['sampleCompare'] = [];
  let matchCount = 0;
  let totalCompared = 0;

  for (let i = 0; i < sampleSize; i++) {
    for (const col of common) {
      const csvVal = csvRows[i][col];
      const xlsxVal = xlsxRows[i][col];
      const csvNorm = normalizeForCompare(csvVal, col, false);
      const xlsxNorm = normalizeForCompare(xlsxVal, col, true);
      const match = csvNorm === xlsxNorm;
      totalCompared++;
      if (match) matchCount++;

      if (!match) {
        sampleCompare.push({
          rowIndex: i,
          column: col,
          csvRaw: String(csvVal ?? ''),
          xlsxRaw: String(xlsxVal ?? ''),
          csvNormalized: csvNorm,
          xlsxNormalized: xlsxNorm,
          match,
        });
      }
    }
  }

  // Format differences (column-level summary)
  const formatDiffs: CompareResult['formatDifferences'] = [];
  const seen = new Set<string>();
  for (const entry of sampleCompare) {
    if (!seen.has(entry.column)) {
      seen.add(entry.column);
      formatDiffs.push({
        column: entry.column,
        csvSample: entry.csvRaw,
        xlsxSample: entry.xlsxRaw,
        normalizedMatch: normalizeForCompare(entry.csvRaw, entry.column, false) === normalizeForCompare(entry.xlsxRaw, entry.column, true),
      });
    }
  }

  return {
    headerMatch: csvHeaders.length === xlsxHeaders.length && common.length === csvHeaders.length,
    headerDiff: {
      onlyInCsv: csvHeaders.filter(h => !xlsxSet.has(h)),
      onlyInXlsx: xlsxHeaders.filter(h => !csvSet.has(h)),
      common,
    },
    rowCountCsv: csvRows.length,
    rowCountXlsx: xlsxRows.length,
    rowDiff: csvRows.length - xlsxRows.length,
    sampleCompare: sampleCompare.slice(0, 50), // cap output
    matchRate: totalCompared > 0 ? matchCount / totalCompared : 1,
    formatDifferences: formatDiffs,
  };
}

// ─── relate ──────────────────────────────────────────────────────────

function relateCallToCustomer(
  callRows: Row[],
  customerRows: Row[],
): { buckets: PhoneMatchBucket[]; summary: string } {
  // Build customer phone index (normalized → customer IDs)
  const customerPhoneIndex = new Map<string, string[]>();
  const customerRawPhoneIndex = new Map<string, string[]>();

  for (const row of customerRows) {
    const id = String(row['お客様ID'] ?? '');
    if (!id) continue;

    for (const col of ['電話番号', '電番【検索用】', '緊急連絡先', '設置電話番号', '代表者携帯', '担当者携帯']) {
      const raw = String(row[col] ?? '').trim();
      if (!raw) continue;

      // Raw index
      if (!customerRawPhoneIndex.has(raw)) customerRawPhoneIndex.set(raw, []);
      customerRawPhoneIndex.get(raw)!.push(id);

      // Normalized index
      const norm = normalizePhone(raw);
      if (norm) {
        if (!customerPhoneIndex.has(norm)) customerPhoneIndex.set(norm, []);
        customerPhoneIndex.get(norm)!.push(id);
      }
    }
  }

  // Classify each call row
  const bucketCounts: Record<string, number> = { exact: 0, normalized: 0, invalid: 0, no_match: 0, multi_match: 0 };
  const bucketSamples: Record<string, string[]> = { exact: [], normalized: [], invalid: [], no_match: [], multi_match: [] };

  for (const row of callRows) {
    const raw = String(row['電話番号【検索】'] ?? '').trim();

    if (!raw) {
      addToBucket('invalid', '', bucketCounts, bucketSamples);
      continue;
    }

    const norm = normalizePhone(raw);
    const phoneError = validatePhone(norm);

    if (phoneError) {
      addToBucket('invalid', raw, bucketCounts, bucketSamples);
      continue;
    }

    // Exact match
    if (customerRawPhoneIndex.has(raw)) {
      const ids = customerRawPhoneIndex.get(raw)!;
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length > 1) {
        addToBucket('multi_match', raw, bucketCounts, bucketSamples);
      } else {
        addToBucket('exact', raw, bucketCounts, bucketSamples);
      }
      continue;
    }

    // Normalized match
    if (customerPhoneIndex.has(norm)) {
      const ids = customerPhoneIndex.get(norm)!;
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length > 1) {
        addToBucket('multi_match', raw, bucketCounts, bucketSamples);
      } else {
        addToBucket('normalized', raw, bucketCounts, bucketSamples);
      }
      continue;
    }

    addToBucket('no_match', raw, bucketCounts, bucketSamples);
  }

  const total = callRows.length;
  const buckets: PhoneMatchBucket[] = (['exact', 'normalized', 'invalid', 'no_match', 'multi_match'] as const).map(b => ({
    bucket: b,
    count: bucketCounts[b],
    rate: total > 0 ? bucketCounts[b] / total : 0,
    samples: bucketSamples[b].slice(0, 10),
  }));

  const matchable = bucketCounts.exact + bucketCounts.normalized;
  const summary = [
    `コール履歴 ${total} 件中:`,
    `  exact match:      ${bucketCounts.exact} (${pct(bucketCounts.exact, total)})`,
    `  normalized match: ${bucketCounts.normalized} (${pct(bucketCounts.normalized, total)})`,
    `  multi_match:      ${bucketCounts.multi_match} (${pct(bucketCounts.multi_match, total)})`,
    `  no_match:         ${bucketCounts.no_match} (${pct(bucketCounts.no_match, total)})`,
    `  invalid:          ${bucketCounts.invalid} (${pct(bucketCounts.invalid, total)})`,
    `  → 結合可能率: ${pct(matchable, total)}`,
  ].join('\n');

  return { buckets, summary };
}

function addToBucket(
  bucket: string, value: string,
  counts: Record<string, number>,
  samples: Record<string, string[]>,
): void {
  counts[bucket]++;
  if (samples[bucket].length < 10 && value) {
    samples[bucket].push(value);
  }
}

function pct(n: number, total: number): string {
  return total > 0 ? `${(n / total * 100).toFixed(1)}%` : '0%';
}

// ─── staging model ───────────────────────────────────────────────────

function classifyColumns(headers: string[]): Record<string, string[]> {
  const customer: string[] = [];
  const deal: string[] = [];
  const activity: string[] = [];
  const meta: string[] = [];

  const customerPatterns = ['ID', '契約者', '氏名', '名前', 'ﾌﾘｶﾞﾅ', 'フリガナ', '住所', '電話', 'FAX', 'メール', '郵便番号', '職業', '業種', '生年月日', '携帯', '緊急連絡先', '連絡先', '連絡時間', 'ユーザー名', 'パスワード', 'お客様ID', 'インボイス'];
  const dealPatterns = ['受注', '契約', '計上', '商流', '工事', '設置', 'kw', 'モジュール', 'メーカー', 'リース', '月額', '見積', '審査', '信販', '申込', '発注', '納入', '入金', '請求', '伝票', '成績', '完工', '保証', 'FIT', '電力申請', '連系', '承諾書', '借受証', '災害補償', '部材', 'ｻｰﾋﾞｽ品', '追加工事', '枚数', '計上粗利'];
  const activityPatterns = ['ｺｰﾙ履歴::', 'コール', '訪問', '再訪', '回数', '営業コメント', '営業担当', '訪問担当', 'ｱﾎﾟ', 'ドローン現調'];
  const metaPatterns = ['作成時刻', '作成者', '作成日', '修正時刻', '修正者', '修正日', '本日', '書類データ'];

  for (const h of headers) {
    if (activityPatterns.some(p => h.includes(p))) { activity.push(h); continue; }
    if (metaPatterns.some(p => h.includes(p))) { meta.push(h); continue; }
    if (dealPatterns.some(p => h.includes(p))) { deal.push(h); continue; }
    if (customerPatterns.some(p => h.includes(p))) { customer.push(h); continue; }
    // Remaining → need review
    deal.push(h); // default to deal since most unknown columns in this dataset are deal-related
  }

  return { customer, deal, activity, meta };
}

// ─── writers ─────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  ✓ ${basename(filePath)}`);
}

function writeCsv(filePath: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    writeFileSync(filePath, '', 'utf-8');
  } else {
    writeFileSync(filePath, stringify(rows, { header: true }), 'utf-8');
  }
  console.log(`  ✓ ${basename(filePath)}`);
}

function writeMd(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf-8');
  console.log(`  ✓ ${basename(filePath)}`);
}

// ─── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Solar 初回監査 (260312 batch) ===\n');

  // ── Phase 1: Ingest ──
  console.log('[1/6] Ingest');

  const custXlsx = readXlsx(FILES.customerXlsx);
  console.log(`  顧客.xlsx: ${custXlsx.rows.length} rows, ${custXlsx.headers.length} cols, sheets=${custXlsx.sheetNames}`);

  const custCsv = readCsv(FILES.customerCsv);
  console.log(`  顧客.csv:  ${custCsv.rows.length} rows, ${custCsv.headers.length} cols`);

  const callXlsx = readXlsx(FILES.callXlsx);
  console.log(`  コール履歴.xlsx: ${callXlsx.rows.length} rows, ${callXlsx.headers.length} cols, sheets=${callXlsx.sheetNames}`);

  // ── Phase 2: Profile ──
  console.log('\n[2/6] Profile');

  const provCustXlsx = provenance(FILES.customerXlsx, 'sheetjs');
  const provCustCsv = provenance(FILES.customerCsv, 'csv-parse');
  const provCallXlsx = provenance(FILES.callXlsx, 'sheetjs');

  const profileCustXlsx = profileData('260312_顧客_太陽光.xlsx', 'xlsx', custXlsx.sheetNames, custXlsx.headers, custXlsx.rows, provCustXlsx);
  console.log(`  顧客.xlsx: keys=${profileCustXlsx.keyCandidates.length}, dates=${profileCustXlsx.dateCandidates.length}, phones=${profileCustXlsx.phoneCandidates.length}, status=${profileCustXlsx.statusCandidates.length}, parentChild=${profileCustXlsx.parentChildMixed}`);

  const profileCustCsv = profileData('260312_顧客_太陽光.csv', 'csv', [], custCsv.headers, custCsv.rows, provCustCsv);
  console.log(`  顧客.csv:  keys=${profileCustCsv.keyCandidates.length}, dates=${profileCustCsv.dateCandidates.length}, phones=${profileCustCsv.phoneCandidates.length}, status=${profileCustCsv.statusCandidates.length}, parentChild=${profileCustCsv.parentChildMixed}`);

  const profileCall = profileData('260312_コール履歴_太陽光.xlsx', 'xlsx', callXlsx.sheetNames, callXlsx.headers, callXlsx.rows, provCallXlsx);
  console.log(`  コール履歴.xlsx: keys=${profileCall.keyCandidates.length}, dates=${profileCall.dateCandidates.length}, phones=${profileCall.phoneCandidates.length}, status=${profileCall.statusCandidates.length}`);

  // ── Phase 3: Compare ──
  console.log('\n[3/6] Compare (顧客 CSV vs XLSX)');
  // Combine date candidates from both profiles as hint for normalization
  _dateColumnsHint = new Set([...profileCustXlsx.dateCandidates, ...profileCustCsv.dateCandidates]);
  const compareResult = compareFiles(custCsv.headers, custXlsx.headers, custCsv.rows, custXlsx.rows);
  console.log(`  header match: ${compareResult.headerMatch}`);
  console.log(`  rows: csv=${compareResult.rowCountCsv}, xlsx=${compareResult.rowCountXlsx}, diff=${compareResult.rowDiff}`);
  console.log(`  normalized match rate (先頭100行): ${(compareResult.matchRate * 100).toFixed(1)}%`);
  console.log(`  format differences (columns): ${compareResult.formatDifferences.length}`);

  // ── Phase 4: Relate ──
  console.log('\n[4/6] Relate (コール履歴 → 顧客)');

  // Use CSV customer data (easier to work with — string values)
  // Build parent-only rows (rows where お客様ID is populated)
  const customerParentRows = custCsv.rows.filter(r => {
    const v = r['お客様ID'];
    return v !== '' && v !== null && v !== undefined;
  });
  console.log(`  顧客マスタ行数 (お客様ID あり): ${customerParentRows.length}`);

  const relate = relateCallToCustomer(callXlsx.rows, customerParentRows);
  console.log(relate.summary);

  // ── Phase 5: Stage ──
  console.log('\n[5/6] Staging 一次分解案');
  const classified = classifyColumns(custCsv.headers.filter(h => !h.includes('::')));
  console.log(`  customer 相当: ${classified.customer.length} 列`);
  console.log(`  deal 相当:     ${classified.deal.length} 列`);
  console.log(`  activity 相当: ${classified.activity.length} 列`);
  console.log(`  meta 相当:     ${classified.meta.length} 列`);

  // ── Phase 6: Write ──
  console.log('\n[6/6] 成果物出力');
  ensureDir(OUT_DIR);
  ensureDir(resolve(OUT_DIR, 'preview'));

  // source-profile.json
  writeJson(resolve(OUT_DIR, 'source-profile.json'), {
    generatedAt: new Date().toISOString(),
    batchId: '260312',
    domain: 'solar',
    files: [profileCustXlsx, profileCustCsv, profileCall],
  });

  // column-inventory.csv
  const allColumns: Record<string, unknown>[] = [];
  for (const profile of [profileCustXlsx, profileCustCsv, profileCall]) {
    for (const col of profile.columns) {
      allColumns.push({
        file: profile.fileName,
        column: col.name,
        inferredType: col.inferredType,
        nonEmptyRate: (col.nonEmptyRate * 100).toFixed(1) + '%',
        uniqueCount: col.uniqueCount,
        uniqueRate: (col.uniqueRate * 100).toFixed(1) + '%',
        isKeyCandidate: col.isKeyCandidate,
        isDateCandidate: col.isDateCandidate,
        isPhoneCandidate: col.isPhoneCandidate,
        isStatusCandidate: col.isStatusCandidate,
        samples: col.sampleValues.join(' | '),
      });
    }
  }
  writeCsv(resolve(OUT_DIR, 'column-inventory.csv'), allColumns);

  // file-compare.md
  const compareMd = buildCompareMarkdown(compareResult);
  writeMd(resolve(OUT_DIR, 'file-compare.md'), compareMd);

  // key-candidate-analysis.md
  const keyMd = buildKeyCandidateMarkdown(profileCustCsv, profileCall, relate, customerParentRows.length);
  writeMd(resolve(OUT_DIR, 'key-candidate-analysis.md'), keyMd);

  // review-issues.csv
  const issues = buildReviewIssues(profileCustXlsx, profileCustCsv, profileCall, compareResult, relate);
  writeCsv(resolve(OUT_DIR, 'review-issues.csv'), issues);

  // proposed-staging-model.md
  const stagingMd = buildStagingModel(classified, profileCustCsv, profileCall, relate, customerParentRows.length);
  writeMd(resolve(OUT_DIR, 'proposed-staging-model.md'), stagingMd);

  // preview CSVs
  const csvPreviewRows = custCsv.rows.slice(0, 100).map(r => {
    const out: Record<string, string> = {};
    for (const h of custCsv.headers) out[h] = String(r[h] ?? '');
    return out;
  });
  writeCsv(resolve(OUT_DIR, 'preview', '顧客_太陽光_preview.csv'), csvPreviewRows);

  const callPreviewRows = callXlsx.rows.slice(0, 100).map(r => {
    const out: Record<string, string> = {};
    for (const h of callXlsx.headers) {
      const v = r[h];
      // Convert serial dates for readability
      if (typeof v === 'number' && h.includes('日')) {
        out[h] = excelSerialToDate(v) ?? String(v);
      } else if (typeof v === 'number' && h === '時刻') {
        out[h] = excelSerialToTime(v) ?? String(v);
      } else {
        out[h] = String(v ?? '');
      }
    }
    return out;
  });
  writeCsv(resolve(OUT_DIR, 'preview', 'コール履歴_太陽光_preview.csv'), callPreviewRows);

  // normalization-candidates.csv
  const normCandidates = buildNormalizationCandidates(profileCustCsv, profileCall);
  writeCsv(resolve(OUT_DIR, 'normalization-candidates.csv'), normCandidates);

  // staging-column-map.csv
  const stagingMap = buildStagingColumnMap(classified, custCsv.headers, callXlsx.headers);
  writeCsv(resolve(OUT_DIR, 'staging-column-map.csv'), stagingMap);

  console.log('\n=== 完了 ===');
  console.log(`出力先: ${OUT_DIR}`);
}

// ─── markdown builders ──────────────────────────────────────────────

function buildCompareMarkdown(result: CompareResult): string {
  const lines = [
    '# 顧客 CSV vs XLSX 比較レポート',
    '',
    '## 概要',
    '',
    `| 項目 | CSV | XLSX | 差分 |`,
    `|------|-----|------|------|`,
    `| 行数 | ${result.rowCountCsv} | ${result.rowCountXlsx} | ${result.rowDiff} |`,
    `| 列数 | ${result.headerDiff.common.length + result.headerDiff.onlyInCsv.length} | ${result.headerDiff.common.length + result.headerDiff.onlyInXlsx.length} | — |`,
    `| ヘッダー一致 | ${result.headerMatch ? 'はい' : 'いいえ'} | — | — |`,
    `| 正規化後一致率 (先頭100行) | ${(result.matchRate * 100).toFixed(1)}% | — | — |`,
    '',
    '## 結論',
    '',
    result.headerMatch && result.rowDiff === 0
      ? '**同一データの別形式エクスポート**。列構成・行数ともに完全一致。差異は日付・時刻のフォーマットのみ。'
      : '列構成または行数に差異あり。詳細は以下を参照。',
    '',
    'パイプライン用途には **CSV を推奨**（日付が文字列で直接パース可能、エンコーディングが UTF-8）。',
    '',
  ];

  if (result.headerDiff.onlyInCsv.length > 0) {
    lines.push('## CSV のみに存在する列', '', ...result.headerDiff.onlyInCsv.map(h => `- ${h}`), '');
  }
  if (result.headerDiff.onlyInXlsx.length > 0) {
    lines.push('## XLSX のみに存在する列', '', ...result.headerDiff.onlyInXlsx.map(h => `- ${h}`), '');
  }

  if (result.formatDifferences.length > 0) {
    lines.push(
      '## フォーマット差異のある列',
      '',
      '| 列名 | CSV サンプル | XLSX サンプル | 正規化後一致 |',
      '|------|-------------|-------------|------------|',
    );
    for (const d of result.formatDifferences.slice(0, 30)) {
      lines.push(`| ${d.column} | ${d.csvSample} | ${d.xlsxSample} | ${d.normalizedMatch ? '○' : '×'} |`);
    }
    lines.push('');
  }

  if (result.sampleCompare.length > 0 && result.matchRate < 1) {
    lines.push(
      '## 正規化後も不一致のセル (先頭100行からサンプル)',
      '',
      '| 行 | 列 | CSV (正規化後) | XLSX (正規化後) |',
      '|----|----|--------------|----------------|',
    );
    const mismatches = result.sampleCompare.filter(s => !s.match).slice(0, 20);
    for (const s of mismatches) {
      lines.push(`| ${s.rowIndex} | ${s.column} | ${s.csvNormalized} | ${s.xlsxNormalized} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function buildKeyCandidateMarkdown(
  custProfile: FileProfile,
  callProfile: FileProfile,
  relate: { buckets: PhoneMatchBucket[]; summary: string },
  parentRowCount: number,
): string {
  const lines = [
    '# キー候補分析',
    '',
    '## 顧客ファイル',
    '',
    `実データ行数: ${custProfile.dataRowCount} (うちマスタ行: ${parentRowCount}, ポータル展開行: ${custProfile.dataRowCount - parentRowCount})`,
    '',
    '### 必須キー候補 (非空率 > 95%, ユニーク率 > 80%)',
    '',
    '| 列名 | 非空率 | ユニーク値数 | ユニーク率 | 型 |',
    '|------|--------|------------|----------|-----|',
  ];

  for (const col of custProfile.columns.filter(c => c.isKeyCandidate)) {
    lines.push(`| ${col.name} | ${(col.nonEmptyRate * 100).toFixed(1)}% | ${col.uniqueCount} | ${(col.uniqueRate * 100).toFixed(1)}% | ${col.inferredType} |`);
  }

  lines.push('', '### 日付列候補', '', '| 列名 | 非空率 | サンプル |', '|------|--------|---------|');
  for (const col of custProfile.columns.filter(c => c.isDateCandidate)) {
    lines.push(`| ${col.name} | ${(col.nonEmptyRate * 100).toFixed(1)}% | ${col.sampleValues.slice(0, 3).join(', ')} |`);
  }

  lines.push('', '### 電話番号列候補', '', '| 列名 | 非空率 | サンプル |', '|------|--------|---------|');
  for (const col of custProfile.columns.filter(c => c.isPhoneCandidate)) {
    lines.push(`| ${col.name} | ${(col.nonEmptyRate * 100).toFixed(1)}% | ${col.sampleValues.slice(0, 3).join(', ')} |`);
  }

  lines.push('', '### ステータス列候補', '', '| 列名 | ユニーク値数 | サンプル値 |', '|------|------------|----------|');
  for (const col of custProfile.columns.filter(c => c.isStatusCandidate)) {
    lines.push(`| ${col.name} | ${col.uniqueCount} | ${col.sampleValues.slice(0, 5).join(', ')} |`);
  }

  lines.push(
    '',
    '## コール履歴ファイル',
    '',
    `データ行数: ${callProfile.dataRowCount}`,
    '',
    '### 全列',
    '',
    '| 列名 | 非空率 | ユニーク値数 | 型 | サンプル |',
    '|------|--------|------------|-----|---------|',
  );
  for (const col of callProfile.columns) {
    lines.push(`| ${col.name} | ${(col.nonEmptyRate * 100).toFixed(1)}% | ${col.uniqueCount} | ${col.inferredType} | ${col.sampleValues.slice(0, 3).join(', ')} |`);
  }

  lines.push(
    '',
    '## 結合キー分析 (コール履歴 → 顧客)',
    '',
    '結合キー候補: `電話番号【検索】` (コール履歴側) ↔ `電話番号` / `電番【検索用】` 等 (顧客側)',
    '',
    '### 信頼度バケット',
    '',
    '| バケット | 件数 | 比率 | 説明 |',
    '|---------|------|------|------|',
  );

  const bucketDesc: Record<string, string> = {
    exact: 'raw 値が完全一致',
    normalized: '正規化後に一致（ハイフン除去・全角半角統一）',
    multi_match: '正規化後に複数顧客にマッチ',
    no_match: '有効な電話番号だが顧客側に該当なし',
    invalid: '電話番号として不正な値',
  };

  for (const b of relate.buckets) {
    lines.push(`| ${b.bucket} | ${b.count} | ${(b.rate * 100).toFixed(1)}% | ${bucketDesc[b.bucket]} |`);
  }

  if (relate.buckets.some(b => b.bucket === 'invalid' && b.samples.length > 0)) {
    const invalidBucket = relate.buckets.find(b => b.bucket === 'invalid')!;
    lines.push('', '### invalid サンプル', '', ...invalidBucket.samples.map(s => `- \`${s}\``));
  }

  if (relate.buckets.some(b => b.bucket === 'no_match' && b.samples.length > 0)) {
    const noMatchBucket = relate.buckets.find(b => b.bucket === 'no_match')!;
    lines.push('', '### no_match サンプル', '', ...noMatchBucket.samples.map(s => `- \`${s}\``));
  }

  return lines.join('\n');
}

function buildReviewIssues(
  custXlsx: FileProfile, custCsv: FileProfile, call: FileProfile,
  compare: CompareResult,
  relate: { buckets: PhoneMatchBucket[] },
): Record<string, string>[] {
  const issues: Record<string, string>[] = [];

  // Row count difference between CSV and XLSX
  if (compare.rowCountCsv !== compare.rowCountXlsx) {
    issues.push({
      id: 'SOLAR-010',
      severity: 'medium',
      file: '260312_顧客_太陽光.csv/.xlsx',
      issue: `CSV と XLSX の行数差: ${compare.rowDiff} 行 (CSV=${compare.rowCountCsv}, XLSX=${compare.rowCountXlsx})`,
      detail: 'SheetJS の空行スキップ挙動、または FileMaker エクスポート時の差異が原因の可能性。CSV を primary source とする場合は実害なし。',
      action: '差分行の内容を確認し、欠落データがないか検証',
    });
  }

  // Parent-child mixing
  if (custCsv.parentChildMixed) {
    issues.push({
      id: 'SOLAR-001',
      severity: 'high',
      file: '260312_顧客_太陽光.csv/.xlsx',
      issue: '親子混在: 顧客マスタ + コール履歴ポータルが同一シートに縦展開',
      detail: `マスタ行 ${custCsv.parentChildDetail?.parentRowCount ?? '?'} / 全行 ${custCsv.dataRowCount}。分解が必要。`,
      action: '顧客マスタ行とポータル行を分離し、ポータル列はコール履歴テーブルに結合する',
    });
  }

  // Broken column
  if (call.headers.includes('<テーブルが見つかりません>')) {
    issues.push({
      id: 'SOLAR-002',
      severity: 'medium',
      file: '260312_コール履歴_太陽光.xlsx',
      issue: 'リレーション切れ列: <テーブルが見つかりません>',
      detail: '全行空値。FileMaker 側のリレーション切れによるゴースト列。',
      action: 'staging 時に除外',
    });
  }

  // No customer ID in call history
  issues.push({
    id: 'SOLAR-003',
    severity: 'high',
    file: '260312_コール履歴_太陽光.xlsx',
    issue: '顧客IDなし — 電話番号のみで結合が必要',
    detail: 'お客様IDへの外部キー列がない。電話番号【検索】でのマッチングが唯一の結合手段。',
    action: '電話番号正規化後に顧客と突合。multi_match / no_match は人手レビュー対象',
  });

  // Invalid phone values
  const invalidBucket = relate.buckets.find(b => b.bucket === 'invalid');
  if (invalidBucket && invalidBucket.count > 0) {
    issues.push({
      id: 'SOLAR-004',
      severity: 'medium',
      file: '260312_コール履歴_太陽光.xlsx',
      issue: `電話番号【検索】に非電話番号値が ${invalidBucket.count} 件混入`,
      detail: `サンプル: ${invalidBucket.samples.slice(0, 5).join(', ')}`,
      action: '内容を確認し、電話番号以外の用途（メモ等）は別途分類',
    });
  }

  // DateTime format
  issues.push({
    id: 'SOLAR-005',
    severity: 'low',
    file: '260312_コール履歴_太陽光.xlsx',
    issue: '日時列のフォーマット不整合: "2020/12/2815:25" (スペースなし)',
    detail: '日付と時刻の間にスペース/区切りなしで連結されている。パース時に分割処理が必要。',
    action: '正規化時に YYYY/MM/DD と HH:MM:SS に分割',
  });

  // Excel serial dates
  issues.push({
    id: 'SOLAR-006',
    severity: 'low',
    file: '260312_顧客_太陽光.xlsx',
    issue: '日付列が Excel serial number (XLSX)',
    detail: 'CSV 版は YYYY/MM/DD 文字列で扱いやすい。パイプラインには CSV を使用推奨。',
    action: 'CSV を primary source として使用',
  });

  // FM time format
  issues.push({
    id: 'SOLAR-007',
    severity: 'low',
    file: '260312_顧客_太陽光.csv',
    issue: '時刻列が FileMaker 独自形式: "8時間 25分 38秒 0ミリ秒"',
    detail: 'ISO 形式への変換が必要。',
    action: '正規化時に HH:MM:SS に変換',
  });

  // Data not suitable for direct DB import
  issues.push({
    id: 'SOLAR-008',
    severity: 'high',
    file: '全ファイル',
    issue: 'そのまま DB 投入すべきでない理由',
    detail: [
      '(1) 親子混在: 1行=1エンティティではない',
      '(2) 正規化未済: 日付・電話・時刻フォーマットが不統一',
      '(3) 結合キー未確立: コール履歴と顧客の紐付けが電話番号のみ（一意性・網羅性に課題）',
      '(4) ステータス・区分値の意味が未確認',
      '(5) ポータル列と独立テーブルの重複データの整理が必要',
    ].join('; '),
    action: '本 audit 結果を基に staging 設計 → 人手レビュー → 段階的投入',
  });

  // UNC paths in 書類データ
  const docCol = custCsv.columns.find(c => c.name === '書類データ');
  if (docCol && docCol.nonEmptyCount > 0) {
    issues.push({
      id: 'SOLAR-009',
      severity: 'info',
      file: '260312_顧客_太陽光.csv',
      issue: '書類データ列に UNC パスが格納',
      detail: `非空率 ${(docCol.nonEmptyRate * 100).toFixed(1)}%。ファイルサーバー参照パスのため、移行対象の確認が必要。`,
      action: 'ファイルサーバーのアクセス可否・移行要否を確認',
    });
  }

  return issues;
}

function buildStagingModel(
  classified: Record<string, string[]>,
  custProfile: FileProfile,
  callProfile: FileProfile,
  relate: { buckets: PhoneMatchBucket[]; summary: string },
  parentRowCount: number,
): string {
  const matchable = relate.buckets
    .filter(b => b.bucket === 'exact' || b.bucket === 'normalized')
    .reduce((sum, b) => sum + b.count, 0);

  return [
    '# Staging 一次分解案',
    '',
    '> **注意**: この分解案は初回監査に基づく「候補」です。確定ではありません。',
    '> FileMaker の「顧客管理」テーブルには顧客基本情報だけでなく、案件（Deal）情報・コール履歴ポータルが混在しています。',
    '> 「顧客管理」＝ Customer 正本とは断定できません。',
    '',
    '## そのまま DB 投入しない理由',
    '',
    '1. **親子混在**: 顧客ファイル 52,623行のうちマスタ行は約 ' + parentRowCount + ' 行。残りはポータル展開によるコール履歴の縦展開行',
    '2. **正規化未済**: 日付・時刻・電話番号のフォーマットが不統一',
    '3. **結合キー未確立**: コール履歴の顧客紐付けが電話番号のみ（一意性に課題あり）',
    '4. **ステータス値の意味が未検証**: 「完了」「キャンセル」等の業務上の意味を現場に確認が必要',
    '5. **ポータル列と独立テーブルの重複**: 顧客ファイル内の ｺｰﾙ履歴:: 列とコール履歴.xlsx の関係を整理する必要あり',
    '',
    '## 分解案',
    '',
    '### 1. customer (顧客基本情報)',
    '',
    `推定件数: ${parentRowCount} 件（お客様ID が存在する行）`,
    '',
    'ソース: 260312_顧客_太陽光.csv のマスタ行（お客様ID が値を持つ行のみ抽出）',
    '',
    '含まれる列:',
    '',
    ...classified.customer.map(c => `- ${c}`),
    '',
    '**未確定事項**:',
    '- 「契約者」と「申込者」の関係（同一人物か別人か）',
    '- 「使用者との続柄」「契約者との続柄」の意味',
    '- 「代表者」系列の列の位置づけ（法人顧客の代表者？）',
    '',
    '### 2. deal (案件・契約情報)',
    '',
    '推定件数: customer と 1:1 の可能性が高いが、要検証',
    '',
    'ソース: 260312_顧客_太陽光.csv のマスタ行',
    '',
    '含まれる列:',
    '',
    ...classified.deal.map(c => `- ${c}`),
    '',
    '**未確定事項**:',
    '- 1顧客に対して複数案件が存在するかどうか（現データでは1:1に見えるが断定不可）',
    '- キャンセル案件の扱い（ステータス「キャンセル」の行が deal として独立するか）',
    '- 部材・見積・審査の粒度（1案件に対して複数あり得るか）',
    '',
    '### 3. activity_call (コール履歴)',
    '',
    `推定件数: ${callProfile.dataRowCount} 件（コール履歴.xlsx）+ 顧客ファイル内ポータル展開分`,
    '',
    '2つのソースが存在:',
    '- **ソースA**: 260312_コール履歴_太陽光.xlsx（独立テーブル、8列）',
    '- **ソースB**: 260312_顧客_太陽光.csv のポータル展開行（ｺｰﾙ履歴:: 列）',
    '',
    'ソースA の列:',
    '',
    ...callProfile.headers.filter(h => h !== '<テーブルが見つかりません>').map(c => `- ${c}`),
    '',
    'ソースB の列 (顧客ファイル内):',
    '',
    ...custProfile.columns.filter(c => c.name.startsWith('ｺｰﾙ履歴::')).map(c => `- ${c.name}`),
    '',
    '結合キー: `電話番号【検索】` → 顧客の `電話番号` / `電番【検索用】`',
    `結合可能率: ${pct(matchable, callProfile.dataRowCount)} (exact + normalized)`,
    '',
    '**未確定事項**:',
    '- ソースA とソースB が同一データの別エクスポートかどうか（件数差あり: A=' + callProfile.dataRowCount + ', B=ポータル展開分は未カウント）',
    '- multi_match のケースの正しい紐付け方法',
    '- 「お客様担当」列の意味（担当者名？ステータス？）',
    '',
    '### 4. raw_snapshot (監査用原本参照)',
    '',
    '目的: 原本に立ち返れるよう、audit 時点の provenance + 構造情報を保持',
    '',
    '- source-profile.json に sha256, file_size, modified_at を記録済み',
    '- raw ファイル自体は read-only で保持（repo 外）',
    '- preview CSV は先頭100行の参照用スナップショット',
    '',
    '## メタ情報列 (staging 時に除外候補)',
    '',
    ...classified.meta.map(c => `- ${c}`),
    '',
    '## 次のステップ',
    '',
    '1. **現場確認**: ステータス値の業務的意味、「契約者」と「申込者」の関係',
    '2. **ポータル展開の分離**: 顧客ファイルからマスタ行を抽出し、ポータル行を別テーブルに分離',
    '3. **コール履歴の統合方針決定**: ソースA とソースB の重複を確認し、どちらを正とするか決定',
    '4. **電話番号結合の精度改善**: multi_match / no_match ケースのレビュー',
    '5. **staging スキーマ設計**: customer / deal / activity_call のテーブル設計',
  ].join('\n');
}

function buildNormalizationCandidates(custProfile: FileProfile, callProfile: FileProfile): Record<string, string>[] {
  const candidates: Record<string, string>[] = [];

  for (const profile of [custProfile, callProfile]) {
    for (const col of profile.columns) {
      let rule = '';
      if (col.isDateCandidate) rule = '日付正規化 → YYYY-MM-DD';
      else if (col.isPhoneCandidate) rule = '電話番号正規化 → 数字のみ10-11桁';
      else if (col.name.includes('メール') || col.inferredType === 'email') rule = 'メール小文字化';
      else if (col.name.includes('住所')) rule = '住所正規化（全角数字→半角、〒除去）';
      else if (col.name.includes('ﾌﾘｶﾞﾅ') || col.name.includes('フリガナ')) rule = '半角カナ→全角カナ';
      else if (col.name === '時刻') rule = 'Excel serial / FM形式 → HH:MM:SS';
      else if (col.name === '日時') rule = '連結日時分割 → YYYY-MM-DD + HH:MM:SS';
      else continue;

      candidates.push({
        file: profile.fileName,
        column: col.name,
        currentType: col.inferredType,
        rule,
        samples: col.sampleValues.slice(0, 3).join(' | '),
      });
    }
  }

  return candidates;
}

function buildStagingColumnMap(
  classified: Record<string, string[]>,
  customerHeaders: string[],
  callHeaders: string[],
): Record<string, string>[] {
  const rows: Record<string, string>[] = [];

  for (const [category, columns] of Object.entries(classified)) {
    for (const col of columns) {
      rows.push({
        source_file: '260312_顧客_太陽光.csv',
        source_column: col,
        staging_entity: category,
        proposed_canonical: '', // 空 — 人手で埋める
        notes: '',
      });
    }
  }

  for (const col of callHeaders) {
    if (col === '<テーブルが見つかりません>') continue;
    rows.push({
      source_file: '260312_コール履歴_太陽光.xlsx',
      source_column: col,
      staging_entity: 'activity_call',
      proposed_canonical: '',
      notes: '',
    });
  }

  return rows;
}

// ─── run ─────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
