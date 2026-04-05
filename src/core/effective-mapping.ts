/**
 * Effective Mapping — 列レビュー回答から run 単位の実効 mapping を生成する。
 *
 * - profile の seed 定義は source of truth として残す
 * - 列レビュー結果で run ごとに補正できる構造
 * - profile 本体は変更しない（run-scoped only）
 * - fail-closed: unknown は canonical に昇格させない
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ColumnReviewEntry, ColumnDef } from '../file-profiles/types.js';

// --- Types ---

export interface EffectiveMappingColumn {
  position: number;
  /** 実際の CSV 列ヘッダー名 */
  sourceHeader: string;
  /** 正規化後の内部キー名 */
  canonicalKey: string;
  /** 表示用日本語ラベル */
  label: string;
  /**
   * active  = inUse=yes → mapping に含める
   * unused  = inUse=no  → mapping 対象外
   * pending = inUse=unknown → fail-closed、mapping 対象外
   */
  status: 'active' | 'unused' | 'pending';
  required: 'yes' | 'no' | 'unknown';
}

export interface EffectiveMappingResult {
  runId: string;
  profileId: string;
  generatedAt: string;
  /**
   * 実効 mapping: sourceHeader → canonicalKey
   * inUse=yes の列のみ含む
   */
  mapping: Record<string, string>;
  activeCount: number;
  unusedCount: number;
  pendingCount: number;
  columns: EffectiveMappingColumn[];
}

const SUSPICIOUS_SOURCE_HEADER_PATTERNS: RegExp[] = [
  /^$/,
  /^<.*>$/,
  /テーブルが見つかりません/,
  /見つかりません/,
  /error/i,
];

const CANONICAL_HEADER_HINTS: Array<{ canonicalKeys: string[]; patterns: RegExp[] }> = [
  { canonicalKeys: ['call_datetime', 'appointment_date', 'visit_date'], patterns: [/日時/i, /架電/i, /コール/i, /訪問日/i] },
  { canonicalKeys: ['phone', 'fax'], patterns: [/電話/i, /tel/i, /携帯/i, /fax/i, /連絡先/i] },
  { canonicalKeys: ['email'], patterns: [/mail/i, /メール/i, /e-mail/i] },
  { canonicalKeys: ['company_name', 'store_name'], patterns: [/会社/i, /法人/i, /企業/i, /店舗/i, /店名/i, /販売店/i] },
  { canonicalKeys: ['contact_name', 'customer_name'], patterns: [/担当/i, /氏名/i, /名前/i, /顧客名/i, /お客様担当/i, /訪問担当/i] },
  { canonicalKeys: ['result', 'progress_status'], patterns: [/結果/i, /ステータス/i, /状況/i, /進捗/i, /報告/i] },
  { canonicalKeys: ['notes', 'activity_detail'], patterns: [/内容/i, /備考/i, /メモ/i, /コメント/i, /note/i] },
];

const HEADER_CONFLICT_PATTERNS: Array<{ patterns: RegExp[]; family: string }> = [
  { family: 'date_time', patterns: [/日付/i, /時刻/i, /日時/i, /date/i, /time/i] },
  { family: 'phone', patterns: [/電話/i, /tel/i, /携帯/i, /fax/i] },
  { family: 'company', patterns: [/会社/i, /法人/i, /企業/i, /店舗/i, /店名/i] },
  { family: 'person', patterns: [/担当/i, /氏名/i, /名前/i, /顧客名/i, /お客様担当/i] },
  { family: 'result', patterns: [/結果/i, /ステータス/i, /状況/i, /進捗/i] },
  { family: 'notes', patterns: [/内容/i, /備考/i, /メモ/i, /コメント/i, /note/i] },
];

const CANONICAL_ALLOWED_FAMILIES: Record<string, string[]> = {
  call_datetime: ['date_time'],
  appointment_date: ['date_time'],
  visit_date: ['date_time'],
  contract_date: ['date_time'],
  created_at: ['date_time'],
  updated_at: ['date_time'],
  phone: ['phone'],
  fax: ['phone'],
  email: ['email'],
  company_name: ['company'],
  store_name: ['company'],
  contact_name: ['person'],
  customer_name: ['person'],
  result: ['result'],
  progress_status: ['result'],
  notes: ['notes'],
  activity_detail: ['notes'],
};

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function isSuspiciousSourceHeader(sourceHeader: string): boolean {
  const value = sourceHeader.trim();
  return SUSPICIOUS_SOURCE_HEADER_PATTERNS.some((re) => re.test(value));
}

