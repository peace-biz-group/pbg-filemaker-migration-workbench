import { describe, it, expect } from 'vitest';
import { suggestColumn, suggestAllColumns, suggestFileType } from '../../src/core/suggestion-engine.js';
import { profileFile } from '../../src/core/profiler.js';
import { loadConfig } from '../../src/config/defaults.js';
import { join } from 'node:path';
import type { ColumnProfile } from '../../src/types/index.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const APO_LIST = join(FIXTURES, 'apo_list_2024.csv');
const CONFIG_PATH = join(FIXTURES, 'test-batch.config.json');

function dummyProfile(name: string): ColumnProfile {
  return {
    name,
    totalCount: 10,
    nonEmptyCount: 8,
    missingRate: 0.2,
    uniqueCount: 5,
    topValues: [{ value: 'test', count: 3 }],
    anomalies: [],
  };
}

describe('Suggestion Engine', () => {
  const config = loadConfig(CONFIG_PATH);

  describe('suggestColumn', () => {
    it('suggests phone for 電話番号', () => {
      const result = suggestColumn('電話番号', dummyProfile('電話番号'), config, 'test.csv');
      expect(result.semanticField).toBe('phone');
      expect(result.fieldFamily).toBe('contact');
      expect(result.section).toBe('contact_info');
    });

    it('suggests email for メールアドレス', () => {
      const result = suggestColumn('メールアドレス', dummyProfile('メールアドレス'), config, 'test.csv');
      expect(result.semanticField).toBe('email');
      expect(result.fieldFamily).toBe('contact');
    });

    it('suggests customer_name for 顧客名', () => {
      const result = suggestColumn('顧客名', dummyProfile('顧客名'), config, 'test.csv');
      expect(result.semanticField).toBe('customer_name');
      expect(result.fieldFamily).toBe('identity');
    });

    it('suggests company_name for 会社名', () => {
      const result = suggestColumn('会社名', dummyProfile('会社名'), config, 'test.csv');
      expect(result.semanticField).toBe('company_name');
      expect(result.fieldFamily).toBe('company_store');
    });

    it('suggests notes for メモ', () => {
      const result = suggestColumn('メモ', dummyProfile('メモ'), config, 'test.csv');
      expect(result.semanticField).toBe('notes');
      expect(result.fieldFamily).toBe('notes');
    });

    it('falls back to raw_extra for unknown columns', () => {
      const result = suggestColumn('xyz_unknown_col', dummyProfile('xyz_unknown_col'), config, 'test.csv');
      expect(result.fieldFamily).toBe('raw_extra');
      expect(result.section).toBe('raw_extra_info');
      expect(result.confidence).toBe('low');
    });

    it('uses existing columnMappings when file pattern matches', () => {
      const result = suggestColumn('顧客名', dummyProfile('顧客名'), config, 'apo_list_2024.csv');
      expect(result.semanticField).toBe('customer_name');
      expect(result.confidence).toBe('high');
      expect(result.reason).toContain('既存マッピング');
    });

    it('detects phone from value patterns', () => {
      const profile: ColumnProfile = {
        name: 'unknown_col',
        totalCount: 10,
        nonEmptyCount: 10,
        missingRate: 0,
        uniqueCount: 8,
        topValues: [
          { value: '090-1234-5678', count: 2 },
          { value: '03-1234-5678', count: 2 },
          { value: '080-9999-0000', count: 1 },
        ],
        anomalies: [],
      };
      const result = suggestColumn('unknown_col', profile, config, 'test.csv');
      expect(result.semanticField).toBe('phone');
      expect(result.fieldFamily).toBe('contact');
    });
  });

  describe('suggestAllColumns', () => {
    it('generates suggestions for all columns from apo_list', async () => {
      const profile = await profileFile(APO_LIST, config);
      const reviews = suggestAllColumns(profile.columns, config, APO_LIST);

      expect(reviews.length).toBe(profile.columnCount);
      // Every review should have sampleValues and a suggestion
      for (const r of reviews) {
        expect(r.suggestion).toBeDefined();
        expect(r.suggestion.fieldFamily).toBeTruthy();
        expect(r.decision).toBe('unknown');
      }
    });
  });

  describe('suggestFileType', () => {
    it('suggests apo_list for apo-like columns', async () => {
      const profile = await profileFile(APO_LIST, config);
      const reviews = suggestAllColumns(profile.columns, config, APO_LIST);
      const result = suggestFileType(reviews);
      expect(result.fileType).toBe('apo_list');
    });
  });
});
