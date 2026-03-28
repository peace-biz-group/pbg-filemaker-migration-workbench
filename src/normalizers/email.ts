/**
 * Email normalization and validation.
 */

import { fullWidthToHalfWidth } from './text.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalize an email address: trim, full-width→half-width, lowercase. */
export function normalizeEmail(raw: string): string {
  if (!raw || !raw.trim()) return '';
  let v = fullWidthToHalfWidth(raw.trim());
  v = v.toLowerCase();
  return v;
}

/** Validate normalized email. Returns reason string if invalid, null if valid. */
export function validateEmail(normalized: string): string | null {
  if (!normalized) return null;
  if (!EMAIL_RE.test(normalized)) return 'invalid email format';
  return null;
}
