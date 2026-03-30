/**
 * Filename normalization and similarity scoring for template matching.
 */

import { fullWidthToHalfWidth } from '../normalizers/text.js';

/** Extensions to strip before normalization. */
const EXTENSIONS = /\.(csv|xlsx|tsv|xls)$/i;

/** Date prefix: 6–8 digits optionally followed by a separator. */
const DATE_PREFIX = /^\d{6,8}[_\-\s]?/;

/** Date suffix: optionally preceded by a separator, 4–8 digits at end. */
const DATE_SUFFIX = /[_\-\s]?\d{4,8}$/;

/** Noise tokens to remove (exact token match, case-insensitive). */
const NOISE_TOKENS = new Set([
  '最新版', '最新', '修正版', '修正', '確定版', '確定',
  'コピー', 'copy', 'backup', 'bak', 'final',
]);

/** Regex matching noise tokens that have a numeric suffix (rev, v). */
const NOISE_TOKEN_REGEX = /^(rev\d*|v\d+)$/i;

/** Location words that may appear as trailing tokens. */
const LOCATION_TOKENS = new Set([
  '福岡', '東京', '大阪', '本社', '支店', '沖縄',
  '名古屋', '横浜', '札幌', '仙台', '京都', '神戸',
]);

/**
 * Normalize a filename for fuzzy matching:
 * - Remove extension (.csv, .xlsx, .tsv, .xls)
 * - Strip date prefix and suffix
 * - fullWidthToHalfWidth
 * - Lowercase
 * - Tokenize on [-_\s\.]+ separators, remove noise and trailing location tokens
 * - Rejoin with '_', trim leading/trailing '_'
 * - If result is empty, return the original filename lowercased
 */
export function normalizeFilename(filename: string): string {
  // Remove extension
  let name = filename.replace(EXTENSIONS, '');

  // Strip date prefix (e.g., "240101_")
  name = name.replace(DATE_PREFIX, '');

  // Strip date suffix (e.g., "_2024")
  name = name.replace(DATE_SUFFIX, '');

  // Full-width → half-width, then lowercase
  name = fullWidthToHalfWidth(name).toLowerCase();

  // Tokenize on separators
  const tokens = name.split(/[-_\s.]+/).filter(Boolean);

  // Remove noise tokens
  const filtered = tokens.filter(
    (t) => !NOISE_TOKENS.has(t) && !NOISE_TOKEN_REGEX.test(t),
  );

  // Remove trailing location tokens
  while (filtered.length > 0 && LOCATION_TOKENS.has(filtered[filtered.length - 1])) {
    filtered.pop();
  }

  const result = filtered.join('_').replace(/^_+|_+$/g, '');

  return result.length > 0 ? result : filename.toLowerCase();
}

/** Build an array of bigrams from a string. */
function bigrams(s: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < s.length - 1; i++) {
    result.push(s.slice(i, i + 2));
  }
  return result;
}

/**
 * Compute Dice coefficient similarity between two filenames.
 * - Normalize both filenames first.
 * - If identical after normalization: return 1.0
 * - If either has fewer than 2 chars after normalization: exact equality ? 1.0 : 0.0
 * - Otherwise: 2 * |intersection| / (|bigrams(a)| + |bigrams(b)|)
 */
export function filenameSimilarity(a: string, b: string): number {
  const na = normalizeFilename(a);
  const nb = normalizeFilename(b);

  if (na === nb) return 1.0;

  if (na.length < 2 || nb.length < 2) {
    return na === nb ? 1.0 : 0.0;
  }

  const ba = bigrams(na);
  const bb = bigrams(nb);

  // Count intersection using a frequency map
  const freq = new Map<string, number>();
  for (const bg of ba) {
    freq.set(bg, (freq.get(bg) ?? 0) + 1);
  }

  let intersection = 0;
  for (const bg of bb) {
    const count = freq.get(bg) ?? 0;
    if (count > 0) {
      intersection++;
      freq.set(bg, count - 1);
    }
  }

  return (2 * intersection) / (ba.length + bb.length);
}
