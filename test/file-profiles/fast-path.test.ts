import { describe, it, expect } from 'vitest';
import { canUseFastPath, buildAutoReviews } from '../../src/file-profiles/fast-path.js';
import type { FileProfile, ColumnDef } from '../../src/file-profiles/types.js';

const makeProfile = (overrides: Partial<FileProfile> = {}): FileProfile => ({
  id: 'test-profile',
  label: 'テスト',
  filenameHints: ['test*'],
  defaultEncoding: 'cp932',
  defaultHasHeader: true,
  columns: [
    { position: 0, label: '会社名', key: 'company_name', required: true },
    { position: 1, label: '電話番号', key: 'phone', required: false },
    { position: 2, label: '担当者', key: 'contact', required: false, rule: '姓名' },
  ],
  previewColumns: [0, 1],
  category: 'テスト',
  provisional: false,
  ...overrides,
});

describe('canUseFastPath', () => {
  it('high confidence + profile あり → eligible', () => {
    const result = canUseFastPath('high', makeProfile());
    expect(result.eligible).toBe(true);
  });

  it('medium confidence → not eligible', () => {
    const result = canUseFastPath('medium', makeProfile());
    expect(result.eligible).toBe(false);
  });

  it('high confidence でも profile null → not eligible', () => {
    const result = canUseFastPath('high', null);
    expect(result.eligible).toBe(false);
  });

  it('none confidence → not eligible', () => {
    const result = canUseFastPath('none', makeProfile());
    expect(result.eligible).toBe(false);
  });

  it('low confidence → not eligible', () => {
    const result = canUseFastPath('low', makeProfile());
    expect(result.eligible).toBe(false);
  });
});

describe('buildAutoReviews', () => {
  const profileCols: ColumnDef[] = [
    { position: 0, label: '会社名', key: 'company_name', required: true },
    { position: 1, label: '電話番号', key: 'phone', required: false },
    { position: 2, label: '担当者', key: 'contact', required: false, rule: '姓名' },
  ];

  it('profile の列数と同じ数の review を返す', () => {
    const reviews = buildAutoReviews(profileCols, ['会社名', '電話番号', '担当者']);
    expect(reviews.length).toBe(3);
  });

  it('全て inUse=yes を設定する', () => {
    const reviews = buildAutoReviews(profileCols, ['会社名', '電話番号', '担当者']);
    for (const r of reviews) {
      expect(r.inUse).toBe('yes');
    }
  });

  it('required な列は required=yes を設定する', () => {
    const reviews = buildAutoReviews(profileCols, ['会社名', '電話番号', '担当者']);
    expect(reviews[0].required).toBe('yes'); // 会社名
    expect(reviews[1].required).toBe('no'); // 電話番号
  });

  it('label には実際の CSV 列名（actualColumns[position]）を使う', () => {
    const reviews = buildAutoReviews(profileCols, ['CompanyName', 'Tel', 'Person']);
    expect(reviews[0].label).toBe('CompanyName');
    expect(reviews[1].label).toBe('Tel');
  });

  it('actualColumns が短い場合、profile のラベルにフォールバック', () => {
    const reviews = buildAutoReviews(profileCols, ['会社名']); // 1列だけ
    expect(reviews[0].label).toBe('会社名');
    expect(reviews[1].label).toBe('電話番号'); // profile.label にフォールバック
  });

  it('key には profile の key を使う', () => {
    const reviews = buildAutoReviews(profileCols, ['会社名', '電話番号', '担当者']);
    expect(reviews[0].key).toBe('company_name');
    expect(reviews[1].key).toBe('phone');
  });

  it('rule が設定されている場合はそれを使う', () => {
    const reviews = buildAutoReviews(profileCols, ['会社名', '電話番号', '担当者']);
    expect(reviews[2].rule).toBe('姓名');
    expect(reviews[0].rule).toBe('');
  });

  it('ヘッダーなし CSV の位置ベース列名でも動作する', () => {
    const reviews = buildAutoReviews(profileCols, ['col_1', 'col_2', 'col_3']);
    expect(reviews[0].label).toBe('col_1');
    expect(reviews[0].key).toBe('company_name');
    expect(reviews[0].inUse).toBe('yes');
  });
});
