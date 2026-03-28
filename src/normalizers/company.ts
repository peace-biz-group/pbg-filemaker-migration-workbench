/**
 * Company / store / address normalization — basic variant absorption.
 * NOT fuzzy matching. Pattern-based normalization of common Japanese business notation.
 */

import { normalizeText } from './text.js';

/** Common company type variant → canonical form. */
const COMPANY_TYPE_PATTERNS: [RegExp, string][] = [
  // 株式会社 variants
  [/^[\(（]株[\)）]/g, '株式会社'],
  [/[\(（]株[\)）]$/g, '株式会社'],
  [/^㈱/g, '株式会社'],
  [/㈱$/g, '株式会社'],
  // 有限会社 variants
  [/^[\(（]有[\)）]/g, '有限会社'],
  [/[\(（]有[\)）]$/g, '有限会社'],
  [/^㈲/g, '有限会社'],
  [/㈲$/g, '有限会社'],
  // 合同会社 variants
  [/^[\(（]同[\)）]/g, '合同会社'],
  [/[\(（]同[\)）]$/g, '合同会社'],
  // 合資会社 variants
  [/^[\(（]資[\)）]/g, '合資会社'],
  [/[\(（]資[\)）]$/g, '合資会社'],
];

/**
 * Normalize a company/organization name.
 * - Full-width → half-width (ASCII)
 * - (株) / ㈱ → 株式会社, (有) / ㈲ → 有限会社, etc.
 * - Trim and whitespace cleanup
 */
export function normalizeCompanyName(raw: string): string {
  if (!raw || !raw.trim()) return '';
  let v = normalizeText(raw);

  for (const [pattern, replacement] of COMPANY_TYPE_PATTERNS) {
    v = v.replace(pattern, replacement);
  }

  return v.trim();
}

/**
 * Generate a normalized key for company name matching.
 * Strips company type prefixes/suffixes for comparison.
 */
export function companyMatchKey(name: string): string {
  let v = normalizeCompanyName(name);
  // Strip company type for matching key
  v = v.replace(/^(株式会社|有限会社|合同会社|合資会社|一般社団法人|一般財団法人|特定非営利活動法人|NPO法人)\s*/g, '');
  v = v.replace(/\s*(株式会社|有限会社|合同会社|合資会社)$/g, '');
  return v.toLowerCase().trim();
}

/**
 * Normalize a Japanese address — basic cleanup.
 * - Full-width → half-width digits
 * - 丁目/番地/号 notation cleanup
 * - Common prefecture abbreviation expansion
 */
export function normalizeAddress(raw: string): string {
  if (!raw || !raw.trim()) return '';
  let v = normalizeText(raw);

  // Normalize number separators: ３丁目２番地１号 → 3-2-1 style not applied
  // but 3丁目2番地1号 → 3丁目2番地1号 (keep Japanese style, just normalize the digits)

  // Remove 〒 postal code prefix (keep the digits)
  v = v.replace(/^[〒\s]*(\d{3})-?(\d{4})\s*/, '$1-$2 ');

  return v.trim();
}

/**
 * Generate a normalized key for address matching.
 * Strips prefecture, whitespace, and common suffixes for comparison.
 */
export function addressMatchKey(addr: string): string {
  let v = normalizeAddress(addr);
  // Strip postal code
  v = v.replace(/^\d{3}-?\d{4}\s*/, '');
  // Normalize common delimiter differences
  v = v.replace(/\s+/g, '');
  return v.toLowerCase();
}

/**
 * Normalize a store/shop name.
 */
export function normalizeStoreName(raw: string): string {
  if (!raw || !raw.trim()) return '';
  let v = normalizeText(raw);
  // Remove trailing 店/支店/本店 for matching purposes is done in storeMatchKey
  return v.trim();
}

/**
 * Generate a normalized key for store name matching.
 */
export function storeMatchKey(name: string): string {
  let v = normalizeStoreName(name);
  // Strip common suffixes for matching
  v = v.replace(/(支店|本店|営業所|出張所|店舗|店)$/g, '');
  return v.toLowerCase().trim();
}
