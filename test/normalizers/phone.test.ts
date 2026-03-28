import { describe, it, expect } from 'vitest';
import { normalizePhone, validatePhone } from '../../src/normalizers/phone.js';

describe('normalizePhone', () => {
  it('strips hyphens and spaces', () => {
    expect(normalizePhone('03-1234-5678')).toBe('0312345678');
  });

  it('converts full-width digits', () => {
    expect(normalizePhone('０３−１２３４−５６７８')).toBe('0312345678');
  });

  it('converts +81 prefix', () => {
    expect(normalizePhone('+81-80-1111-2222')).toBe('08011112222');
  });

  it('returns empty for empty input', () => {
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone('  ')).toBe('');
  });

  it('handles parentheses', () => {
    expect(normalizePhone('(03)1234-5678')).toBe('0312345678');
  });
});

describe('validatePhone', () => {
  it('accepts valid 10-digit number', () => {
    expect(validatePhone('0312345678')).toBeNull();
  });

  it('accepts valid 11-digit mobile', () => {
    expect(validatePhone('09012345678')).toBeNull();
  });

  it('rejects too short', () => {
    expect(validatePhone('0312345')).toContain('too short');
  });

  it('rejects not starting with 0', () => {
    expect(validatePhone('312345678901')).not.toBeNull();
  });

  it('accepts empty as non-anomalous', () => {
    expect(validatePhone('')).toBeNull();
  });
});
