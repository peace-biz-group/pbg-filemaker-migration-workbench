/**
 * Phone number normalization for Japanese phone numbers.
 */

import { fullWidthToHalfWidth } from './text.js';

/** Strip all non-digit characters except leading +. */
function stripNonDigits(s: string): string {
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/[^\d]/g, '');
  return hasPlus ? '+' + digits : digits;
}

/**
 * Normalize a Japanese phone number.
 * - Full-width → half-width
 * - Strip hyphens, parentheses, spaces
 * - Convert +81 prefix to 0
 * - Return empty string if invalid
 */
export function normalizePhone(raw: string): string {
  if (!raw || !raw.trim()) return '';

  let v = fullWidthToHalfWidth(raw.trim());
  v = stripNonDigits(v);

  // Convert international prefix
  if (v.startsWith('+81')) {
    v = '0' + v.slice(3);
  } else if (v.startsWith('81') && v.length >= 12) {
    v = '0' + v.slice(2);
  }

  return v;
}

/**
 * Validate that a normalized phone looks like a Japanese phone number.
 * Returns a reason string if invalid, or null if valid.
 */
export function validatePhone(normalized: string): string | null {
  if (!normalized) return null; // empty is not anomalous
  if (!/^\d+$/.test(normalized)) return 'contains non-digit characters';
  if (normalized.length < 10) return `too short (${normalized.length} digits)`;
  if (normalized.length > 11) return `too long (${normalized.length} digits)`;
  if (!normalized.startsWith('0')) return 'does not start with 0';
  return null;
}
