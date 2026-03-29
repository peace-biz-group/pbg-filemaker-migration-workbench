import { describe, it, expect } from 'vitest';
import { detectEncoding } from '../../src/ingest/encoding-detector.js';
import { join } from 'node:path';

const F = join(import.meta.dirname, '..', 'fixtures');

describe('detectEncoding', () => {
  it('detects UTF-8', async () => {
    const r = await detectEncoding(join(F, 'utf8.csv'));
    expect(r.detectedEncoding).toBe('utf8');
    expect(r.appliedEncoding).toBe('utf8');
  });

  it('detects UTF-8 BOM', async () => {
    const r = await detectEncoding(join(F, 'utf8-bom.csv'));
    expect(r.detectedEncoding).toBe('utf8bom');
    expect(r.confidence).toBe('bom');
    expect(r.appliedEncoding).toBe('utf8');
  });

  it('detects Shift-JIS', async () => {
    const r = await detectEncoding(join(F, 'shiftjis.csv'));
    expect(r.detectedEncoding).toBe('cp932');
    expect(r.appliedEncoding).toBe('cp932');
  });
});
