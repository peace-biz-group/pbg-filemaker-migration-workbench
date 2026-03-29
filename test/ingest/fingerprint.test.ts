import { describe, it, expect } from 'vitest';
import { fileHash, schemaFingerprint, rowFingerprint, sourceBatchId, logicalSourceKey } from '../../src/ingest/fingerprint.js';
import { join } from 'node:path';

const F = join(import.meta.dirname, '..', 'fixtures');

describe('fingerprint', () => {
  it('fileHash returns stable 64-char hex', async () => {
    const h1 = await fileHash(join(F, 'utf8.csv'));
    const h2 = await fileHash(join(F, 'utf8.csv'));
    expect(h1).toHaveLength(64);
    expect(h1).toBe(h2);
  });

  it('schemaFingerprint is order-independent', () => {
    const a = schemaFingerprint(['name', 'phone', 'email']);
    const b = schemaFingerprint(['email', 'name', 'phone']);
    expect(a).toBe(b);
  });

  it('rowFingerprint is deterministic', () => {
    const fp1 = rowFingerprint('abc', 1, 'payload');
    const fp2 = rowFingerprint('abc', 1, 'payload');
    expect(fp1).toBe(fp2);
    expect(rowFingerprint('abc', 1, 'payload')).not.toBe(rowFingerprint('abc', 2, 'payload'));
  });

  it('sourceBatchId is order-independent', () => {
    const a = sourceBatchId(['hash1', 'hash2']);
    const b = sourceBatchId(['hash2', 'hash1']);
    expect(a).toBe(b);
  });

  it('logicalSourceKey is order-independent', () => {
    const a = logicalSourceKey(['file_a.csv', 'file_b.csv']);
    const b = logicalSourceKey(['file_b.csv', 'file_a.csv']);
    expect(a).toBe(b);
  });
});
