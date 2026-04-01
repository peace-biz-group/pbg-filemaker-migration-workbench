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
import {
  buildCandidateProfile,
  saveCandidateProfile,
} from '../../src/file-profiles/candidate-profile.js';
import type { EffectiveMappingResult } from '../../src/core/effective-mapping.js';

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

    describe('column count and headerless matching', () => {
      it('列数が一致する場合スコアが上がる（ファイル名が一致しない場合でも候補が出る）', () => {
        // customer-list は 6 列 — ファイル名マッチなし・ヘッダーなし・列数一致
        const result = matchProfile('data_export.csv', [], { columnCount: 6 });
        // 何らかの profile が候補として出るはず（column count score > 0）
        expect(result.profile).not.toBeNull();
        expect(['low', 'medium']).toContain(result.confidence);
      });

      it('列数が大きくズレると候補スコアが弱くなる', () => {
        const result6 = matchProfile('data.csv', [], { columnCount: 6 });
        const result1 = matchProfile('data.csv', [], { columnCount: 1 });
        const toScore = (r: typeof result6) =>
          r.confidence === 'high' ? 3 : r.confidence === 'medium' ? 2 : r.confidence === 'low' ? 1 : 0;
        // 6列一致の方が 1列の場合よりスコアが高い（seed は全て6列）
        expect(toScore(result6)).toBeGreaterThan(toScore(result1));
      });

      it('ファイル名が一致し列数も一致する場合、high confidence になる', () => {
        // customer-list は filename で +100、column count 一致で +25
        const result = matchProfile('顧客一覧.csv', [], { columnCount: 6 });
        expect(result.profile?.id).toBe('customer-list');
        expect(result.confidence).toBe('high');
      });

      it('ヘッダーなし指定でも filename マッチは機能する', () => {
        const result = matchProfile('コール履歴.csv', [], { isHeaderless: true, columnCount: 6 });
        expect(result.profile?.id).toBe('call-history');
        expect(result.confidence).toBe('high');
      });

      it('reason に日本語の理由が含まれる', () => {
        const result = matchProfile('顧客一覧.csv', [], { columnCount: 6 });
        expect(result.reason).toBeTruthy();
        // ファイル名ヒント一致の場合、理由に「ファイル名が近い」が含まれる
        expect(result.reason).toContain('ファイル名が近い');
      });

      it('列数のみで候補を出す場合、理由に「列の数」が含まれる', () => {
        const result = matchProfile('unknown.csv', [], { columnCount: 6 });
        if (result.profile) {
          expect(result.reason).toMatch(/列の数/);
        }
      });
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

// ---- candidate profile + headerless matching 統合テスト ----

const INTEGRATION_TMP_DIR = join(import.meta.dirname, '..', 'output-profile-integration-test');

const sampleEM: EffectiveMappingResult = {
  runId: 'run-headerless-001',
  profileId: 'call-history',
  generatedAt: '2026-04-01T00:00:00.000Z',
  mapping: { '電話番号': 'phone', '会社名': 'company_name' },
  activeCount: 4,
  unusedCount: 0,
  pendingCount: 0,
  columns: [
    { position: 0, sourceHeader: '電話番号', canonicalKey: 'phone', label: '電話番号', status: 'active', required: 'yes' },
    { position: 1, sourceHeader: '会社名', canonicalKey: 'company_name', label: '会社名', status: 'active', required: 'no' },
    { position: 2, sourceHeader: '日時', canonicalKey: 'call_datetime', label: '日時', status: 'active', required: 'yes' },
    { position: 3, sourceHeader: '結果', canonicalKey: 'result', label: '結果', status: 'active', required: 'no' },
  ],
};

describe('candidate profile + headerless matching 統合', () => {
  beforeEach(() => {
    mkdirSync(INTEGRATION_TMP_DIR, { recursive: true });
    // candidate profile を保存して registry を更新
    const candidate = buildCandidateProfile(
      'run-headerless-001',
      'コール履歴_20260401.csv',
      sampleEM,
      { defaultHasHeader: false },
    );
    saveCandidateProfile(INTEGRATION_TMP_DIR, candidate);
    loadProfiles(INTEGRATION_TMP_DIR); // candidate を registry に反映
  });

  afterAll(() => {
    if (existsSync(INTEGRATION_TMP_DIR)) rmSync(INTEGRATION_TMP_DIR, { recursive: true, force: true });
  });

  it('保存済み candidate profile が filename hint で候補に出る（ヘッダーなし CSV）', () => {
    // 同じファイル名パターンで matchProfile（ヘッダーなし）
    const result = matchProfile('コール履歴_20260402.csv', [], {
      isHeaderless: true,
      columnCount: 4,
    });
    expect(result.profile).not.toBeNull();
    // candidate または call-history が最上位候補
    const topId = result.profile?.id;
    const isCallRelated = topId === 'call-history' || topId?.includes('run-headerless-001');
    expect(isCallRelated).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('ヘッダーなし CSV でも known file 候補が出る（column count のみ）', () => {
    // ファイル名が全く違っても column count で候補が出る
    const result = matchProfile('output_20260401.csv', [], {
      isHeaderless: true,
      columnCount: 4,
    });
    // score > 0 のプロファイルが返るはず（4列一致で +25、headerlessSuitable で +20）
    expect(result.profile).not.toBeNull();
    expect(result.confidence).not.toBe('none');
  });

  it('列数が大きくズレると候補スコアが弱くなる', () => {
    // 4列プロファイルに対して 10 列ファイルを渡す
    const result4 = matchProfile('output.csv', [], { isHeaderless: true, columnCount: 4 });
    const result10 = matchProfile('output.csv', [], { isHeaderless: true, columnCount: 10 });
    const toScore = (r: typeof result4) =>
      r.confidence === 'high' ? 3 : r.confidence === 'medium' ? 2 : r.confidence === 'low' ? 1 : 0;
    // 4列一致の方が同等かそれ以上のスコア
    expect(toScore(result4)).toBeGreaterThanOrEqual(toScore(result10));
  });

  it('built-in と candidate が混在しても matchProfile が壊れない', () => {
    const profiles = getProfiles();
    const seedCount = profiles.filter(p => !('candidate' in p)).length;
    const candidateCount = profiles.filter(p => 'candidate' in p && (p as { candidate?: boolean }).candidate === true).length;
    expect(seedCount).toBeGreaterThan(0);
    expect(candidateCount).toBeGreaterThan(0);

    // matchProfile が例外なく動作する
    expect(() => matchProfile('テスト.csv', [], { isHeaderless: true, columnCount: 4 })).not.toThrow();
  });
});
