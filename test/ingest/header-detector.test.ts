import { describe, it, expect } from 'vitest';
import { detectHeaderLikelihood } from '../../src/ingest/header-detector.js';

describe('header-detector', () => {
  it('identifies typical header row as likely header', () => {
    const result = detectHeaderLikelihood(['名前', '電話番号', '住所', 'メール']);
    expect(result.isLikelyHeader).toBe(true);
    expect(result.confidence).toBe('high');
    expect(result.warnings).toHaveLength(0);
  });

  it('identifies data row (phone, address) as NOT header', () => {
    const result = detectHeaderLikelihood(['田中太郎', '090-1234-5678', '東京都新宿区西新宿1-1-1']);
    expect(result.isLikelyHeader).toBe(false);
    // evidence should flag phone and address
    const dataEvidence = result.evidence.filter(e => e.looksLikeData);
    expect(dataEvidence.length).toBeGreaterThanOrEqual(2);
  });

  it('identifies numeric row as NOT header', () => {
    const result = detectHeaderLikelihood(['1', '2', '3', '4']);
    expect(result.isLikelyHeader).toBe(false);
    expect(result.confidence).toBe('high');
  });

  it('identifies Japanese era date as data', () => {
    const result = detectHeaderLikelihood(['令和5年4月1日']);
    const dataEvidence = result.evidence.filter(e => e.looksLikeData);
    expect(dataEvidence).toHaveLength(1);
    expect(dataEvidence[0].reason).toBe('日付のようです');
  });

  it('identifies email as data', () => {
    const result = detectHeaderLikelihood(['test@example.com']);
    const dataEvidence = result.evidence.filter(e => e.looksLikeData);
    expect(dataEvidence).toHaveLength(1);
    expect(dataEvidence[0].reason).toBe('メールアドレスのようです');
  });

  it('handles empty row gracefully', () => {
    const result = detectHeaderLikelihood([]);
    expect(result.isLikelyHeader).toBe(true);
    expect(result.confidence).toBe('low');
  });

  it('handles all-empty-string cells', () => {
    const result = detectHeaderLikelihood(['', '', '']);
    expect(result.isLikelyHeader).toBe(true);
  });

  it('generates warning for data-looking rows', () => {
    const result = detectHeaderLikelihood(['090-1234-5678', '03-9876-5432', '06-1111-2222']);
    expect(result.isLikelyHeader).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('reproduces 太陽光顧客管理 first-row detection', () => {
    // Reproduce the real-world issue: CSV with no header, first row is customer data
    const firstRow = ['田中太郎', '090-1234-5678', '東京都新宿区西新宿1-1-1', '2023-04-01', '株式会社テスト'];
    const result = detectHeaderLikelihood(firstRow);
    expect(result.isLikelyHeader).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
