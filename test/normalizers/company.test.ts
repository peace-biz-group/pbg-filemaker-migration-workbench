import { describe, it, expect } from 'vitest';
import {
  normalizeCompanyName,
  companyMatchKey,
  normalizeAddress,
  addressMatchKey,
  storeMatchKey,
} from '../../src/normalizers/company.js';

describe('normalizeCompanyName', () => {
  it('converts (株) to 株式会社', () => {
    expect(normalizeCompanyName('(株)テスト')).toBe('株式会社テスト');
  });

  it('converts （株） (full-width parens) to 株式会社', () => {
    expect(normalizeCompanyName('（株）テスト')).toBe('株式会社テスト');
  });

  it('converts ㈱ to 株式会社', () => {
    expect(normalizeCompanyName('㈱テスト')).toBe('株式会社テスト');
  });

  it('converts trailing (株)', () => {
    expect(normalizeCompanyName('テスト(株)')).toBe('テスト株式会社');
  });

  it('converts (有) to 有限会社', () => {
    expect(normalizeCompanyName('(有)サンプル')).toBe('有限会社サンプル');
  });

  it('converts ㈲ to 有限会社', () => {
    expect(normalizeCompanyName('㈲サンプル')).toBe('有限会社サンプル');
  });

  it('keeps 株式会社 unchanged', () => {
    expect(normalizeCompanyName('株式会社テスト')).toBe('株式会社テスト');
  });

  it('returns empty for empty', () => {
    expect(normalizeCompanyName('')).toBe('');
  });
});

describe('companyMatchKey', () => {
  it('matches 株式会社テスト and (株)テスト', () => {
    expect(companyMatchKey('株式会社テスト')).toBe(companyMatchKey('(株)テスト'));
  });

  it('matches ㈱テスト and 株式会社テスト', () => {
    expect(companyMatchKey('㈱テスト')).toBe(companyMatchKey('株式会社テスト'));
  });

  it('matches 有限会社サンプル and ㈲サンプル', () => {
    expect(companyMatchKey('有限会社サンプル')).toBe(companyMatchKey('㈲サンプル'));
  });

  it('strips company type prefix for matching', () => {
    expect(companyMatchKey('株式会社テスト')).toBe('テスト'.toLowerCase());
  });
});

describe('normalizeAddress', () => {
  it('strips postal code prefix', () => {
    expect(normalizeAddress('〒150-0001 東京都渋谷区')).toBe('150-0001 東京都渋谷区');
  });

  it('normalizes full-width digits', () => {
    expect(normalizeAddress('東京都渋谷区１丁目２番３号')).toBe('東京都渋谷区1丁目2番3号');
  });
});

describe('addressMatchKey', () => {
  it('strips postal code and whitespace', () => {
    const a = addressMatchKey('150-0001 東京都渋谷区1-2-3');
    const b = addressMatchKey('東京都渋谷区1-2-3');
    expect(a).toBe(b);
  });
});

describe('storeMatchKey', () => {
  it('strips 店 suffix', () => {
    expect(storeMatchKey('ABCストア新宿店')).toBe('abcストア新宿');
  });

  it('strips 支店 suffix', () => {
    expect(storeMatchKey('ABCストア新宿支店')).toBe('abcストア新宿');
  });
});
