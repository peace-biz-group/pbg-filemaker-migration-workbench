import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDefaultRegistry, registerFingerprint, saveRegistry,
  computeFileShapeFingerprint, type FamilyRegistryEntry,
} from '../../src/core/family-registry.js';
import { enrichRoutingDecisionWithFamily } from '../../src/core/source-routing.js';

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'family-routing-test-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

describe('enrichRoutingDecisionWithFamily', () => {
  it('returns familyId from registry when fingerprint is known', () => {
    let reg = createDefaultRegistry();
    const fp = computeFileShapeFingerprint(['氏名', '電話番号'], 'cp932', true);
    const entry: FamilyRegistryEntry = {
      fingerprint: fp, family_id: 'customer_master', certainty: 'confirmed',
      confirmed_at: '2026-04-07T00:00:00Z', column_count: 2, encoding: 'cp932',
      has_header: true, sample_filename: 'test.csv', matched_template_id: null,
    };
    reg = registerFingerprint(entry, reg);
    saveRegistry(reg, tmpDir);

    const result = enrichRoutingDecisionWithFamily(['氏名', '電話番号'], 'cp932', true, tmpDir);
    expect(result.familyId).toBe('customer_master');
    expect(result.certainty).toBe('confirmed');  // ← human confirmed
  });

  it('auto-detects family when fingerprint is unknown', () => {
    const result = enrichRoutingDecisionWithFamily(
      ['氏名', '電話番号', '住所', '会社名', '郵便番号'], 'cp932', true, tmpDir,
    );
    expect(result.familyId).toBe('customer_master');
    expect(result.certainty).toBe('low');  // ← algorithmic detection → always low
  });

  it('returns unknown family for unrecognized columns', () => {
    const result = enrichRoutingDecisionWithFamily(['AAA', 'BBB', 'CCC'], 'utf-8', true, tmpDir);
    expect(result.familyId).toBe('unknown');
  });
});
