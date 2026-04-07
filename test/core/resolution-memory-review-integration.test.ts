import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEmptyMemory,
  addResolution,
  saveMemory,
  type ResolutionRecord,
} from '../../src/core/resolution-memory.js';
import { applyColumnIgnoreResolutions } from '../../src/core/review-bundle.js';
import type { ColumnReview } from '../../src/types/review.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'review-resolution-test-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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
      reason: 'no match',
    },
    humanSemanticField: null,
    humanFieldFamily: null,
    humanSection: null,
    decision: 'unknown',
  };
}

describe('applyColumnIgnoreResolutions', () => {
  it('sets decision to unused for column_ignore resolution with certainty=confirmed', () => {
    let mem = createEmptyMemory();
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
    mem = addResolution(rec, mem);
    saveMemory(mem, tmpDir);

    const columns: ColumnReview[] = [makeColumn('備考'), makeColumn('氏名')];
    const result = applyColumnIgnoreResolutions(columns, tmpDir);

    expect(result[0].decision).toBe('unused');   // 備考 → unused
    expect(result[1].decision).toBe('unknown');  // 氏名 → unchanged
  });

  it('does not apply low-certainty resolutions', () => {
    let mem = createEmptyMemory();
    const rec: ResolutionRecord = {
      resolution_id: 'res_001',
      resolution_type: 'column_ignore',
      context_key: 'column:備考',
      family_id: null,
      decision: 'unused',
      decision_detail: {},
      certainty: 'low',
      scope: 'global',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'human',
      auto_apply_condition: 'exact_match:column_name',
      source_batch_ids: [],
    };
    mem = addResolution(rec, mem);
    saveMemory(mem, tmpDir);

    const columns: ColumnReview[] = [makeColumn('備考')];
    const result = applyColumnIgnoreResolutions(columns, tmpDir);

    expect(result[0].decision).toBe('unknown'); // unchanged — low certainty
  });

  it('returns columns unchanged if no memory file exists', () => {
    const columns: ColumnReview[] = [makeColumn('備考')];
    const result = applyColumnIgnoreResolutions(columns, tmpDir);
    expect(result[0].decision).toBe('unknown');
  });

  it('does not overwrite a column with existing human decision', () => {
    let mem = createEmptyMemory();
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
    mem = addResolution(rec, mem);
    saveMemory(mem, tmpDir);

    const column: ColumnReview = {
      sourceColumn: '備考',
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
      humanSemanticField: '備考メモ',
      humanFieldFamily: null,
      humanSection: null,
      decision: 'accepted',  // already decided by human
    };
    const result = applyColumnIgnoreResolutions([column], tmpDir);
    expect(result[0].decision).toBe('accepted');  // must NOT be overwritten
  });
});
