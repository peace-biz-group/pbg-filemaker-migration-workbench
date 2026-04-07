import { describe, it, expect } from 'vitest';
import { detectDelimiter } from '../../src/ingest/delimiter-detector.js';

function buildQuotedRow(values: string[]): string {
  return values.map((value) => `"${value.replace(/"/g, '""')}"`).join(',');
}

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

  it('ignores truncated trailing line when sparse tabs appear inside comma CSV fields', () => {
    const row = (label: string, withTabs = false) => {
      const values = Array.from({ length: 89 }, (_, index) => `${label}-${index}`);
      values[10] = withTabs ? `${label}\t\tinside` : `${label}-plain`;
      return buildQuotedRow(values);
    };

    const sample = [
      row('r1', true),
      row('r2'),
      row('r3'),
      row('r4'),
    ].join('\n').slice(0, 2048);

    expect(detectDelimiter(sample)).toBe(',');
  });
});
