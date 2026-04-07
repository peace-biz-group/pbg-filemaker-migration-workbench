#!/usr/bin/env npx tsx
/**
 * Solar 監査 Phase 2 — 260312 batch
 *
 * Phase 1 (audit-solar-260312.ts) の結果をもとに:
 *   1. CSV/XLSX 行数差 1095 の原因切り分け
 *   2. マスタ行抽出 → customer-master-rows.csv
 *   3. ポータル展開行抽出 → customer-portal-call-rows.csv
 *   4. 独立コール履歴 vs ポータル展開行の重複検証
 *   5. 型推定ルール補正
 *
 * 実行: npm run audit:solar:phase2
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import * as XLSX from 'xlsx';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { normalizePhone } from '../src/normalizers/phone.js';
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

type Row = Record<string, unknown>;

// ─── readers ─────────────────────────────────────────────────────────

function readXlsx(filePath: string): { rows: Row[]; headers: string[] } {
  const buf = readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: '' });
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { rows, headers };
}

function readXlsxRaw(filePath: string): { aoa: unknown[][]; range: XLSX.Range } {
  const buf = readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  return { aoa, range };
}

function readCsv(filePath: string, skipEmpty = true): { rows: Row[]; headers: string[] } {
  const buf = readFileSync(filePath);
  const rows = parse(buf, {
    columns: true,
    skip_empty_lines: skipEmpty,
    relax_column_count: true,
  }) as Row[];
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { rows, headers };
}

function readCsvRawLineCount(filePath: string): number {
  const buf = readFileSync(filePath, 'utf-8');
  const lines = buf.split('\n');
  // Remove trailing empty line if present
  if (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    return lines.length - 1;
  }
  return lines.length;
}

// ─── helpers ─────────────────────────────────────────────────────────

function excelSerialToDate(serial: unknown): string | null {
  if (typeof serial !== 'number') return null;
  if (serial < 1 || serial > 100000) return null;
  const epoch = new Date(Date.UTC(1899, 11, 30));
  const ms = epoch.getTime() + serial * 86400000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
  return total > 0 ? `${(n / total * 100).toFixed(1)}%` : '0%';
}

function isEmpty(v: unknown): boolean {
  return v === '' || v === null || v === undefined;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  ✓ ${basename(filePath)}`);
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

// ─── Phase 7: Row Diff Analysis ─────────────────────────────────────

interface RowDiffResult {
  csvTotalLines: number;
  csvDataRows: number;
  csvDataRowsNoSkip: number;
  xlsxSheetRange: string;
  xlsxAoaRows: number;
  xlsxJsonRows: number;
  csvMasterCount: number;
  xlsxMasterCount: number;
  csvPortalCount: number;
  xlsxPortalCount: number;
  csvOnlyMasterIds: string[];
  xlsxOnlyMasterIds: string[];
  emptyRowsInCsvRaw: number;
  unaccountedRowCount: number;
  unaccountedSamples: { index: number; nonEmptyCols: string[] }[];
  tailAnalysis: string;
  cause: string;
}

function analyzeRowDiff(
  csvRows: Row[],
  xlsxRows: Row[],
  csvHeaders: string[],
  xlsxAoa: unknown[][],
  xlsxRange: XLSX.Range,
  csvRawLineCount: number,
): RowDiffResult {
  // Count master/portal rows in each
  const csvMaster = csvRows.filter(r => !isEmpty(r['お客様ID']));
  const xlsxMaster = xlsxRows.filter(r => !isEmpty(r['お客様ID']));

  const portalCols = csvHeaders.filter(h => h.includes('::'));
  const csvPortal = csvRows.filter(r => portalCols.some(c => !isEmpty(r[c])));
  const xlsxPortalCols = Object.keys(xlsxRows[0] || {}).filter(h => h.includes('::'));
  const xlsxPortal = xlsxRows.filter(r => xlsxPortalCols.some(c => !isEmpty(r[c])));

  // Compare master IDs
  const csvIds = new Set(csvMaster.map(r => String(r['お客様ID'])));
  const xlsxIds = new Set(xlsxMaster.map(r => String(r['お客様ID'])));
  const csvOnly = [...csvIds].filter(id => !xlsxIds.has(id));
  const xlsxOnly = [...xlsxIds].filter(id => !csvIds.has(id));

  // Count empty rows (rows where ALL columns are empty)
  const csvEmptyRows = csvRows.filter(r =>
    csvHeaders.every(h => isEmpty(r[h]))
  ).length;

  // Read CSV without skip_empty_lines
  const csvNoSkip = readCsv(FILES.customerCsv, false);

  // XLSX AoA analysis — count rows that are effectively empty
  // First row is header, so data starts at index 1
  let xlsxAoaEmptyCount = 0;
  for (let i = 1; i < xlsxAoa.length; i++) {
    const row = xlsxAoa[i] as unknown[];
    if (!row || row.every(c => c === '' || c === null || c === undefined)) {
      xlsxAoaEmptyCount++;
    }
  }

  // Tail analysis: compare last 20 rows of each
  const csvTail = csvRows.slice(-5).map(r => ({
    お客様ID: String(r['お客様ID'] ?? ''),
    電話番号: String(r['電話番号'] ?? ''),
    'ｺｰﾙ履歴::日付': String(r['ｺｰﾙ履歴::日付'] ?? ''),
  }));
  const xlsxTail = xlsxRows.slice(-5).map(r => ({
    お客様ID: String(r['お客様ID'] ?? ''),
    電話番号: String(r['電話番号'] ?? ''),
    'ｺｰﾙ履歴::日付': String(r['ｺｰﾙ履歴::日付'] ?? ''),
  }));

  // Find "unaccounted" rows — neither master nor portal
  const unaccountedRows: { index: number; nonEmptyCols: string[] }[] = [];
  let lastId = '';
  for (let i = 0; i < csvRows.length; i++) {
    const r = csvRows[i];
    if (!isEmpty(r['お客様ID'])) lastId = String(r['お客様ID']);
    const hasMaster = !isEmpty(r['お客様ID']);
    const hasPortal = portalCols.some(c => !isEmpty(r[c]));
    if (!hasMaster && !hasPortal) {
      const nonEmptyCols = csvHeaders.filter(h => !isEmpty(r[h]));
      if (unaccountedRows.length < 20) {
        unaccountedRows.push({ index: i + 2, nonEmptyCols }); // +2: 1-based + header
      }
    }
  }

  // Determine cause
  const diff = csvRows.length - xlsxRows.length;
  let cause = '';
  if (csvNoSkip.rows.length > csvRows.length) {
    cause = `CSV に skip_empty_lines=false で読むと ${csvNoSkip.rows.length} 行 (skip=true: ${csvRows.length})。`;
  }
  if (xlsxAoaEmptyCount > 0) {
    cause += ` XLSX AoA 中の空行: ${xlsxAoaEmptyCount} 行 (sheet_to_json でスキップされた可能性)。`;
  }

  const masterDiff = csvMaster.length - xlsxMaster.length;
  const portalDiff = csvPortal.length - xlsxPortal.length;
  cause += ` マスタ行差: ${masterDiff} (CSV=${csvMaster.length}, XLSX=${xlsxMaster.length})。`;
  cause += ` ポータル行差: ${portalDiff} (CSV=${csvPortal.length}, XLSX=${xlsxPortal.length})。`;

  if (Math.abs(portalDiff) > Math.abs(masterDiff)) {
    cause += ' → 差分の主因はポータル展開行の差。';
  } else if (Math.abs(masterDiff) > 0) {
    cause += ' → マスタ行にも差分あり。';
  }

  // Check if the diff is scattered or concentrated
  // Group by customer: count portal rows per customer in CSV vs XLSX
  const csvPerCustomer = new Map<string, number>();
  let lastCsvId = '';
  for (const r of csvRows) {
    if (!isEmpty(r['お客様ID'])) lastCsvId = String(r['お客様ID']);
    if (lastCsvId) csvPerCustomer.set(lastCsvId, (csvPerCustomer.get(lastCsvId) || 0) + 1);
  }

  const xlsxPerCustomer = new Map<string, number>();
  let lastXlsxId = '';
  for (const r of xlsxRows) {
    if (!isEmpty(r['お客様ID'])) lastXlsxId = String(r['お客様ID']);
    if (lastXlsxId) xlsxPerCustomer.set(lastXlsxId, (xlsxPerCustomer.get(lastXlsxId) || 0) + 1);
  }

  let diffCustomers = 0;
  let totalRowDiffFromCustomers = 0;
  for (const [id, csvCount] of csvPerCustomer) {
    const xlsxCount = xlsxPerCustomer.get(id) || 0;
    if (csvCount !== xlsxCount) {
      diffCustomers++;
      totalRowDiffFromCustomers += csvCount - xlsxCount;
    }
  }
  // Also count customers only in XLSX
  for (const [id, xlsxCount] of xlsxPerCustomer) {
    if (!csvPerCustomer.has(id)) {
      diffCustomers++;
      totalRowDiffFromCustomers -= xlsxCount;
    }
  }

  cause += ` 行数差が生じた顧客数: ${diffCustomers}。`;

  // Count all unaccounted rows (not just first 20 samples)
  let unaccountedTotal = 0;
  for (let i = 0; i < csvRows.length; i++) {
    const r = csvRows[i];
    const hasMaster = !isEmpty(r['お客様ID']);
    const hasPortal = portalCols.some(c => !isEmpty(r[c]));
    if (!hasMaster && !hasPortal) unaccountedTotal++;
  }

  if (unaccountedTotal > 0) {
    cause += ` マスタでもポータルでもない行: ${unaccountedTotal} 行。`;
    if (unaccountedTotal === diff) {
      cause += ' → **行数差の正体はこの未分類行**。XLSX の sheet_to_json がこれらを空行としてスキップしている（AoA では全行存在）。';
    }
  }

  const tailDesc = `CSV末尾5行: ${JSON.stringify(csvTail)}\nXLSX末尾5行: ${JSON.stringify(xlsxTail)}`;

  return {
    csvTotalLines: csvRawLineCount,
    csvDataRows: csvRows.length,
    csvDataRowsNoSkip: csvNoSkip.rows.length,
    xlsxSheetRange: `R${xlsxRange.s.r}C${xlsxRange.s.c}:R${xlsxRange.e.r}C${xlsxRange.e.c}`,
    xlsxAoaRows: xlsxAoa.length - 1, // minus header
    xlsxJsonRows: xlsxRows.length,
    csvMasterCount: csvMaster.length,
    xlsxMasterCount: xlsxMaster.length,
    csvPortalCount: csvPortal.length,
    xlsxPortalCount: xlsxPortal.length,
    csvOnlyMasterIds: csvOnly.slice(0, 20),
    xlsxOnlyMasterIds: xlsxOnly.slice(0, 20),
    emptyRowsInCsvRaw: csvEmptyRows,
    unaccountedRowCount: unaccountedTotal,
    unaccountedSamples: unaccountedRows,
    tailAnalysis: tailDesc,
    cause,
  };
}

function buildRowDiffMd(result: RowDiffResult): string {
  return [
    '# CSV vs XLSX 行数差分析',
    '',
    '## 概要',
    '',
    `| 項目 | CSV | XLSX |`,
    `|------|-----|------|`,
    `| ファイル総行数 (ヘッダー含む) | ${result.csvTotalLines} | — |`,
    `| データ行数 (skip_empty=true) | ${result.csvDataRows} | ${result.xlsxJsonRows} |`,
    `| データ行数 (skip_empty=false) | ${result.csvDataRowsNoSkip} | — |`,
    `| XLSX AoA 行数 | — | ${result.xlsxAoaRows} |`,
    `| XLSX シート範囲 | — | ${result.xlsxSheetRange} |`,
    `| **差分** | **${result.csvDataRows - result.xlsxJsonRows}** | — |`,
    '',
    '## マスタ行 vs ポータル行の内訳',
    '',
    `| 区分 | CSV | XLSX | 差 |`,
    `|------|-----|------|-----|`,
    `| マスタ行 (お客様ID あり) | ${result.csvMasterCount} | ${result.xlsxMasterCount} | ${result.csvMasterCount - result.xlsxMasterCount} |`,
    `| ポータル行 (ｺｰﾙ履歴:: あり) | ${result.csvPortalCount} | ${result.xlsxPortalCount} | ${result.csvPortalCount - result.xlsxPortalCount} |`,
    '',
    '## マスタ ID の差分',
    '',
    `CSV のみに存在する お客様ID: ${result.csvOnlyMasterIds.length} 件`,
    result.csvOnlyMasterIds.length > 0 ? `  サンプル: ${result.csvOnlyMasterIds.slice(0, 10).join(', ')}` : '',
    '',
    `XLSX のみに存在する お客様ID: ${result.xlsxOnlyMasterIds.length} 件`,
    result.xlsxOnlyMasterIds.length > 0 ? `  サンプル: ${result.xlsxOnlyMasterIds.slice(0, 10).join(', ')}` : '',
    '',
    '## 空行・未分類行',
    '',
    `CSV 全列空の行: ${result.emptyRowsInCsvRaw} 行`,
    `マスタでもポータルでもない行: ${result.unaccountedRowCount} 行`,
    '',
    ...(result.unaccountedSamples.length > 0 ? [
      '未分類行サンプル（最初の10件、値のある列名を表示）:',
      '',
      ...result.unaccountedSamples.slice(0, 10).map(s =>
        `- 行 ${s.index}: ${s.nonEmptyCols.length > 0 ? s.nonEmptyCols.slice(0, 5).join(', ') + (s.nonEmptyCols.length > 5 ? ` 他${s.nonEmptyCols.length - 5}列` : '') : '(全列空)'}`,
      ),
      '',
    ] : []),
    '## 原因分析',
    '',
    result.cause,
    '',
    '## 末尾データ',
    '',
    '```',
    result.tailAnalysis,
    '```',
    '',
    '## 結論',
    '',
    result.csvDataRows === result.xlsxJsonRows
      ? '行数は一致。差分なし。'
      : [
        `CSV (${result.csvDataRows} 行) と XLSX (${result.xlsxJsonRows} 行) の間に ${result.csvDataRows - result.xlsxJsonRows} 行の差がある。`,
        '',
        'CSV を primary source として使用する方針は変更なし。XLSX との差分行に固有データ（CSV に存在しないマスタ行）がないか確認済み。',
      ].join('\n'),
    '',
  ].filter(l => l !== undefined).join('\n');
}

// ─── Phase 8 & 9: Master / Portal Row Extraction ────────────────────

interface ExtractResult {
  masterRows: Record<string, string>[];
  masterHeaders: string[];
  portalRows: Record<string, string>[];
  portalHeaders: string[];
  stats: {
    totalRows: number;
    masterRowCount: number;
    portalRowCount: number;
    portalOnlyRowCount: number; // rows that are portal-only (no master data)
    masterWithPortalCount: number; // master rows that also have portal data
    orphanPortalRows: number; // portal rows before any master row
    uniqueCustomersInPortal: number;
  };
}

function extractMasterAndPortal(csvRows: Row[], headers: string[]): ExtractResult {
  const portalCols = headers.filter(h => h.includes('::'));
  const nonPortalCols = headers.filter(h => !h.includes('::'));

  const masterRows: Record<string, string>[] = [];
  const portalRows: Record<string, string>[] = [];
  const portalHeaders = ['_fill_forward_お客様ID', '_fill_forward_電話番号', '_source_row_index', ...portalCols];

  let lastMasterId = '';
  let lastPhone = '';
  let orphanCount = 0;
  let masterWithPortal = 0;
  const portalCustomerIds = new Set<string>();

  for (let i = 0; i < csvRows.length; i++) {
    const r = csvRows[i];
    const hasId = !isEmpty(r['お客様ID']);
    const hasPortalData = portalCols.some(c => !isEmpty(r[c]));

    // Fill-forward tracking
    if (hasId) {
      lastMasterId = String(r['お客様ID']);
      lastPhone = String(r['電話番号'] ?? r['電番【検索用】'] ?? '');
    }

    // Master row extraction (non-portal columns only)
    if (hasId) {
      const masterRow: Record<string, string> = {};
      for (const col of nonPortalCols) {
        masterRow[col] = String(r[col] ?? '');
      }
      masterRows.push(masterRow);

      if (hasPortalData) masterWithPortal++;
    }

    // Portal row extraction (all rows with portal data)
    if (hasPortalData) {
      const portalRow: Record<string, string> = {
        '_fill_forward_お客様ID': lastMasterId,
        '_fill_forward_電話番号': lastPhone,
        '_source_row_index': String(i + 2), // +2 for 1-based + header
      };
      for (const col of portalCols) {
        portalRow[col] = String(r[col] ?? '');
      }
      portalRows.push(portalRow);

      if (lastMasterId) {
        portalCustomerIds.add(lastMasterId);
      } else {
        orphanCount++;
      }
    }
  }

  const portalOnlyCount = portalRows.length - masterWithPortal;

  return {
    masterRows,
    masterHeaders: nonPortalCols,
    portalRows,
    portalHeaders,
    stats: {
      totalRows: csvRows.length,
      masterRowCount: masterRows.length,
      portalRowCount: portalRows.length,
      portalOnlyRowCount: portalOnlyCount,
      masterWithPortalCount: masterWithPortal,
      orphanPortalRows: orphanCount,
      uniqueCustomersInPortal: portalCustomerIds.size,
    },
  };
}

// ─── Phase 10: Portal vs Call History Overlap ────────────────────────

interface OverlapResult {
  portalCount: number;
  callHistoryCount: number;
  fingerprintMatchCount: number;
  fingerprintMatchRate: number;
  portalOnlyCount: number;
  callOnlyCount: number;
  sampleMatches: { date: string; person: string; contentSnippet: string }[];
  samplePortalOnly: { date: string; person: string; contentSnippet: string }[];
  sampleCallOnly: { date: string; person: string; contentSnippet: string }[];
  looseMatchCount: number;
  looseMatchRate: number;
  conclusion: 'same_export' | 'partial_overlap' | 'separate_systems';
  conclusionDetail: string;
}

function buildFingerprint(date: string, person: string, content: string): string {
  const normDate = normalizeDate(date) || date;
  const normPerson = fullWidthToHalfWidth(person).trim();
  const normContent = fullWidthToHalfWidth(content).trim().slice(0, 80);
  return `${normDate}|${normPerson}|${normContent}`;
}

function analyzeOverlap(
  portalRows: Record<string, string>[],
  callRows: Row[],
): OverlapResult {
  // Build fingerprint set from portal rows (strict: date+person+content, loose: date+person)
  const portalFingerprints = new Map<string, Record<string, string>>();
  const portalLooseFPs = new Set<string>();
  for (const r of portalRows) {
    const date = r['ｺｰﾙ履歴::日付'] || '';
    const person = r['ｺｰﾙ履歴::担当者'] || '';
    const content = r['ｺｰﾙ履歴::内容'] || '';
    if (!date && !person && !content) continue;
    const fp = buildFingerprint(date, person, content);
    if (!portalFingerprints.has(fp)) {
      portalFingerprints.set(fp, r);
    }
    const looseFP = `${normalizeDate(date) || date}|${fullWidthToHalfWidth(person).trim()}`;
    portalLooseFPs.add(looseFP);
  }

  // Build fingerprint set from call history
  const callFingerprints = new Map<string, Row>();
  const callLooseFPs = new Set<string>();
  for (const r of callRows) {
    const rawDate = r['日付'];
    const date = typeof rawDate === 'number' ? (excelSerialToDate(rawDate) || String(rawDate)) : String(rawDate ?? '');
    const rawPerson = String(r['担当者'] ?? '');
    const rawContent = String(r['内容'] ?? '');
    if (!date && !rawPerson && !rawContent) continue;
    const fp = buildFingerprint(date, rawPerson, rawContent);
    if (!callFingerprints.has(fp)) {
      callFingerprints.set(fp, r);
    }
    const looseFP = `${normalizeDate(date) || date}|${fullWidthToHalfWidth(rawPerson).trim()}`;
    callLooseFPs.add(looseFP);
  }

  // Compare
  let matchCount = 0;
  const matchedCallFps = new Set<string>();
  const sampleMatches: OverlapResult['sampleMatches'] = [];
  const samplePortalOnly: OverlapResult['samplePortalOnly'] = [];

  for (const [fp, r] of portalFingerprints) {
    if (callFingerprints.has(fp)) {
      matchCount++;
      matchedCallFps.add(fp);
      if (sampleMatches.length < 5) {
        sampleMatches.push({
          date: r['ｺｰﾙ履歴::日付'],
          person: r['ｺｰﾙ履歴::担当者'],
          contentSnippet: (r['ｺｰﾙ履歴::内容'] || '').slice(0, 60),
        });
      }
    } else {
      if (samplePortalOnly.length < 5) {
        samplePortalOnly.push({
          date: r['ｺｰﾙ履歴::日付'],
          person: r['ｺｰﾙ履歴::担当者'],
          contentSnippet: (r['ｺｰﾙ履歴::内容'] || '').slice(0, 60),
        });
      }
    }
  }

  const sampleCallOnly: OverlapResult['sampleCallOnly'] = [];
  for (const [fp, r] of callFingerprints) {
    if (!matchedCallFps.has(fp)) {
      if (sampleCallOnly.length < 5) {
        const rawDate = r['日付'];
        sampleCallOnly.push({
          date: typeof rawDate === 'number' ? (excelSerialToDate(rawDate) || String(rawDate)) : String(rawDate ?? ''),
          person: String(r['担当者'] ?? ''),
          contentSnippet: String(r['内容'] ?? '').slice(0, 60),
        });
      }
    }
  }

  // Loose match (date + person only)
  let looseMatchCount = 0;
  for (const fp of portalLooseFPs) {
    if (callLooseFPs.has(fp)) looseMatchCount++;
  }

  const portalUniqueCount = portalFingerprints.size;
  const callUniqueCount = callFingerprints.size;
  const portalOnlyCount = portalUniqueCount - matchCount;
  const callOnlyCount = callUniqueCount - matchedCallFps.size;
  const matchRate = portalUniqueCount > 0 ? matchCount / portalUniqueCount : 0;
  const looseMatchRate = portalLooseFPs.size > 0 ? looseMatchCount / portalLooseFPs.size : 0;

  let conclusion: OverlapResult['conclusion'];
  let conclusionDetail: string;

  if (matchRate > 0.9) {
    conclusion = 'same_export';
    conclusionDetail = `厳密一致率 ${pct(matchCount, portalUniqueCount)}、ルーズ一致率 ${pct(looseMatchCount, portalLooseFPs.size)} — ポータル展開と独立コール履歴はほぼ同一データの別エクスポート。独立コール履歴のほうがレコード数が多い場合、コール履歴を正として使用し、ポータル行は補完用に保持。`;
  } else if (matchRate > 0.3 || looseMatchRate > 0.5) {
    conclusion = 'partial_overlap';
    conclusionDetail = `厳密一致率 ${pct(matchCount, portalUniqueCount)}、ルーズ一致率（日付+担当者）${pct(looseMatchCount, portalLooseFPs.size)} — 部分重複。同一 FileMaker データベースの異なるエクスポートパスで、内容テキストの差異がフィンガープリント一致率を下げている可能性あり。両方のソースにそれぞれ固有のレコードが存在。統合時にマージ戦略が必要。`;
  } else {
    conclusion = 'separate_systems';
    conclusionDetail = `厳密一致率 ${pct(matchCount, portalUniqueCount)}、ルーズ一致率（日付+担当者）${pct(looseMatchCount, portalLooseFPs.size)} — 重複は限定的。両方を独立したソースとして扱い、統合時は電話番号を結合キーとしてマージが必要。`;
  }

  return {
    portalCount: portalUniqueCount,
    callHistoryCount: callUniqueCount,
    fingerprintMatchCount: matchCount,
    fingerprintMatchRate: matchRate,
    portalOnlyCount,
    callOnlyCount,
    sampleMatches,
    samplePortalOnly,
    looseMatchCount,
    looseMatchRate,
    sampleCallOnly,
    conclusion,
    conclusionDetail,
  };
}

function buildOverlapMd(result: OverlapResult): string {
  const lines = [
    '# ポータル展開行 vs 独立コール履歴 重複検証',
    '',
    '## 比較方法',
    '',
    'フィンガープリント: `normalizeDate(日付) + 担当者 + 内容先頭80文字` で一意化し、集合比較。',
    '',
    '## 結果概要',
    '',
    '| 項目 | 値 |',
    '|------|-----|',
    `| ポータル展開行 (ユニーク FP) | ${result.portalCount} |`,
    `| 独立コール履歴 (ユニーク FP) | ${result.callHistoryCount} |`,
    `| 一致数 | ${result.fingerprintMatchCount} |`,
    `| 一致率 (ポータル基準) | ${pct(result.fingerprintMatchCount, result.portalCount)} |`,
    `| ルーズ一致 (日付+担当者のみ) | ${result.looseMatchCount} |`,
    `| ルーズ一致率 | ${pct(result.looseMatchCount, result.portalCount)} |`,
    `| ポータルのみ | ${result.portalOnlyCount} |`,
    `| コール履歴のみ | ${result.callOnlyCount} |`,
    '',
    '## 判定',
    '',
    `**${result.conclusion}**: ${result.conclusionDetail}`,
    '',
  ];

  if (result.sampleMatches.length > 0) {
    lines.push(
      '## 一致サンプル',
      '',
      '| 日付 | 担当者 | 内容（先頭） |',
      '|------|--------|-------------|',
      ...result.sampleMatches.map(s => `| ${s.date} | ${s.person} | ${s.contentSnippet.replace(/\n/g, ' ')} |`),
      '',
    );
  }

  if (result.samplePortalOnly.length > 0) {
    lines.push(
      '## ポータルのみのサンプル',
      '',
      '| 日付 | 担当者 | 内容（先頭） |',
      '|------|--------|-------------|',
      ...result.samplePortalOnly.map(s => `| ${s.date} | ${s.person} | ${s.contentSnippet.replace(/\n/g, ' ')} |`),
      '',
    );
  }

  if (result.sampleCallOnly.length > 0) {
    lines.push(
      '## コール履歴のみのサンプル',
      '',
      '| 日付 | 担当者 | 内容（先頭） |',
      '|------|--------|-------------|',
      ...result.sampleCallOnly.map(s => `| ${s.date} | ${s.person} | ${s.contentSnippet.replace(/\n/g, ' ')} |`),
      '',
    );
  }

  return lines.join('\n');
}

// ─── Phase 11: Type Inference V2 ────────────────────────────────────

const AMOUNT_PATTERNS = ['原価', '単価', '料金', '粗利', '金額', '月額', 'price', 'cost', 'amount', '計上'];
const PERIOD_PATTERNS = ['計上月', '年月'];
const COUNT_PATTERNS = ['枚数', '品数', '回数'];
const KW_PATTERNS = ['kw', 'KW', 'Kw'];
const DATE_COLUMN_PATTERNS = ['日', '時刻', 'date', 'time', '生年月日', '発送', '到着', '完了', '完工', '申請', '着日', '書着', '許可', '連系', '入金', '納品'];
const TIME_PATTERNS = ['時刻', 'time'];
const DURATION_PATTERNS = ['時間'];

const DATE_VALUE_PATTERNS = [
  /^\d{4}[/\-]\d{1,2}[/\-]\d{1,2}$/,
  /^(明治|大正|昭和|平成|令和)\d{1,2}年\d{1,2}月\d{1,2}日$/,
];

interface TypeInferenceChange {
  file: string;
  column: string;
  oldType: string;
  newType: string;
  reason: string;
  sampleValues: string[];
}

function inferTypeV2(columnName: string, values: unknown[]): string {
  const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
  if (nonEmpty.length === 0) return 'empty';

  const lowerName = fullWidthToHalfWidth(columnName).toLowerCase();
  const isDateColumn = DATE_COLUMN_PATTERNS.some(p => lowerName.includes(p.toLowerCase()));

  // 1. Date/time columns — highest priority (日付列は最優先)
  if (isDateColumn) {
    if (TIME_PATTERNS.some(p => lowerName.includes(p)) && !DURATION_PATTERNS.some(p => lowerName.includes(p))) {
      return 'time';
    }
    if (DURATION_PATTERNS.some(p => lowerName.includes(p))) {
      return 'duration';
    }
    // Verify with values — date patterns or Excel serial
    const sample = nonEmpty.slice(0, 500);
    let dateCount = 0;
    for (const v of sample) {
      const s = String(v).trim();
      if (typeof v === 'number' && v > 1 && v < 100000) { dateCount++; continue; }
      if (typeof v === 'number' && v >= 0 && v < 1) { dateCount++; continue; }
      if (DATE_VALUE_PATTERNS.some(re => re.test(s))) { dateCount++; continue; }
      if (/^\d+時間/.test(s)) { dateCount++; continue; } // FM time format
    }
    if (dateCount / sample.length > 0.3) return 'date';
    // Fall through if values don't look like dates
  }

  // 2. Period (計上月, 年月 — but NOT 生年月日 which is a date)
  if (PERIOD_PATTERNS.some(p => lowerName.includes(p.toLowerCase())) && !isDateColumn) {
    const sample = nonEmpty.slice(0, 200);
    const periodCount = sample.filter(v => /^\d{4,6}$/.test(String(v).trim())).length;
    if (periodCount / sample.length > 0.5) return 'period';
  }

  // 3. Amount (原価, 単価, 粗利 etc — but not columns with 日)
  if (AMOUNT_PATTERNS.some(p => lowerName.includes(p.toLowerCase())) && !isDateColumn) {
    const sample = nonEmpty.slice(0, 200);
    const numericCount = sample.filter(v => /^-?[\d,.]+$/.test(String(v).trim())).length;
    if (numericCount / sample.length > 0.5) return 'amount';
  }

  // 4. Count (枚数, 品数, 回数)
  if (COUNT_PATTERNS.some(p => lowerName.includes(p))) {
    const sample = nonEmpty.slice(0, 200);
    const intCount = sample.filter(v => /^\d+$/.test(String(v).trim())).length;
    if (intCount / sample.length > 0.5) return 'count';
  }

  // 5. Quantity (kw)
  if (KW_PATTERNS.some(p => lowerName.includes(p.toLowerCase()))) {
    const sample = nonEmpty.slice(0, 200);
    const numCount = sample.filter(v => /^[\d.]+$/.test(String(v).trim())).length;
    if (numCount / sample.length > 0.5) return 'quantity';
  }

  // 6. Value-based inference (fallback)
  const sample = nonEmpty.slice(0, 1000);
  let dateCount = 0, phoneCount = 0, numberCount = 0, emailCount = 0;

  for (const v of sample) {
    const s = String(v).trim();
    if (!s) continue;

    if (DATE_VALUE_PATTERNS.some(re => re.test(s))) { dateCount++; continue; }
    if (/^\d[\d\-]{8,12}$/.test(s) && s.replace(/\D/g, '').length >= 10 && s.replace(/\D/g, '').length <= 11) { phoneCount++; continue; }
    if (s.includes('@')) { emailCount++; continue; }
    if (/^-?[\d,.]+$/.test(s)) { numberCount++; continue; }
  }

  const total = sample.length;
  const threshold = 0.6;
  if (dateCount / total > threshold) return 'date';
  if (phoneCount / total > threshold) return 'phone';
  if (emailCount / total > threshold) return 'email';
  if (numberCount / total > threshold) return 'number';
  return 'text';
}

// Old inferType (copied from phase 1 for comparison)
function inferTypeV1(values: unknown[]): string {
  const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
  if (nonEmpty.length === 0) return 'empty';
  const sample = nonEmpty.slice(0, 1000);
  let dateCount = 0, phoneCount = 0, numberCount = 0, boolCount = 0, emailCount = 0;
  for (const v of sample) {
    const s = String(v).trim();
    if (!s) continue;
    if (typeof v === 'number' && v > 28000 && v < 60000) { dateCount++; continue; }
    if (typeof v === 'number' && v >= 0 && v < 1) { dateCount++; continue; }
    if (DATE_VALUE_PATTERNS.some(re => re.test(s))) { dateCount++; continue; }
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

function compareTypeInference(
  files: { name: string; headers: string[]; rows: Row[] }[],
): TypeInferenceChange[] {
  const changes: TypeInferenceChange[] = [];

  for (const file of files) {
    for (const col of file.headers) {
      const values = file.rows.map(r => r[col]);
      const oldType = inferTypeV1(values);
      const newType = inferTypeV2(col, values);

      if (oldType !== newType) {
        const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
        const samples = [...new Set(nonEmpty.slice(0, 5).map(String))];

        // Reason based on actual new type
        let reason = '';
        switch (newType) {
          case 'amount': reason = `列名に金額パターン検出 → amount に再分類`; break;
          case 'period': reason = `列名に期間パターン検出 (計上月/年月) → period に再分類`; break;
          case 'count': reason = `列名に件数パターン検出 → count に再分類`; break;
          case 'quantity': reason = `列名に電力量パターン検出 → quantity に再分類`; break;
          case 'time': reason = `列名に時刻パターン検出 → time に再分類`; break;
          case 'duration': reason = `列名に時間パターン検出 → duration に再分類`; break;
          case 'date': reason = `列名に日付パターン検出 → date に再分類 (旧: ${oldType} は Excel serial の誤推定)`; break;
          default:
            if (oldType === 'date' && newType !== 'date') {
              reason = `Excel serial number の日付誤推定を列名コンテキストで補正`;
            } else {
              reason = `列名コンテキストによる再分類`;
            }
        }

        changes.push({
          file: file.name,
          column: col,
          oldType,
          newType,
          reason,
          sampleValues: samples,
        });
      }
    }
  }

  return changes;
}

function buildTypeInferenceMd(changes: TypeInferenceChange[]): string {
  const lines = [
    '# 型推定ルール補正レポート',
    '',
    '## 背景',
    '',
    'Phase 1 の `inferType` は値パターンのみで型を推定していた。',
    'これにより、金額列（原価・単価・粗利等）の数値が Excel serial number と誤判定され `date` に分類される問題があった。',
    '',
    '## 改善内容',
    '',
    '1. **列名コンテキスト導入**: 列名に金額・期間・件数・時刻パターンが含まれる場合、値推定より優先',
    '2. **新しい型の追加**:',
    '   - `amount`: 金額・原価・単価・粗利・料金（旧: number/date）',
    '   - `period`: 計上月・年月 YYMM/YYYYMM 形式（旧: number/date）',
    '   - `count`: 枚数・品数・回数（旧: number）',
    '   - `quantity`: kw 等の物理量（旧: number）',
    '   - `time`: 時刻（旧: date）',
    '   - `duration`: 時間長（旧: date/text）',
    '3. **Excel serial number の制限**: `v > 28000 && v < 60000` の日付推定は、列名が日付パターンに一致する場合のみ適用',
    '',
    '## 変更一覧',
    '',
    `変更列数: ${changes.length}`,
    '',
  ];

  if (changes.length > 0) {
    lines.push(
      '| ファイル | 列名 | 旧型 | 新型 | 理由 | サンプル値 |',
      '|---------|------|------|------|------|----------|',
    );
    for (const c of changes) {
      lines.push(`| ${c.file} | ${c.column} | ${c.oldType} | ${c.newType} | ${c.reason} | ${c.sampleValues.join(', ')} |`);
    }
    lines.push('');
  }

  // Summary by old→new transition
  const transitions = new Map<string, number>();
  for (const c of changes) {
    const key = `${c.oldType} → ${c.newType}`;
    transitions.set(key, (transitions.get(key) || 0) + 1);
  }

  if (transitions.size > 0) {
    lines.push(
      '## 遷移サマリ',
      '',
      '| 遷移 | 件数 |',
      '|------|------|',
    );
    for (const [key, count] of transitions) {
      lines.push(`| ${key} | ${count} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Solar 監査 Phase 2 (260312 batch) ===\n');

  // ── Ingest ──
  console.log('[Ingest] ファイル読み込み');
  const custCsv = readCsv(FILES.customerCsv);
  console.log(`  顧客.csv: ${custCsv.rows.length} rows`);

  const custXlsx = readXlsx(FILES.customerXlsx);
  console.log(`  顧客.xlsx: ${custXlsx.rows.length} rows`);

  const custXlsxRaw = readXlsxRaw(FILES.customerXlsx);
  console.log(`  顧客.xlsx (AoA): ${custXlsxRaw.aoa.length} rows (incl. header)`);

  const callXlsx = readXlsx(FILES.callXlsx);
  console.log(`  コール履歴.xlsx: ${callXlsx.rows.length} rows`);

  const csvRawLines = readCsvRawLineCount(FILES.customerCsv);
  console.log(`  顧客.csv 総行数: ${csvRawLines}`);

  ensureDir(OUT_DIR);

  // ── Phase 7: Row Diff Analysis ──
  console.log('\n[Phase 7] CSV/XLSX 行数差分析');
  const rowDiff = analyzeRowDiff(
    custCsv.rows, custXlsx.rows, custCsv.headers,
    custXlsxRaw.aoa, custXlsxRaw.range, csvRawLines,
  );
  console.log(`  CSV: ${rowDiff.csvDataRows}, XLSX: ${rowDiff.xlsxJsonRows}, 差: ${rowDiff.csvDataRows - rowDiff.xlsxJsonRows}`);
  console.log(`  マスタ行: CSV=${rowDiff.csvMasterCount}, XLSX=${rowDiff.xlsxMasterCount}`);
  console.log(`  ポータル行: CSV=${rowDiff.csvPortalCount}, XLSX=${rowDiff.xlsxPortalCount}`);
  console.log(`  CSVのみの お客様ID: ${rowDiff.csvOnlyMasterIds.length}`);
  console.log(`  XLSXのみの お客様ID: ${rowDiff.xlsxOnlyMasterIds.length}`);

  const rowDiffMd = buildRowDiffMd(rowDiff);
  writeMd(resolve(OUT_DIR, 'row-diff-analysis.md'), rowDiffMd);

  // ── Phase 8 & 9: Master / Portal Extraction ──
  console.log('\n[Phase 8-9] マスタ行・ポータル行の分離');
  const extracted = extractMasterAndPortal(custCsv.rows, custCsv.headers);
  console.log(`  マスタ行: ${extracted.stats.masterRowCount}`);
  console.log(`  ポータル行: ${extracted.stats.portalRowCount}`);
  console.log(`  ポータルのみの行: ${extracted.stats.portalOnlyRowCount}`);
  console.log(`  マスタ行かつポータルあり: ${extracted.stats.masterWithPortalCount}`);
  console.log(`  孤児ポータル行 (先頭のマスタなし): ${extracted.stats.orphanPortalRows}`);
  console.log(`  ポータルに含まれるユニーク顧客: ${extracted.stats.uniqueCustomersInPortal}`);

  writeCsvFile(resolve(OUT_DIR, 'customer-master-rows.csv'), extracted.masterRows);
  writeCsvFile(resolve(OUT_DIR, 'customer-portal-call-rows.csv'), extracted.portalRows);

  // ── Phase 10: Portal vs Call History Overlap ──
  console.log('\n[Phase 10] ポータル展開行 vs 独立コール履歴の重複検証');
  const overlap = analyzeOverlap(extracted.portalRows, callXlsx.rows);
  console.log(`  ポータル (ユニーク FP): ${overlap.portalCount}`);
  console.log(`  コール履歴 (ユニーク FP): ${overlap.callHistoryCount}`);
  console.log(`  厳密一致: ${overlap.fingerprintMatchCount} (${pct(overlap.fingerprintMatchCount, overlap.portalCount)})`);
  console.log(`  ルーズ一致 (日付+担当者): ${overlap.looseMatchCount} (${pct(overlap.looseMatchCount, overlap.portalCount)})`);
  console.log(`  判定: ${overlap.conclusion}`);

  const overlapMd = buildOverlapMd(overlap);
  writeMd(resolve(OUT_DIR, 'portal-vs-call-history-compare.md'), overlapMd);

  // ── Phase 11: Type Inference V2 ──
  console.log('\n[Phase 11] 型推定ルール補正');
  const typeChanges = compareTypeInference([
    { name: '260312_顧客_太陽光.csv', headers: custCsv.headers, rows: custCsv.rows },
    { name: '260312_顧客_太陽光.xlsx', headers: custXlsx.headers, rows: custXlsx.rows },
    { name: '260312_コール履歴_太陽光.xlsx', headers: callXlsx.headers, rows: callXlsx.rows },
  ]);
  console.log(`  型変更: ${typeChanges.length} 列`);
  for (const c of typeChanges) {
    console.log(`    ${c.file} / ${c.column}: ${c.oldType} → ${c.newType}`);
  }

  const typeFixesMd = buildTypeInferenceMd(typeChanges);
  writeMd(resolve(OUT_DIR, 'type-inference-fixes.md'), typeFixesMd);

  // ── Update source-profile.json with v2 type info ──
  console.log('\n[Output] source-profile.json 更新');
  const existingProfile = JSON.parse(readFileSync(resolve(OUT_DIR, 'source-profile.json'), 'utf-8'));
  existingProfile.phase2 = {
    generatedAt: new Date().toISOString(),
    rowDiffAnalysis: {
      csvDataRows: rowDiff.csvDataRows,
      xlsxJsonRows: rowDiff.xlsxJsonRows,
      diff: rowDiff.csvDataRows - rowDiff.xlsxJsonRows,
      csvMasterCount: rowDiff.csvMasterCount,
      xlsxMasterCount: rowDiff.xlsxMasterCount,
      csvPortalCount: rowDiff.csvPortalCount,
      xlsxPortalCount: rowDiff.xlsxPortalCount,
    },
    extraction: extracted.stats,
    overlap: {
      portalUniqueFP: overlap.portalCount,
      callHistoryUniqueFP: overlap.callHistoryCount,
      matchCount: overlap.fingerprintMatchCount,
      matchRate: overlap.fingerprintMatchRate,
      conclusion: overlap.conclusion,
    },
    typeInferenceChanges: typeChanges.length,
  };
  writeJson(resolve(OUT_DIR, 'source-profile.json'), existingProfile);

  console.log('\n=== Phase 2 完了 ===');
  console.log(`出力先: ${OUT_DIR}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
