// test/core/auto-apply-orchestrator.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runAutoApplyPreview,
} from '../../src/core/auto-apply-orchestrator.js';
import {
  createDefaultRegistry,
  registerFingerprint,
  saveRegistry as saveFamilyRegistry,
  computeFileShapeFingerprint,
  type FamilyRegistryEntry,
} from '../../src/core/family-registry.js';
import {
  createEmptyRegistry as createEmptyTemplateRegistry,
  upsertTemplate,
  saveRegistry as saveTemplateRegistry,
  type MappingTemplate,
} from '../../src/core/mapping-template-registry.js';
import {
  createEmptyMemory,
  addResolution,
  saveMemory,
  type ResolutionRecord,
} from '../../src/core/resolution-memory.js';
import { computeSchemaFingerprint } from '../../src/core/review-bundle.js';

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'auto-apply-test-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

const COLS = ['氏名', '電話番号', '住所'];
const ENCODING = 'cp932';

describe('runAutoApplyPreview — empty registries', () => {
  it('returns customer_master family (algorithmic) and all columns unresolved', () => {
    const schemaFP = computeSchemaFingerprint(COLS);
    const result = runAutoApplyPreview(COLS, ENCODING, true, schemaFP, tmpDir);
    expect(result.familyId).toBe('customer_master');  // algorithmic detection hits threshold
    expect(result.familyCertainty).toBe('low');        // always low for algorithmic
    expect(result.templateId).toBeNull();
    expect(result.autoApplyEligibility).toBe('no_template');
    expect(result.appliedDecisions).toEqual([]);
    expect(result.unresolvedColumns).toEqual(COLS);
  });

  it('returns unknown family for unrecognized columns', () => {
    const cols = ['AAA', 'BBB'];
    const schemaFP = computeSchemaFingerprint(cols);
    const result = runAutoApplyPreview(cols, ENCODING, true, schemaFP, tmpDir);
    expect(result.familyId).toBe('unknown');
    expect(result.templateId).toBeNull();
    expect(result.unresolvedColumns).toEqual(cols);
  });
});

describe('runAutoApplyPreview — family resolved from registry', () => {
  it('returns confirmed certainty when fingerprint is in family registry', () => {
    const fp = computeFileShapeFingerprint(COLS, ENCODING, true);
    const entry: FamilyRegistryEntry = {
      fingerprint: fp,
      family_id: 'customer_master',
      certainty: 'confirmed',
      confirmed_at: '2026-04-07T00:00:00Z',
      column_count: COLS.length,
      encoding: ENCODING,
      has_header: true,
      sample_filename: 'test.csv',
      matched_template_id: null,
    };
    let reg = createDefaultRegistry();
    reg = registerFingerprint(entry, reg);
    saveFamilyRegistry(reg, tmpDir);

    const schemaFP = computeSchemaFingerprint(COLS);
    const result = runAutoApplyPreview(COLS, ENCODING, true, schemaFP, tmpDir);
    expect(result.familyId).toBe('customer_master');
    expect(result.familyCertainty).toBe('confirmed');
  });
});

describe('runAutoApplyPreview — template applies decisions', () => {
  it('applies confirmed decisions and leaves low-confidence unresolved', () => {
    const schemaFP = computeSchemaFingerprint(COLS);
    const template: MappingTemplate = {
      template_id: 'tmpl_v1',
      family_id: 'customer_master',
      schema_fingerprint: schemaFP,
      version: 1,
      created_at: '2026-04-07T00:00:00Z',
      confirmed_at: '2026-04-07T00:00:00Z',
      column_decisions: [
        {
          source_col: '氏名',
          canonical_field: 'name',
          inferred_type: 'name',
          normalization_rule: 'trim',
          confidence: 'confirmed',
          decided_at: '2026-04-07T00:00:00Z',
          decided_by: 'human',
        },
        {
          source_col: '電話番号',
          canonical_field: 'phone',
          inferred_type: 'phone',
          normalization_rule: 'normalize_phone',
          confidence: 'high',
          decided_at: '2026-04-07T00:00:00Z',
          decided_by: 'human',
        },
        {
          source_col: '住所',
          canonical_field: 'address',
          inferred_type: 'address',
          normalization_rule: null,
          confidence: 'low',
          decided_at: '2026-04-07T00:00:00Z',
          decided_by: 'auto',
        },
      ],
      auto_apply_eligibility: 'partial',
      known_schema_fingerprints: [schemaFP],
    };
    let reg = createEmptyTemplateRegistry();
    reg = upsertTemplate(template, reg);
    saveTemplateRegistry(reg, tmpDir);

    const result = runAutoApplyPreview(COLS, ENCODING, true, schemaFP, tmpDir);
    expect(result.templateId).toBe('tmpl_v1');
    expect(result.autoApplyEligibility).toBe('partial');
    expect(result.appliedDecisions).toHaveLength(2);
    expect(result.appliedDecisions[0]).toMatchObject({
      sourceColumn: '氏名',
      canonicalField: 'name',
      confidence: 'confirmed',
      source: 'template',
    });
    expect(result.appliedDecisions[1]).toMatchObject({
      sourceColumn: '電話番号',
      canonicalField: 'phone',
      confidence: 'high',
      source: 'template',
    });
    expect(result.unresolvedColumns).toEqual(['住所']);
  });
});

describe('runAutoApplyPreview — resolution memory applies column_ignore', () => {
  it('resolves column_ignore from memory when certainty is confirmed', () => {
    const cols = ['備考', '氏名'];
    const schemaFP = computeSchemaFingerprint(cols);
    const rec: ResolutionRecord = {
      resolution_id: 'res_001',
      resolution_type: 'column_ignore',
      context_key: 'column:備考',
      family_id: null,
      decision: 'unused',
      decision_detail: {},
      certainty: 'confirmed',
      scope: 'global',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'human',
      auto_apply_condition: 'exact_match:column_name',
      source_batch_ids: [],
    };
    let mem = createEmptyMemory();
    mem = addResolution(rec, mem);
    saveMemory(mem, tmpDir);

    const result = runAutoApplyPreview(cols, ENCODING, true, schemaFP, tmpDir);
    const ignored = result.appliedDecisions.find((d) => d.sourceColumn === '備考');
    expect(ignored).toBeDefined();
    expect(ignored!.canonicalField).toBeNull();
    expect(ignored!.source).toBe('memory');
    expect(result.unresolvedColumns).toContain('氏名');
    expect(result.unresolvedColumns).not.toContain('備考');
  });

  it('does NOT resolve column_ignore when certainty is low (fail-closed)', () => {
    const cols = ['備考'];
    const schemaFP = computeSchemaFingerprint(cols);
    const rec: ResolutionRecord = {
      resolution_id: 'res_002',
      resolution_type: 'column_ignore',
      context_key: 'column:備考',
      family_id: null,
      decision: 'unused',
      decision_detail: {},
      certainty: 'low',
      scope: 'global',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'auto',
      auto_apply_condition: 'exact_match:column_name',
      source_batch_ids: [],
    };
    let mem = createEmptyMemory();
    mem = addResolution(rec, mem);
    saveMemory(mem, tmpDir);

    const result = runAutoApplyPreview(cols, ENCODING, true, schemaFP, tmpDir);
    expect(result.appliedDecisions).toHaveLength(0);
    expect(result.unresolvedColumns).toEqual(['備考']);
  });
});
