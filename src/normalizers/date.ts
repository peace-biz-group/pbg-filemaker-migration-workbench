/**
 * Date string normalization for Japanese date formats.
 */

import { fullWidthToHalfWidth } from './text.js';

/** Japanese era name → Gregorian start year. */
const ERA_MAP: Record<string, number> = {
  '明治': 1868, '大正': 1912, '昭和': 1926, '平成': 1989, '令和': 2019,
  'M': 1868, 'T': 1912, 'S': 1926, 'H': 1989, 'R': 2019,
};

const JP_DATE_RE = /^(明治|大正|昭和|平成|令和|[MTSHR])(\d{1,2})[年./\-](\d{1,2})[月./\-](\d{1,2})日?$/;
const SLASH_DATE_RE = /^(\d{4})[./\-](\d{1,2})[./\-](\d{1,2})$/;
const YYYYMMDD_RE = /^(\d{4})(\d{2})(\d{2})$/;

/**
 * Normalize a date string to ISO 8601 (YYYY-MM-DD).
 * Handles: 2024/01/15, 2024-01-15, 令和6年1月15日, H6.1.15, 20240115
 * Returns original string if unparseable.
 */
export function normalizeDate(raw: string): string {
  if (!raw || !raw.trim()) return '';

  let v = fullWidthToHalfWidth(raw.trim());
  v = v.replace(/\s+/g, '');

  // Japanese era dates
  const jpMatch = v.match(JP_DATE_RE);
  if (jpMatch) {
    const baseYear = ERA_MAP[jpMatch[1]];
    if (baseYear) {
      const year = baseYear + parseInt(jpMatch[2], 10) - 1;
      const month = jpMatch[3].padStart(2, '0');
      const day = jpMatch[4].padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }

  // Standard slash/hyphen/dot dates
  const slashMatch = v.match(SLASH_DATE_RE);
  if (slashMatch) {
    const month = slashMatch[2].padStart(2, '0');
    const day = slashMatch[3].padStart(2, '0');
    return `${slashMatch[1]}-${month}-${day}`;
  }

  // Compact YYYYMMDD
  const compactMatch = v.match(YYYYMMDD_RE);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  }

  return raw.trim();
}

/**
 * Validate a normalized date string. Returns reason if invalid, null if OK.
 */
export function validateDate(normalized: string): string | null {
  if (!normalized) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return 'not in YYYY-MM-DD format';
  const d = new Date(normalized + 'T00:00:00Z');
  if (isNaN(d.getTime())) return 'invalid date';
  const year = d.getUTCFullYear();
  if (year < 1900 || year > 2100) return `year ${year} out of range`;
  return null;
}
