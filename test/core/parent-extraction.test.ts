import { describe, it, expect } from 'vitest';
import { extractParentFromMixedRecord, emptyParentExtractionSummary, accumulateParentExtraction } from '../../src/core/parent-extraction.js';
import type { SourceRoutingDecision } from '../../src/types/index.js';

function routing(): SourceRoutingDecision {
  return {
    mode: 'mainline',
    reasonCode: 'profile_inference',
    reason: 'customer-list 系として mainline 推定。FileMaker 親子混在 export の疑いあり',
    matchedProfileId: 'customer-list',
    matchedProfileLabel: '顧客一覧',
    matchedProfileConfidence: 'high',
    hasChildColumns: true,
    childColumnCount: 2,
    childColumnNames: ['ｺｰﾙ履歴::日付', 'ｺｰﾙ履歴::内容'],
    mixedParentChildExport: true,
    recommendedRecordFamily: 'customer_master_like',
  };
}

describe('parent extraction', () => {
  it('親属性が十分な行は parent_candidate にする', () => {
    const decision = extractParentFromMixedRecord({
      お客様ID: 'RC001',
      契約者: '田中太郎',
      住所: '東京都新宿区1-1-1',
      電話番号: '090-1111-2222',
      'ｺｰﾙ履歴::日付': '2024/03/01',
      'ｺｰﾙ履歴::内容': '初回連絡',
    }, routing());

    expect(decision.classification).toBe('parent_candidate');
    expect(decision.extractedCanonicalFields.customer_id).toBe('RC001');
    expect(decision.extractedCanonicalFields.customer_name).toBe('田中太郎');
    expect(decision.extractedCanonicalFields.phone).toBe('090-1111-2222');
    expect(decision.extractedCanonicalFields.address).toContain('東京都');
  });

  it('child continuation 行は child_continuation にする', () => {
    const decision = extractParentFromMixedRecord({
      お客様ID: '',
      契約者: '',
      住所: '',
      電話番号: '',
      'ｺｰﾙ履歴::日付': '2024/03/02',
      'ｺｰﾙ履歴::内容': '追い架電',
    }, routing());

    expect(decision.classification).toBe('child_continuation');
    expect(decision.reasonCode).toBe('child_columns_only');
  });

  it('親属性が弱い行は ambiguous_parent にする', () => {
    const decision = extractParentFromMixedRecord({
      契約者: '佐藤花子',
      'ｺｰﾙ履歴::日付': '2024/03/03',
      'ｺｰﾙ履歴::内容': '確認中',
    }, routing());

    expect(decision.classification).toBe('ambiguous_parent');
    expect(decision.extractedCanonicalFields.customer_name).toBe('佐藤花子');
  });

  it('集計に分類件数を反映できる', () => {
    const summary = emptyParentExtractionSummary();
    accumulateParentExtraction(summary, extractParentFromMixedRecord({
      お客様ID: 'RC001',
      契約者: '田中太郎',
      電話番号: '090-1111-2222',
      'ｺｰﾙ履歴::日付': '2024/03/01',
    }, routing()));
    accumulateParentExtraction(summary, extractParentFromMixedRecord({
      'ｺｰﾙ履歴::日付': '2024/03/02',
      'ｺｰﾙ履歴::内容': '追い架電',
    }, routing()));

    expect(summary.extractedParentCount).toBe(1);
    expect(summary.childContinuationCount).toBe(1);
    expect(summary.classificationBreakdown.parent_candidate).toBe(1);
    expect(summary.classificationBreakdown.child_continuation).toBe(1);
  });
});
