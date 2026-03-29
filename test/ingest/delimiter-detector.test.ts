import { describe, it, expect } from 'vitest';
import { detectDelimiter } from '../../src/ingest/delimiter-detector.js';

describe('detectDelimiter', () => {
  it('detects comma', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n4,5,6')).toBe(',');
  });
  it('detects tab', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });
  it('detects semicolon', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
  });
  it('defaults to comma on empty input', () => {
    expect(detectDelimiter('')).toBe(',');
  });
});
