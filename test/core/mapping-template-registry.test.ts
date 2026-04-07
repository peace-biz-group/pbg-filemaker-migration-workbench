import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEmptyRegistry,
  getTemplate,
  upsertTemplate,
  saveRegistry,
  loadRegistry,
  computeAutoApplyEligibility,
  type MappingTemplate,
  type ColumnDecision,
} from '../../src/core/mapping-template-registry.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'template-registry-test-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeDecision(sourceCol: string, confidence: ColumnDecision['confidence'] = 'confirmed'): ColumnDecision {
  return {
    source_col: sourceCol,
    canonical_field: sourceCol === '備考' ? null : sourceCol,
    inferred_type: 'text',
    normalization_rule: null,
    confidence,
    decided_at: '2026-04-07T00:00:00Z',
    decided_by: 'human',
  };
}

describe('createEmptyRegistry', () => {
  it('returns empty registry', () => {
    const reg = createEmptyRegistry();
    expect(reg.version).toBe('1');
    expect(Object.keys(reg.templates)).toHaveLength(0);
    expect(Object.keys(reg.fingerprint_to_template)).toHaveLength(0);
  });
});

describe('upsertTemplate + getTemplate', () => {
  it('returns null for unknown schemaFP', () => {
    const reg = createEmptyRegistry();
    expect(getTemplate('unknown_fp', reg)).toBeNull();
  });

  it('stores and retrieves template by schemaFP', () => {
    let reg = createEmptyRegistry();
    const template: MappingTemplate = {
      template_id: 'customer_master_v1',
      family_id: 'customer_master',
      schema_fingerprint: 'fp_001',
      version: 1,
      created_at: '2026-04-07T00:00:00Z',
      confirmed_at: '2026-04-07T00:00:00Z',
      column_decisions: [makeDecision('氏名'), makeDecision('備考')],
      auto_apply_eligibility: 'full',
      known_schema_fingerprints: ['fp_001'],
    };
    reg = upsertTemplate(template, reg);
    const found = getTemplate('fp_001', reg);
    expect(found).not.toBeNull();
    expect(found!.template_id).toBe('customer_master_v1');
  });

  it('finds template by schema_fingerprint even when not in known_schema_fingerprints', () => {
    let reg = createEmptyRegistry();
    const template: MappingTemplate = {
      template_id: 'tmpl_v2',
      family_id: 'customer_master',
      schema_fingerprint: 'primary_fp',
      version: 1,
      created_at: '2026-04-07T00:00:00Z',
      confirmed_at: null,
      column_decisions: [],
      auto_apply_eligibility: 'review_required',
      known_schema_fingerprints: [],  // deliberately empty
    };
    reg = upsertTemplate(template, reg);
    expect(getTemplate('primary_fp', reg)!.template_id).toBe('tmpl_v2');
  });

  it('maps all known_schema_fingerprints to the template', () => {
    let reg = createEmptyRegistry();
    const template: MappingTemplate = {
      template_id: 'tmpl_v1',
      family_id: 'customer_master',
      schema_fingerprint: 'fp_001',
      version: 1,
      created_at: '2026-04-07T00:00:00Z',
      confirmed_at: null,
      column_decisions: [],
      auto_apply_eligibility: 'full',
      known_schema_fingerprints: ['fp_001', 'fp_002'],
    };
    reg = upsertTemplate(template, reg);
    expect(getTemplate('fp_001', reg)!.template_id).toBe('tmpl_v1');
    expect(getTemplate('fp_002', reg)!.template_id).toBe('tmpl_v1');
  });
});

describe('computeAutoApplyEligibility', () => {
  it('returns full when all decisions are confirmed or high', () => {
    const decisions: ColumnDecision[] = [
      makeDecision('氏名', 'confirmed'),
      makeDecision('電話番号', 'high'),
    ];
    expect(computeAutoApplyEligibility(decisions)).toBe('full');
  });

  it('returns review_required for empty decisions', () => {
    expect(computeAutoApplyEligibility([])).toBe('review_required');
  });

  it('returns partial when low count <= 20%', () => {
    const decisions: ColumnDecision[] = [
      makeDecision('氏名', 'confirmed'),
      makeDecision('電話番号', 'confirmed'),
      makeDecision('住所', 'confirmed'),
      makeDecision('備考', 'confirmed'),
      makeDecision('メモ', 'low'), // 1/5 = 20%
    ];
    expect(computeAutoApplyEligibility(decisions)).toBe('partial');
  });

  it('returns review_required when low count > 20%', () => {
    const decisions: ColumnDecision[] = [
      makeDecision('A', 'confirmed'),
      makeDecision('B', 'low'),
      makeDecision('C', 'low'), // 2/3 > 20%
    ];
    expect(computeAutoApplyEligibility(decisions)).toBe('review_required');
  });
});

describe('saveRegistry + loadRegistry', () => {
  it('round-trips through disk', () => {
    let reg = createEmptyRegistry();
    const template: MappingTemplate = {
      template_id: 'test_v1',
      family_id: 'customer_master',
      schema_fingerprint: 'fp_001',
      version: 1,
      created_at: '2026-04-07T00:00:00Z',
      confirmed_at: null,
      column_decisions: [makeDecision('氏名')],
      auto_apply_eligibility: 'full',
      known_schema_fingerprints: ['fp_001'],
    };
    reg = upsertTemplate(template, reg);
    saveRegistry(reg, tmpDir);
    const loaded = loadRegistry(tmpDir);
    expect(Object.keys(loaded.templates)).toHaveLength(1);
    expect(getTemplate('fp_001', loaded)!.template_id).toBe('test_v1');
  });

  it('loadRegistry returns empty registry if file does not exist', () => {
    const reg = loadRegistry(tmpDir);
    expect(Object.keys(reg.templates)).toHaveLength(0);
  });
});
