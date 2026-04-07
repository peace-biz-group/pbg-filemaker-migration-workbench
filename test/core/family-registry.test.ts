import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeFileShapeFingerprint,
  detectFamily,
  lookupFingerprint,
  registerFingerprint,
  createDefaultRegistry,
  saveRegistry,
  loadRegistry,
  type FamilyRegistryEntry,
} from '../../src/core/family-registry.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'family-registry-test-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('computeFileShapeFingerprint', () => {
  it('produces same fingerprint for same columns regardless of order', () => {
    const fp1 = computeFileShapeFingerprint(['氏名', '電話番号', '住所'], 'cp932', true);
    const fp2 = computeFileShapeFingerprint(['住所', '氏名', '電話番号'], 'cp932', true);
    expect(fp1).toBe(fp2);
  });

  it('produces different fingerprint for different column sets', () => {
    const fp1 = computeFileShapeFingerprint(['氏名', '電話番号'], 'cp932', true);
    const fp2 = computeFileShapeFingerprint(['氏名', 'メール'], 'cp932', true);
    expect(fp1).not.toBe(fp2);
  });

  it('produces different fingerprint for different encodings', () => {
    const fp1 = computeFileShapeFingerprint(['氏名'], 'cp932', true);
    const fp2 = computeFileShapeFingerprint(['氏名'], 'utf-8', true);
    expect(fp1).not.toBe(fp2);
  });
});

describe('detectFamily', () => {
  it('detects customer_master from customer columns', () => {
    const result = detectFamily(['氏名', '電話番号', '住所', '会社名', '郵便番号'], createDefaultRegistry());
    expect(result.familyId).toBe('customer_master');
    expect(result.certainty).toBe('high');
  });

  it('detects call_history from call columns', () => {
    const result = detectFamily(['通話日時', '担当者', 'コール結果', '電話番号'], createDefaultRegistry());
    expect(result.familyId).toBe('call_history');
  });

  it('returns unknown for unrecognized columns', () => {
    const result = detectFamily(['AAA', 'BBB', 'CCC'], createDefaultRegistry());
    expect(result.familyId).toBe('unknown');
  });
});

describe('lookupFingerprint + registerFingerprint', () => {
  it('returns null for unknown fingerprint', () => {
    const reg = createDefaultRegistry();
    expect(lookupFingerprint('unknown_fp', reg)).toBeNull();
  });

  it('stores and retrieves entry', () => {
    let reg = createDefaultRegistry();
    const entry: FamilyRegistryEntry = {
      fingerprint: 'fp_001',
      family_id: 'customer_master',
      certainty: 'confirmed',
      confirmed_at: '2026-04-07T00:00:00Z',
      column_count: 5,
      encoding: 'cp932',
      has_header: true,
      sample_filename: 'test.csv',
      matched_template_id: null,
    };
    reg = registerFingerprint(entry, reg);
    const found = lookupFingerprint('fp_001', reg);
    expect(found).not.toBeNull();
    expect(found!.family_id).toBe('customer_master');
  });
});

describe('saveRegistry + loadRegistry', () => {
  it('round-trips through disk', () => {
    let reg = createDefaultRegistry();
    const entry: FamilyRegistryEntry = {
      fingerprint: 'fp_001',
      family_id: 'customer_master',
      certainty: 'confirmed',
      confirmed_at: '2026-04-07T00:00:00Z',
      column_count: 3,
      encoding: 'cp932',
      has_header: true,
      sample_filename: 'test.csv',
      matched_template_id: null,
    };
    reg = registerFingerprint(entry, reg);
    saveRegistry(reg, tmpDir);
    const loaded = loadRegistry(tmpDir);
    expect(lookupFingerprint('fp_001', loaded)!.family_id).toBe('customer_master');
  });

  it('loadRegistry returns default registry if file does not exist', () => {
    const reg = loadRegistry(tmpDir);
    expect(reg.version).toBe('1');
    expect(Object.keys(reg.known_fingerprints)).toHaveLength(0);
  });
});
