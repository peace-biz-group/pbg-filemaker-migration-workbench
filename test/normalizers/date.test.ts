import { describe, it, expect } from 'vitest';
import { normalizeDate, validateDate } from '../../src/normalizers/date.js';

describe('normalizeDate', () => {
  it('converts slash format', () => {
    expect(normalizeDate('2024/01/15')).toBe('2024-01-15');
  });

  it('converts Japanese era', () => {
    expect(normalizeDate('令和6年1月15日')).toBe('2024-01-15');
  });

  it('converts era abbreviation', () => {
    expect(normalizeDate('H6.1.15')).toBe('1994-01-15');
  });

  it('converts compact YYYYMMDD', () => {
    expect(normalizeDate('20240520')).toBe('2024-05-20');
  });

  it('converts full-width digits', () => {
    expect(normalizeDate('２０２４／０１／１５')).toBe('2024-01-15');
  });

  it('returns empty for empty', () => {
    expect(normalizeDate('')).toBe('');
  });
});

describe('validateDate', () => {
  it('accepts valid ISO date', () => {
    expect(validateDate('2024-01-15')).toBeNull();
  });

  it('rejects non-ISO format', () => {
    expect(validateDate('2024/01/15')).not.toBeNull();
  });

  it('rejects out-of-range year', () => {
    expect(validateDate('1800-01-01')).not.toBeNull();
  });
});
