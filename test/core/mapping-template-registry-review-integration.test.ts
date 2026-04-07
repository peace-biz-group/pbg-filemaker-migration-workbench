import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEmptyRegistry, upsertTemplate, saveRegistry, type MappingTemplate,
} from '../../src/core/mapping-template-registry.js';
import { applyTemplateToColumns } from '../../src/core/review-bundle.js';
import type { ColumnReview } from '../../src/types/review.js';

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'template-review-test-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function makeColumn(sourceColumn: string): ColumnReview {
  return {
    sourceColumn,
    sampleValues: [],
    missingRate: 0,
    uniqueCount: 0,
    suggestion: {
      semanticField: 'unknown',
      fieldFamily: 'raw_extra',
      section: 'raw_extra_info',
      confidence: 'low',
      reason: '',
    },
    humanSemanticField: null,
    humanFieldFamily: null,
    humanSection: null,
    decision: 'unknown',
  };
}

describe('applyTemplateToColumns', () => {
  it('pre-fills humanSemanticField and sets decision to accepted for confirmed template decision', () => {
    let reg = createEmptyRegistry();
    const template: MappingTemplate = {
      template_id: 'customer_v1',
      family_id: 'customer_master',
      schema_fingerprint: 'fp_001',
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
          source_col: '備考',
          canonical_field: null,
          inferred_type: 'text',
          normalization_rule: null,
          confidence: 'confirmed',
          decided_at: '2026-04-07T00:00:00Z',
          decided_by: 'human',
        },
      ],
      auto_apply_eligibility: 'full',
      known_schema_fingerprints: ['fp_001'],
    };
    reg = upsertTemplate(template, reg);
    saveRegistry(reg, tmpDir);

    const columns: ColumnReview[] = [makeColumn('氏名'), makeColumn('備考'), makeColumn('住所')];
    const result = applyTemplateToColumns(columns, 'fp_001', tmpDir);

    expect(result[0].humanSemanticField).toBe('name');   // 氏名 → name
    expect(result[0].decision).toBe('accepted');
    expect(result[1].humanSemanticField).toBeNull();     // 備考 → canonical=null → unused
    expect(result[1].decision).toBe('unused');
    expect(result[2].humanSemanticField).toBeNull();     // 住所 → no template entry → unchanged
    expect(result[2].decision).toBe('unknown');
  });

  it('does not apply low-confidence template decisions', () => {
    let reg = createEmptyRegistry();
    const template: MappingTemplate = {
      template_id: 'tmpl_v1',
      family_id: 'customer_master',
      schema_fingerprint: 'fp_002',
      version: 1,
      created_at: '2026-04-07T00:00:00Z',
      confirmed_at: null,
      column_decisions: [
        {
          source_col: '氏名',
          canonical_field: 'name',
          inferred_type: 'name',
          normalization_rule: null,
          confidence: 'low',
          decided_at: '2026-04-07T00:00:00Z',
          decided_by: 'auto',
        },
      ],
      auto_apply_eligibility: 'review_required',
      known_schema_fingerprints: ['fp_002'],
    };
    reg = upsertTemplate(template, reg);
    saveRegistry(reg, tmpDir);

    const columns: ColumnReview[] = [makeColumn('氏名')];
    const result = applyTemplateToColumns(columns, 'fp_002', tmpDir);

    expect(result[0].humanSemanticField).toBeNull();  // low confidence → not applied
    expect(result[0].decision).toBe('unknown');
  });

  it('does not overwrite an existing human decision', () => {
    let reg = createEmptyRegistry();
    const template: MappingTemplate = {
      template_id: 'tmpl_v1',
      family_id: 'customer_master',
      schema_fingerprint: 'fp_003',
      version: 1,
      created_at: '2026-04-07T00:00:00Z',
      confirmed_at: '2026-04-07T00:00:00Z',
      column_decisions: [
        {
          source_col: '氏名',
          canonical_field: 'name',
          inferred_type: 'name',
          normalization_rule: null,
          confidence: 'confirmed',
          decided_at: '2026-04-07T00:00:00Z',
          decided_by: 'human',
        },
      ],
      auto_apply_eligibility: 'full',
      known_schema_fingerprints: ['fp_003'],
    };
    reg = upsertTemplate(template, reg);
    saveRegistry(reg, tmpDir);

    const column: ColumnReview = {
      ...makeColumn('氏名'),
      humanSemanticField: '顧客名',
      decision: 'adjusted',
    };
    const result = applyTemplateToColumns([column], 'fp_003', tmpDir);

    expect(result[0].humanSemanticField).toBe('顧客名');  // must NOT be overwritten
    expect(result[0].decision).toBe('adjusted');
  });

  it('returns unchanged columns when no template exists for schemaFP', () => {
    const columns: ColumnReview[] = [makeColumn('氏名')];
    const result = applyTemplateToColumns(columns, 'unknown_fp', tmpDir);
    expect(result[0].decision).toBe('unknown');
  });
});
