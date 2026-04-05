import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/defaults.js';
import { analyzeSourceRouting } from '../../src/core/source-routing.js';

describe('source routing', () => {
  it('顧客管理系ファイルは profile inference で mainline に寄せる', () => {
    const config = loadConfig();
    const decision = analyzeSourceRouting(
      '260312_太陽光顧客_全件.xlsx',
      ['お客様ID', '契約者', '住所', '電話番号', '営業担当'],
      config,
    );

    expect(decision.mode).toBe('mainline');
    expect(decision.reasonCode).toBe('profile_inference');
    expect(decision.matchedProfileId).toBe('customer-list');
    expect(decision.mixedParentChildExport).toBe(false);
    expect(decision.recommendedRecordFamily).toBe('customer_master_like');
  });

  it('customer master + child history columns は mixed parent-child export として記録する', () => {
    const config = loadConfig();
    const decision = analyzeSourceRouting(
      '260312_太陽光顧客_全件.xlsx',
      ['お客様ID', '契約者', '住所', '電話番号', '営業担当', 'ｺｰﾙ履歴::日付', 'ｺｰﾙ履歴::内容'],
      config,
    );

    expect(decision.mode).toBe('mainline');
    expect(decision.hasChildColumns).toBe(true);
    expect(decision.childColumnCount).toBe(2);
    expect(decision.mixedParentChildExport).toBe(true);
    expect(decision.reason).toContain('親子混在');
  });
});
