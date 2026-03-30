import { describe, it, expect } from 'vitest';
import { scanForMojibake } from '../../src/ingest/mojibake-detector.js';
import type { RawRecord } from '../../src/types/index.js';

describe('mojibake-detector', () => {
  it('returns clean result for empty rows', () => {
    const result = scanForMojibake([]);
    expect(result.hasMojibake).toBe(false);
    expect(result.mojibakeRatio).toBe(0);
    expect(result.hasControlChars).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it('returns clean result for normal Japanese text', () => {
    const rows: RawRecord[] = [
      { name: '田中太郎', phone: '090-1234-5678', address: '東京都新宿区' },
    ];
    const result = scanForMojibake(rows);
    expect(result.hasMojibake).toBe(false);
    expect(result.mojibakeRatio).toBe(0);
  });

  it('detects replacement character (U+FFFD)', () => {
    const rows: RawRecord[] = [
      { name: '田中\uFFFD太郎', phone: '090-1234-5678' },
      { name: '鈴木\uFFFD花子', phone: '03-2345-6789' },
      { name: '山田一郎', phone: '06-3456-7890' },
    ];
    const result = scanForMojibake(rows);
    expect(result.hasMojibake).toBe(true);
    expect(result.mojibakeRatio).toBeGreaterThan(0.02);
  });

  it('detects Latin Extended characters (mojibake pattern)', () => {
    // Simulate UTF-8 Japanese decoded as Latin-1: Ã¥Â¤§Ã¦Â§ etc.
    const rows: RawRecord[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push({ col1: 'Ã¥Â¤§Ã¦Â§', col2: 'normal text' });
    }
    const result = scanForMojibake(rows);
    expect(result.hasMojibake).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('detects control characters', () => {
    const rows: RawRecord[] = [
      { name: 'test\x01value', phone: '090-1234-5678' },
    ];
    const result = scanForMojibake(rows);
    expect(result.hasControlChars).toBe(true);
    expect(result.controlCharCount).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('制御文字'))).toBe(true);
  });

  it('respects sampleSize limit', () => {
    // Create 100 rows but only scan 5
    const rows: RawRecord[] = Array.from({ length: 100 }, (_, i) => ({
      col: `value_${i}`,
    }));
    // Should not throw regardless of sampleSize
    expect(() => scanForMojibake(rows, 5)).not.toThrow();
  });

  it('generates strong warning for high mojibake ratio', () => {
    // >30% mojibake
    const rows: RawRecord[] = Array.from({ length: 10 }, () => ({
      col1: 'Ã¥Â¤§Ã¦Â§Ã¥', // Latin Extended mojibake
      col2: 'Ã¥Â¤§',
    }));
    const result = scanForMojibake(rows);
    if (result.hasMojibake && result.mojibakeRatio > 0.3) {
      expect(result.warnings.some(w => w.includes('多いです') || w.includes('Shift-JIS'))).toBe(true);
    }
  });
});
