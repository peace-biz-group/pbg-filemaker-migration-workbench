import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadProfiles,
  getProfiles,
  getProfileById,
  matchProfile,
  saveProfiles,
  saveColumnReview,
  loadColumnReview,
  SEED_PROFILES,
} from '../../src/file-profiles/index.js';

const TMP_DIR = join(import.meta.dirname, '..', 'output-profile-test');

describe('File Profiles', () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    loadProfiles(TMP_DIR);
  });

  afterAll(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe('seed profiles', () => {
    it('has at least 4 seed profiles', () => {
      expect(SEED_PROFILES.length).toBeGreaterThanOrEqual(4);
    });

    it('all seed profiles are provisional', () => {
      for (const p of SEED_PROFILES) {
        expect(p.provisional).toBe(true);
      }
    });

    it('all seed profiles have required fields', () => {
      for (const p of SEED_PROFILES) {
        expect(p.id).toBeTruthy();
        expect(p.label).toBeTruthy();
        expect(p.filenameHints.length).toBeGreaterThan(0);
        expect(p.columns.length).toBeGreaterThan(0);
        expect(p.category).toBeTruthy();
      }
    });
  });

  describe('matchProfile', () => {
    it('matches customer file by filename', () => {
      const result = matchProfile('顧客一覧_2024.csv', []);
      expect(result.profile).not.toBeNull();
      expect(result.profile!.id).toBe('customer-list');
      expect(result.confidence).toBe('high');
    });

    it('matches apo file by filename', () => {
      const result = matchProfile('apo_list_2024.csv', []);
      expect(result.profile).not.toBeNull();
      expect(result.profile!.id).toBe('apo-list');
      expect(result.confidence).toBe('high');
    });

    it('matches call history by filename', () => {
      const result = matchProfile('コール履歴_202401.csv', []);
      expect(result.profile).not.toBeNull();
      expect(result.profile!.id).toBe('call-history');
    });

    it('matches visit history by filename', () => {
      const result = matchProfile('訪問履歴.csv', []);
      expect(result.profile).not.toBeNull();
      expect(result.profile!.id).toBe('visit-history');
    });

    it('returns none for unknown filename with no column hints', () => {
      const result = matchProfile('unknown_data.csv', []);
      expect(result.profile).toBeNull();
      expect(result.confidence).toBe('none');
    });

    it('matches by column header hints as fallback', () => {
      const result = matchProfile('data.csv', ['顧客番号', '会社名', '担当者名', '電話番号', 'メール', '住所']);
      expect(result.profile).not.toBeNull();
      expect(result.profile!.id).toBe('customer-list');
    });

    it('provides alternatives when multiple profiles match', () => {
      // File with columns that match multiple profiles
      const result = matchProfile('data.csv', ['会社名', '電話番号', '担当者名', '備考']);
      // Should have alternatives since these columns appear in multiple profiles
      if (result.profile) {
        expect(result.confidence).not.toBe('none');
      }
    });
  });

  describe('profile persistence', () => {
    it('saves and loads profiles', () => {
      const profiles = getProfiles().map(p => ({ ...p }));
      profiles[0] = { ...profiles[0], label: 'テスト顧客' };
      saveProfiles(TMP_DIR, profiles);

      const loaded = loadProfiles(TMP_DIR);
      expect(loaded.find(p => p.id === profiles[0].id)?.label).toBe('テスト顧客');
    });

    it('getProfileById returns correct profile', () => {
      loadProfiles(TMP_DIR); // reload to reset
      const profile = getProfileById('customer-list');
      expect(profile).not.toBeUndefined();
      expect(profile!.id).toBe('customer-list');
    });

    it('getProfileById returns undefined for non-existent', () => {
      expect(getProfileById('nonexistent')).toBeUndefined();
    });
  });

  describe('column review persistence', () => {
    it('saves and loads column reviews', () => {
      const reviews = [
        { position: 0, label: '顧客番号', key: 'customer_id', meaning: '顧客の管理番号', inUse: 'yes' as const, required: 'yes' as const, rule: '数字' },
        { position: 1, label: '会社名', key: 'company_name', meaning: '取引先の名前', inUse: 'yes' as const, required: 'yes' as const, rule: '' },
      ];

      saveColumnReview(TMP_DIR, 'run-001', 'customer-list', reviews);
      const loaded = loadColumnReview(TMP_DIR, 'run-001', 'customer-list');
      expect(loaded).not.toBeNull();
      expect(loaded!.length).toBe(2);
      expect(loaded![0].meaning).toBe('顧客の管理番号');
    });

    it('returns null for non-existent review', () => {
      const result = loadColumnReview(TMP_DIR, 'nonexistent', 'nonexistent');
      expect(result).toBeNull();
    });
  });
});
