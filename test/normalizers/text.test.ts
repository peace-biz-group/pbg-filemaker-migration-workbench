import { describe, it, expect } from 'vitest';
import { fullWidthToHalfWidth, halfWidthKanaToFullWidth, cleanWhitespace, normalizeText } from '../../src/normalizers/text.js';

describe('fullWidthToHalfWidth', () => {
  it('converts full-width ASCII', () => {
    expect(fullWidthToHalfWidth('ＡＢＣ１２３')).toBe('ABC123');
  });

  it('leaves half-width unchanged', () => {
    expect(fullWidthToHalfWidth('ABC123')).toBe('ABC123');
  });
});

describe('halfWidthKanaToFullWidth', () => {
  it('converts basic katakana', () => {
    expect(halfWidthKanaToFullWidth('ｱｲｳ')).toBe('アイウ');
  });

  it('handles dakuten', () => {
    expect(halfWidthKanaToFullWidth('ｶﾞ')).toBe('ガ');
  });

  it('handles handakuten', () => {
    expect(halfWidthKanaToFullWidth('ﾊﾟ')).toBe('パ');
  });
});

describe('cleanWhitespace', () => {
  it('collapses multiple spaces', () => {
    expect(cleanWhitespace('foo   bar')).toBe('foo bar');
  });

  it('replaces newlines with space', () => {
    expect(cleanWhitespace('foo\nbar\r\nbaz')).toBe('foo bar baz');
  });

  it('trims', () => {
    expect(cleanWhitespace('  foo  ')).toBe('foo');
  });
});

describe('normalizeText', () => {
  it('applies full pipeline', () => {
    expect(normalizeText('　ＡＢＣ　ｱｲｳ　')).toBe('ABC アイウ');
  });
});
