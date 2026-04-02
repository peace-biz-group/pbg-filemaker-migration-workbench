import { describe, it, expect } from 'vitest';
import { loadProfiles, matchProfile } from '../../src/file-profiles/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('profile match regression', () => {
  it('太陽光顧客管理はアポイント一覧に寄りすぎない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'profile-match-'));
    try {
      loadProfiles(dir);
      const result = matchProfile('太陽光顧客管理_202604.csv', ['顧客ID', '会社名', '担当者名', '電話番号'], {
        isHeaderless: false,
        columnCount: 4,
      });
      expect(result.profile).toBeTruthy();
      expect(result.profile?.id).not.toBe('apo-list');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