function matchesHeaderPattern(value: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(value));
}

function headerMatchesProfileColumn(sourceHeader: string, profileCol?: ColumnDef | null): boolean {
  if (!profileCol) return false;
  const normalizedSource = normalizeText(sourceHeader);
  const candidates = [profileCol.label, ...(profileCol.headerHints ?? [])]
    .map((v) => normalizeText(v))
    .filter(Boolean);
  return candidates.includes(normalizedSource);
}

function inferCanonicalFromHints(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  for (const entry of CANONICAL_HEADER_HINTS) {
    if (matchesHeaderPattern(text, entry.patterns)) {
      return entry.canonicalKeys[0] ?? null;
    }
  }
  return null;
}

function detectHeaderFamily(sourceHeader: string): string | null {
  const value = sourceHeader.trim();
  for (const entry of HEADER_CONFLICT_PATTERNS) {
    if (matchesHeaderPattern(value, entry.patterns)) {
      return entry.family;
    }
  }
  if (/mail/i.test(value) || /メール/.test(value)) return 'email';
  return null;
}

function hasExplicitConflict(sourceHeader: string, canonicalKey: string): boolean {
  const family = detectHeaderFamily(sourceHeader);
  if (!family) return false;
  const allowed = CANONICAL_ALLOWED_FAMILIES[canonicalKey];
  if (!allowed) return false;
  return !allowed.includes(family);
}

function deriveSafeCanonicalKey(
  review: ColumnReviewEntry,
  sourceHeader: string,
  profileDef?: ColumnDef[] | null,
): string | null {
  if (isSuspiciousSourceHeader(sourceHeader)) return null;

  const exactProfileCol = profileDef?.find((col) => headerMatchesProfileColumn(sourceHeader, col)) ?? null;
  if (exactProfileCol) return exactProfileCol.key;

  const proposedKey = review.key?.trim() ?? '';
  const meaning = review.meaning?.trim() ?? '';
  const profileColAtPosition = profileDef?.find((col) => col.position === review.position) ?? null;
  const headerFamily = detectHeaderFamily(sourceHeader);

  const inferredFromHeader = inferCanonicalFromHints(sourceHeader);

  if (proposedKey && proposedKey !== sourceHeader && !hasExplicitConflict(sourceHeader, proposedKey)) {
    const inferredFromMeaning = inferCanonicalFromHints(meaning);
    const allowedFamilies = CANONICAL_ALLOWED_FAMILIES[proposedKey] ?? [];
    if (headerFamily && allowedFamilies.includes(headerFamily)) return proposedKey;
    if (inferredFromMeaning === proposedKey) return proposedKey;
    if (headerMatchesProfileColumn(sourceHeader, profileColAtPosition)) return proposedKey;
    if (!headerFamily || allowedFamilies.length === 0) return proposedKey;
  }

  if (inferredFromHeader) return inferredFromHeader;

  return null;
}

export function reconcileColumnReviews(
  reviews: ColumnReviewEntry[],
  options?: {
    actualColumns?: string[];
    profileDef?: ColumnDef[] | null;
  },
): ColumnReviewEntry[] {
  const actualColumns = options?.actualColumns ?? [];
  const profileDef = options?.profileDef ?? null;

  return [...reviews]
    .sort((a, b) => a.position - b.position)
    .map((review) => {
      const sourceHeader = actualColumns[review.position] ?? review.label;
      const safeCanonical = deriveSafeCanonicalKey(review, sourceHeader, profileDef);
      const keepActive = review.inUse === 'yes' && safeCanonical !== null;

      return {
        ...review,
        label: sourceHeader,
        key: safeCanonical ?? sourceHeader,
        inUse: keepActive ? 'yes' : review.inUse === 'no' ? 'no' : 'unknown',
        required: keepActive ? review.required : 'unknown',
      };
    });
}

// --- Core logic ---

