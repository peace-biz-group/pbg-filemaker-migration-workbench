import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEmptyMemory,
  lookupResolution,
  addResolution,
  shouldAutoApply,
  saveMemory,
  loadMemory,
  type ResolutionRecord,
} from '../../src/core/resolution-memory.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'resolution-memory-test-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createEmptyMemory', () => {
  it('returns empty memory with version 1', () => {
    const mem = createEmptyMemory();
    expect(mem.version).toBe('1');
    expect(mem.resolutions).toEqual([]);
  });
});

describe('addResolution + lookupResolution', () => {
  it('returns null when memory is empty', () => {
    const mem = createEmptyMemory();
    const result = lookupResolution('shared_phone', 'phone:09012345678', mem);
    expect(result).toBeNull();
  });

  it('finds a record by type and context_key', () => {
    let mem = createEmptyMemory();
    const rec: ResolutionRecord = {
      resolution_id: 'res_001',
      resolution_type: 'shared_phone',
      context_key: 'phone:09012345678',
      family_id: null,
      decision: 'keep_all',
      decision_detail: {},
      certainty: 'confirmed',
      scope: 'phone_value',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'human',
      auto_apply_condition: 'exact_match:phone_normalized',
      source_batch_ids: [],
    };
    mem = addResolution(rec, mem);
    const found = lookupResolution('shared_phone', 'phone:09012345678', mem);
    expect(found).not.toBeNull();
    expect(found!.resolution_id).toBe('res_001');
  });

  it('returns null for wrong context_key', () => {
    let mem = createEmptyMemory();
    const rec: ResolutionRecord = {
      resolution_id: 'res_001',
      resolution_type: 'shared_phone',
      context_key: 'phone:09012345678',
      family_id: null,
      decision: 'keep_all',
      decision_detail: {},
      certainty: 'confirmed',
      scope: 'phone_value',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'human',
      auto_apply_condition: 'exact_match:phone_normalized',
      source_batch_ids: [],
    };
    mem = addResolution(rec, mem);
    expect(lookupResolution('shared_phone', 'phone:OTHER', mem)).toBeNull();
  });

  it('returns null for wrong type', () => {
    let mem = createEmptyMemory();
    const rec: ResolutionRecord = {
      resolution_id: 'res_001',
      resolution_type: 'shared_phone',
      context_key: 'phone:09012345678',
      family_id: null,
      decision: 'keep_all',
      decision_detail: {},
      certainty: 'confirmed',
      scope: 'phone_value',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'human',
      auto_apply_condition: 'exact_match:phone_normalized',
      source_batch_ids: [],
    };
    mem = addResolution(rec, mem);
    expect(lookupResolution('status_meaning', 'phone:09012345678', mem)).toBeNull();
  });

  it('returns null for a soft-deleted record', () => {
    let mem = createEmptyMemory();
    const rec: ResolutionRecord = {
      resolution_id: 'res_del',
      resolution_type: 'shared_phone',
      context_key: 'phone:09099999999',
      family_id: null,
      decision: 'keep_all',
      decision_detail: {},
      certainty: 'confirmed',
      scope: 'phone_value',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'human',
      auto_apply_condition: 'exact_match:phone_normalized',
      source_batch_ids: [],
      deleted_at: '2026-04-07T01:00:00Z',
    };
    mem = addResolution(rec, mem);
    expect(lookupResolution('shared_phone', 'phone:09099999999', mem)).toBeNull();
  });
});

describe('shouldAutoApply', () => {
  it('returns true for confirmed', () => {
    const rec = { certainty: 'confirmed' } as ResolutionRecord;
    expect(shouldAutoApply(rec)).toBe(true);
  });

  it('returns true for high', () => {
    const rec = { certainty: 'high' } as ResolutionRecord;
    expect(shouldAutoApply(rec)).toBe(true);
  });

  it('returns false for low', () => {
    const rec = { certainty: 'low' } as ResolutionRecord;
    expect(shouldAutoApply(rec)).toBe(false);
  });
});

describe('saveMemory + loadMemory', () => {
  it('round-trips through disk', async () => {
    let mem = createEmptyMemory();
    const rec: ResolutionRecord = {
      resolution_id: 'res_001',
      resolution_type: 'status_meaning',
      context_key: 'status:済',
      family_id: 'call_history',
      decision: 'completed',
      decision_detail: { normalized_stage: 'completed' },
      certainty: 'confirmed',
      scope: 'global',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'human',
      auto_apply_condition: 'exact_match:status_value',
      source_batch_ids: [],
    };
    mem = addResolution(rec, mem);
    await saveMemory(mem, tmpDir);
    const loaded = await loadMemory(tmpDir);
    expect(loaded.resolutions).toHaveLength(1);
    expect(loaded.resolutions[0].resolution_id).toBe('res_001');
  });

  it('loadMemory returns empty memory if file does not exist', async () => {
    const mem = await loadMemory(tmpDir);
    expect(mem.version).toBe('1');
    expect(mem.resolutions).toEqual([]);
  });
});
