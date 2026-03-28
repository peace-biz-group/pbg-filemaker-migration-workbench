import { describe, it, expect } from 'vitest';
import { normalizeEmail, validateEmail } from '../../src/normalizers/email.js';

describe('normalizeEmail', () => {
  it('lowercases', () => {
    expect(normalizeEmail('TANAKA@EXAMPLE.COM')).toBe('tanaka@example.com');
  });

  it('converts full-width', () => {
    expect(normalizeEmail('ｔｅｓｔ＠ｅｘａｍｐｌｅ．ｃｏｍ')).toBe('test@example.com');
  });

  it('trims', () => {
    expect(normalizeEmail('  foo@bar.com  ')).toBe('foo@bar.com');
  });

  it('returns empty for empty', () => {
    expect(normalizeEmail('')).toBe('');
  });
});

describe('validateEmail', () => {
  it('accepts valid email', () => {
    expect(validateEmail('test@example.com')).toBeNull();
  });

  it('rejects missing @', () => {
    expect(validateEmail('testexample.com')).not.toBeNull();
  });

  it('accepts empty as non-anomalous', () => {
    expect(validateEmail('')).toBeNull();
  });
});