/**
 * 列レビュー回答から run 単位の実効 mapping を生成する。
 *
 * known file (profileDef あり):
 *   - profile の ColumnDef がベース (position → key)
 *   - review で意味・inUse・required を補正
 *
 * new file (profileDef なし):
 *   - review.label (CSVヘッダー) → review.key (ユーザー入力 or ヘッダーそのまま) で mapping
 *
 * ルール:
 *   - inUse=yes  → mapping[sourceHeader] = canonicalKey
 *   - inUse=no   → 除外 (status=unused)
 *   - inUse=unknown → 除外 (status=pending, fail-closed)
 */
export function buildEffectiveMapping(
  runId: string,
  profileId: string,
  reviews: ColumnReviewEntry[],
  profileDef?: ColumnDef[] | null,
): EffectiveMappingResult {
  const reconciled = reconcileColumnReviews(reviews, { profileDef });
  const mapping: Record<string, string> = {};
  const columns: EffectiveMappingColumn[] = [];
  const usedCanonicalKeys = new Set<string>();

  for (const review of reconciled) {
    const profileCol = profileDef?.find(c => c.position === review.position) ?? null;

    // sourceHeader: 実際の CSV 列名（review.label に保存されている）
    const sourceHeader = review.label;

    // canonicalKey: profile の key または review.key（ユーザー上書き可）
    // unsafe な fallback を避け、信頼できる場合だけ canonical に昇格させる
    const canonicalKey = review.key || sourceHeader;

    // label: ユーザーが入力した意味 > profile のラベル > ヘッダー名
    const label = review.meaning || profileCol?.label || sourceHeader;

    let status: 'active' | 'unused' | 'pending';
    if (review.inUse === 'yes') {
      if (usedCanonicalKeys.has(canonicalKey)) {
        status = 'pending';
      } else {
        status = 'active';
        mapping[sourceHeader] = canonicalKey;
        usedCanonicalKeys.add(canonicalKey);
      }
    } else if (review.inUse === 'no') {
      status = 'unused';
      // mapping 対象外 — CSV には残るが rename しない
    } else {
      // unknown → fail-closed: pending のまま canonical に昇格させない
      status = 'pending';
    }

    columns.push({
      position: review.position,
      sourceHeader,
      canonicalKey,
      label,
      status,
      required: review.required,
    });
  }

  // position 順にソート
  columns.sort((a, b) => a.position - b.position);

  return {
    runId,
    profileId,
    generatedAt: new Date().toISOString(),
    mapping,
    activeCount: columns.filter(c => c.status === 'active').length,
    unusedCount: columns.filter(c => c.status === 'unused').length,
    pendingCount: columns.filter(c => c.status === 'pending').length,
    columns,
  };
}

// --- Persistence ---

function getEffectiveMappingDir(dataDir: string): string {
  return join(dataDir, 'column-reviews', 'effective');
}

function getEffectiveMappingPath(dataDir: string, runId: string, profileId: string): string {
  return join(getEffectiveMappingDir(dataDir), `${runId}_${profileId}.json`);
}

export function saveEffectiveMapping(dataDir: string, result: EffectiveMappingResult): void {
  const dir = getEffectiveMappingDir(dataDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    getEffectiveMappingPath(dataDir, result.runId, result.profileId),
    JSON.stringify(result, null, 2),
    'utf-8',
  );
}

export function loadEffectiveMapping(
  dataDir: string,
  runId: string,
  profileId: string,
): EffectiveMappingResult | null {
  const filePath = getEffectiveMappingPath(dataDir, runId, profileId);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as EffectiveMappingResult;
  } catch {
    return null;
  }
}

/**
 * 指定 runId に紐づく全 effective mapping を返す。
 * rerun-with-review 時に使用。
 */
export function findEffectiveMappings(dataDir: string, runId: string): EffectiveMappingResult[] {
  const dir = getEffectiveMappingDir(dataDir);
  if (!existsSync(dir)) return [];

  const prefix = `${runId}_`;
  const results: EffectiveMappingResult[] = [];

  for (const f of readdirSync(dir)) {
    if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
    try {
      results.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')) as EffectiveMappingResult);
    } catch {
      // skip corrupted
    }
  }

  return results;
}
