import { describe, it, expect } from 'vitest';
import { normalizeFilename, filenameSimilarity } from '../../src/core/filename-matcher.js';

describe('filename-matcher', () => {
  describe('normalizeFilename', () => {
    it('strips csv extension', () => {
      expect(normalizeFilename('test.csv')).toBe('test');
    });
    it('strips xlsx extension', () => {
      expect(normalizeFilename('test.xlsx')).toBe('test');
    });
    it('strips 6-digit date prefix', () => {
      expect(normalizeFilename('240101_apo_list.csv')).toBe('apo_list');
    });
    it('strips 8-digit date prefix', () => {
      expect(normalizeFilename('20240101_apo_list.csv')).toBe('apo_list');
    });
    it('strips 4-digit date suffix', () => {
      expect(normalizeFilename('apo_list_2024.csv')).toBe('apo_list');
    });
    it('strips noise word 最新版', () => {
      expect(normalizeFilename('apo_list_最新版.csv')).toBe('apo_list');
    });
    it('strips noise word 修正版', () => {
      expect(normalizeFilename('顧客一覧_修正版.csv')).toBe('顧客一覧');
    });
    it('strips location suffix 福岡', () => {
      expect(normalizeFilename('太陽光顧客管理-福岡.csv')).toBe('太陽光顧客管理');
    });
    it('converts full-width to half-width', () => {
      expect(normalizeFilename('ＡＢＣ.csv')).toBe('abc');
    });
    it('handles date prefix + noise suffix together', () => {
      expect(normalizeFilename('240101_apo_list_最新版.csv')).toBe('apo_list');
    });
    it('does not return empty string for unknown file', () => {
      const result = normalizeFilename('abc.csv');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('filenameSimilarity', () => {
    it('returns 1.0 for identical filenames', () => {
      expect(filenameSimilarity('apo_list.csv', 'apo_list.csv')).toBe(1.0);
    });
    it('returns 1.0 for filenames that normalize to the same string', () => {
      expect(filenameSimilarity('apo_list_最新版.csv', '240101_apo_list.csv')).toBe(1.0);
    });
    it('returns high similarity for same name with location suffix', () => {
      const sim = filenameSimilarity('太陽光顧客管理-福岡.csv', '太陽光顧客管理.csv');
      expect(sim).toBe(1.0);
    });
    it('returns low similarity for completely different names', () => {
      const sim = filenameSimilarity('apo_list.csv', 'customer_master.csv');
      expect(sim).toBeLessThan(0.4);
    });
    it('returns 0.0 for empty after normalization', () => {
      // Both normalize to 1-char strings ('a' and 'b') which are different
      const sim = filenameSimilarity('a.csv', 'b.csv');
      expect(sim).toBe(0);
    });
  });
});
