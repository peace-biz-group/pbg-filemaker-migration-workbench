// test/core/seed-loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSeedDir } from '../../src/core/seed-loader.js';
import { loadRegistry as loadFamilyRegistry, lookupFingerprint } from '../../src/core/family-registry.js';
import { loadRegistry as loadTemplateRegistry, getTemplate } from '../../src/core/mapping-template-registry.js';
import { loadMemory, lookupResolution } from '../../src/core/resolution-memory.js';
import type { FamilyRegistryEntry } from '../../src/core/family-registry.js';
import type { MappingTemplate } from '../../src/core/mapping-template-registry.js';
import type { ResolutionRecord } from '../../src/core/resolution-memory.js';

let seedDir: string;
let outputDir: string;
beforeEach(() => {
  seedDir = mkdtempSync(join(tmpdir(), 'seed-loader-seed-'));
  outputDir = mkdtempSync(join(tmpdir(), 'seed-loader-out-'));
});
afterEach(() => {
  rmSync(seedDir, { recursive: true, force: true });
  rmSync(outputDir, { recursive: true, force: true });
});

function writeSeed<T>(filename: string, data: T[]): void {
  writeFileSync(join(seedDir, filename), JSON.stringify(data, null, 2), 'utf-8');
}

describe('loadSeedDir — families.json', () => {
  it('loads FamilyRegistryEntry array into family registry', () => {
    const entry: FamilyRegistryEntry = {
      fingerprint: 'fp_seed_001',
      family_id: 'customer_master',
      certainty: 'high',
      confirmed_at: null,
      column_count: 3,
      encoding: 'cp932',
      has_header: true,
      sample_filename: '260312_顧客.csv',
      matched_template_id: null,
    };
    writeSeed('families.json', [entry]);

    const result = loadSeedDir(seedDir, outputDir);
    expect(result.familiesLoaded).toBe(1);

    const reg = loadFamilyRegistry(outputDir);
    const found = lookupFingerprint('fp_seed_001', reg);
    expect(found).not.toBeNull();
    expect(found!.family_id).toBe('customer_master');
  });

  it('skips families.json if file does not exist', () => {
    writeSeed('templates.json', []);
    writeSeed('memories.json', []);
    const result = loadSeedDir(seedDir, outputDir);
    expect(result.familiesLoaded).toBe(0);
  });
});

describe('loadSeedDir — templates.json', () => {
  it('loads MappingTemplate array into template registry', () => {
    const template: MappingTemplate = {
      template_id: 'seed_tmpl_v1',
      family_id: 'customer_master',
      schema_fingerprint: 'fp_schema_001',
      version: 1,
      created_at: '2026-04-07T00:00:00Z',
      confirmed_at: null,
      column_decisions: [],
      auto_apply_eligibility: 'review_required',
      known_schema_fingerprints: ['fp_schema_001'],
    };
    writeSeed('templates.json', [template]);

    const result = loadSeedDir(seedDir, outputDir);
    expect(result.templatesLoaded).toBe(1);

    const reg = loadTemplateRegistry(outputDir);
    expect(getTemplate('fp_schema_001', reg)!.template_id).toBe('seed_tmpl_v1');
  });
});

describe('loadSeedDir — memories.json', () => {
  it('loads ResolutionRecord array into resolution memory', () => {
    const rec: ResolutionRecord = {
      resolution_id: 'seed_res_001',
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
    writeSeed('memories.json', [rec]);

    const result = loadSeedDir(seedDir, outputDir);
    expect(result.memoriesLoaded).toBe(1);

    const mem = loadMemory(outputDir);
    const found = lookupResolution('column_ignore', 'column:備考', mem);
    expect(found!.resolution_id).toBe('seed_res_001');
  });
});

describe('loadSeedDir — merge semantics', () => {
  it('merges into existing registries without losing existing entries', () => {
    // First load
    const existing: FamilyRegistryEntry = {
      fingerprint: 'fp_existing',
      family_id: 'call_history',
      certainty: 'confirmed',
      confirmed_at: '2026-04-07T00:00:00Z',
      column_count: 2,
      encoding: 'utf-8',
      has_header: true,
      sample_filename: 'existing.csv',
      matched_template_id: null,
    };
    writeSeed('families.json', [existing]);
    loadSeedDir(seedDir, outputDir);

    // Second load with different seed dir
    const seedDir2 = mkdtempSync(join(tmpdir(), 'seed-loader-seed2-'));
    const newEntry: FamilyRegistryEntry = {
      fingerprint: 'fp_new',
      family_id: 'customer_master',
      certainty: 'high',
      confirmed_at: null,
      column_count: 5,
      encoding: 'cp932',
      has_header: true,
      sample_filename: 'new.csv',
      matched_template_id: null,
    };
    writeFileSync(join(seedDir2, 'families.json'), JSON.stringify([newEntry], null, 2), 'utf-8');
    loadSeedDir(seedDir2, outputDir);
    rmSync(seedDir2, { recursive: true, force: true });

    const reg = loadFamilyRegistry(outputDir);
    expect(lookupFingerprint('fp_existing', reg)).not.toBeNull();
    expect(lookupFingerprint('fp_new', reg)).not.toBeNull();
  });
});

describe('loadSeedDir — real data/seeds/260312 stubs', () => {
  it('loads the bundled 260312 seed stubs without error', () => {
    const SEED_260312 = join(import.meta.dirname, '../../data/seeds/260312');
    const result = loadSeedDir(SEED_260312, outputDir);
    expect(result.familiesLoaded).toBeGreaterThanOrEqual(0);
    expect(result.templatesLoaded).toBeGreaterThanOrEqual(0);
    expect(result.memoriesLoaded).toBeGreaterThanOrEqual(0);
  });
});
