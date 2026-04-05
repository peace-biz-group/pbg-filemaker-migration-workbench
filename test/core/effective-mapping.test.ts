import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildEffectiveMapping,
  reconcileColumnReviews,
  saveEffectiveMapping,
  loadEffectiveMapping,
  findEffectiveMappings,
} from '../../src/core/effective-mapping.js';
import type { ColumnReviewEntry, ColumnDef } from '../../src/file-profiles/types.js';

const TMP_DIR = join(import.meta.dirname, '..', 'output-effective-mapping-test');

describe('buildEffectiveMapping', () => {
  // --- inUse 分岐のテスト ---

  it('inUse=yes の列を mapping に含める', () => {
    const reviews: ColumnReviewEntry[] = [
      { position: 0, label: '会社名', key: 'company_name', meaning: '取引先', inUse: 'yes', required: 'yes', rule: '' },
      { position: 1, label: '電話番号', key: 'phone', meaning: '', inUse: 'yes', required: 'no', rule: '' },
    ];
    const result = buildEffectiveMapping('run-001', 'test-profile', reviews);

    expect(result.mapping['会社名']).toBe('company_name');
    expect(result.mapping['電話番号']).toBe('phone');
    expect(result.activeCount).toBe(2);
    expect(result.unusedCount).toBe(0);
    expect(result.pendingCount).toBe(0);
  });

  it('inUse=no の列は mapping から除外する', () => {
    const reviews: ColumnReviewEntry[] = [
      { position: 0, label: '顧客名', key: 'customer_name', meaning: '', inUse: 'yes', required: 'yes', rule: '' },
      { position: 1, label: '旧フラグ', key: 'old_flag', meaning: '使わない', inUse: 'no', required: 'no', rule: '' },
    ];
    const result = buildEffectiveMapping('run-001', 'test-profile', reviews);

    expect(result.mapping['顧客名']).toBe('customer_name');
    expect(result.mapping['旧フラグ']).toBeUndefined();
    expect(result.unusedCount).toBe(1);
    expect(result.columns.find(c => c.sourceHeader === '旧フラグ')?.status).toBe('unused');
  });

  it('inUse=unknown は fail-closed で pending にする（canonical に昇格させない）', () => {
    const reviews: ColumnReviewEntry[] = [
      { position: 0, label: '謎の列', key: 'unknown_col', meaning: '', inUse: 'unknown', required: 'unknown', rule: '' },
    ];
    const result = buildEffectiveMapping('run-001', 'test-profile', reviews);

    expect(result.mapping['謎の列']).toBeUndefined();
    expect(result.pendingCount).toBe(1);
    expect(result.columns[0].status).toBe('pending');
  });

  it('混在パターン: yes/no/unknown が正しく集計される', () => {
    const reviews: ColumnReviewEntry[] = [
      { position: 0, label: '会社名', key: 'company_name', meaning: '', inUse: 'yes', required: 'yes', rule: '' },
      { position: 1, label: '電話番号', key: 'phone', meaning: '', inUse: 'yes', required: 'no', rule: '' },
      { position: 2, label: '不要な列', key: 'old', meaning: '', inUse: 'no', required: 'no', rule: '' },
      { position: 3, label: '不明な列', key: '', meaning: '', inUse: 'unknown', required: 'unknown', rule: '' },
    ];
    const result = buildEffectiveMapping('run-002', 'prof', reviews);

    expect(result.activeCount).toBe(2);
    expect(result.unusedCount).toBe(1);
    expect(result.pendingCount).toBe(1);
    expect(Object.keys(result.mapping)).toHaveLength(2);
  });

  // --- known file (profileDef あり) ---

  it('known file: profileDef がある場合に profile の key を使う', () => {
    const profileDef: ColumnDef[] = [
      { position: 0, label: '氏名', key: 'customer_name', required: true, headerHints: ['顧客名', '氏名'] },
      { position: 1, label: '電話', key: 'phone', required: false },
    ];
    const reviews: ColumnReviewEntry[] = [
      { position: 0, label: '顧客名', key: 'customer_name', meaning: '', inUse: 'yes', required: 'yes', rule: '' },
      { position: 1, label: '電話番号', key: 'phone', meaning: '', inUse: 'yes', required: 'no', rule: '' },
    ];
    const result = buildEffectiveMapping('run-003', 'customer-list', reviews, profileDef);

    expect(result.mapping['顧客名']).toBe('customer_name');
    expect(result.mapping['電話番号']).toBe('phone');
  });

  it('known file: review.key が空で根拠がない場合は fail-closed で pending にする', () => {
    const reviews: ColumnReviewEntry[] = [
      { position: 0, label: '商品コード', key: '', meaning: '', inUse: 'yes', required: 'yes', rule: '' },
    ];
    const result = buildEffectiveMapping('run-004', 'new', reviews);

    expect(result.mapping['商品コード']).toBeUndefined();
    expect(result.pendingCount).toBe(1);
  });

  // --- new file (profileDef なし) ---

  it('new file: profileDef なしでも列レビューから mapping を生成できる', () => {
    const reviews: ColumnReviewEntry[] = [
      { position: 0, label: '氏名', key: 'customer_name', meaning: '顧客の氏名', inUse: 'yes', required: 'yes', rule: '' },
      { position: 1, label: 'メール', key: 'email', meaning: '', inUse: 'yes', required: 'no', rule: '' },
      { position: 2, label: '備考', key: '', meaning: '', inUse: 'unknown', required: 'unknown', rule: '' },
    ];
    const result = buildEffectiveMapping('run-005', 'new', reviews);

    expect(result.mapping['氏名']).toBe('customer_name');
    expect(result.mapping['メール']).toBe('email');
    expect(result.mapping['備考']).toBeUndefined();
    expect(result.activeCount).toBe(2);
    expect(result.pendingCount).toBe(1);
  });

  // --- label（表示ラベル）の優先順位 ---

  it('label: meaning > profileDef.label > sourceHeader の順で使う', () => {
    const profileDef: ColumnDef[] = [
      { position: 0, label: 'プロファイルのラベル', key: 'col', required: false },
    ];
    const reviews: ColumnReviewEntry[] = [
      { position: 0, label: 'CSVヘッダー', key: 'col', meaning: 'ユーザーの意味', inUse: 'yes', required: 'no', rule: '' },
    ];
    const result = buildEffectiveMapping('run-006', 'prof', reviews, profileDef);
    expect(result.columns[0].label).toBe('ユーザーの意味');
  });

  it('label: meaning 空の場合は profileDef.label を使う', () => {
    const profileDef: ColumnDef[] = [
      { position: 0, label: 'プロファイルのラベル', key: 'col', required: false },
    ];
    const reviews: ColumnReviewEntry[] = [
      { position: 0, label: 'CSVヘッダー', key: 'col', meaning: '', inUse: 'yes', required: 'no', rule: '' },
    ];
    const result = buildEffectiveMapping('run-007', 'prof', reviews, profileDef);
    expect(result.columns[0].label).toBe('プロファイルのラベル');
  });

  it('columns は position 順にソートされる', () => {
    const reviews: ColumnReviewEntry[] = [
      { position: 2, label: 'C', key: 'c', meaning: '', inUse: 'yes', required: 'no', rule: '' },
      { position: 0, label: 'A', key: 'a', meaning: '', inUse: 'yes', required: 'no', rule: '' },
      { position: 1, label: 'B', key: 'b', meaning: '', inUse: 'no', required: 'no', rule: '' },
    ];
    const result = buildEffectiveMapping('run-008', 'prof', reviews);
    expect(result.columns.map(c => c.position)).toEqual([0, 1, 2]);
  });

  it('空の reviews で空の mapping を生成する', () => {
    const result = buildEffectiveMapping('run-000', 'prof', []);
    expect(result.mapping).toEqual({});
    expect(result.activeCount).toBe(0);
    expect(result.columns).toHaveLength(0);
  });

  it('same raw + same schema でも危険な position 起点の誤マッピングを pending に落とす', () => {
    const profileDef: ColumnDef[] = [
      { position: 0, label: '日時', key: 'call_datetime', required: true, headerHints: ['日時', '架電日', 'コール日'] },
      { position: 1, label: '電話番号', key: 'phone', required: true, headerHints: ['電話番号', 'TEL'] },
      { position: 2, label: '会社名', key: 'company_name', required: false, headerHints: ['会社名', '法人名'] },
      { position: 3, label: '担当者名', key: 'contact_name', required: false, headerHints: ['担当者', '氏名'] },
      { position: 4, label: '結果', key: 'result', required: false, headerHints: ['結果', 'ステータス'] },
      { position: 5, label: '備考', key: 'notes', required: false, headerHints: ['備考', 'メモ'] },
    ];
    const badReviews: ColumnReviewEntry[] = [
      { position: 0, label: '<テーブルが見つかりません>', key: 'call_datetime', meaning: '日時', inUse: 'yes', required: 'yes', rule: '' },
      { position: 1, label: '日付', key: 'phone', meaning: '電話番号', inUse: 'yes', required: 'yes', rule: '' },
      { position: 2, label: '時刻', key: 'company_name', meaning: '会社名', inUse: 'yes', required: 'yes', rule: '' },
      { position: 3, label: '担当者', key: 'contact_name', meaning: '担当者名', inUse: 'yes', required: 'yes', rule: '' },
      { position: 4, label: '電話番号【検索】', key: 'result', meaning: '結果', inUse: 'yes', required: 'yes', rule: '' },
      { position: 5, label: '内容', key: 'notes', meaning: '備考', inUse: 'yes', required: 'yes', rule: '' },
      { position: 6, label: '日時', key: '', meaning: '', inUse: 'yes', required: 'yes', rule: '' },
    ];

    const result = buildEffectiveMapping('run-call', 'call-history', badReviews, profileDef);

    expect(result.mapping['<テーブルが見つかりません>']).toBeUndefined();
    expect(result.mapping['日付']).toBeUndefined();
    expect(result.mapping['時刻']).toBeUndefined();
    expect(result.mapping['担当者']).toBe('contact_name');
    expect(result.mapping['電話番号【検索】']).toBe('phone');
    expect(result.mapping['内容']).toBe('notes');
    expect(result.mapping['日時']).toBe('call_datetime');
    expect(result.mapping['お客様担当']).toBeUndefined();
    expect(result.pendingCount).toBe(3);
  });

  it('actualColumns を使って source header を run の列順へ補正する', () => {
    const reviews: ColumnReviewEntry[] = [
      { position: 1, label: '古い列名', key: 'phone', meaning: '電話番号', inUse: 'yes', required: 'yes', rule: '' },
      { position: 0, label: '別名', key: 'company_name', meaning: '会社名', inUse: 'yes', required: 'yes', rule: '' },
    ];

    const reconciled = reconcileColumnReviews(reviews, {
      actualColumns: ['会社名', '電話番号【検索】'],
      profileDef: null,
    });

    expect(reconciled.map((r) => r.label)).toEqual(['会社名', '電話番号【検索】']);
    expect(reconciled[0]?.key).toBe('company_name');
    expect(reconciled[1]?.key).toBe('phone');
  });
});

// --- 永続化のテスト ---

describe('effective mapping persistence', () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('保存して読み込める', () => {
    const reviews: ColumnReviewEntry[] = [
      { position: 0, label: '会社名', key: 'company_name', meaning: '', inUse: 'yes', required: 'yes', rule: '' },
    ];
    const result = buildEffectiveMapping('run-save-01', 'customer-list', reviews);
    saveEffectiveMapping(TMP_DIR, result);

    const loaded = loadEffectiveMapping(TMP_DIR, 'run-save-01', 'customer-list');
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe('run-save-01');
    expect(loaded!.profileId).toBe('customer-list');
    expect(loaded!.mapping['会社名']).toBe('company_name');
    expect(loaded!.activeCount).toBe(1);
  });

  it('存在しない mapping は null を返す', () => {
    const result = loadEffectiveMapping(TMP_DIR, 'nonexistent', 'nonexistent');
    expect(result).toBeNull();
  });

  it('findEffectiveMappings で runId に紐づく複数の mapping を取得できる', () => {
    const r1 = buildEffectiveMapping('run-find-01', 'profile-a', [
      { position: 0, label: 'col1', key: 'key1', meaning: '', inUse: 'yes', required: 'no', rule: '' },
    ]);
    const r2 = buildEffectiveMapping('run-find-01', 'profile-b', [
      { position: 0, label: 'col2', key: 'key2', meaning: '', inUse: 'yes', required: 'no', rule: '' },
    ]);
    // 別の runId
    const r3 = buildEffectiveMapping('run-find-02', 'profile-a', []);

    saveEffectiveMapping(TMP_DIR, r1);
    saveEffectiveMapping(TMP_DIR, r2);
    saveEffectiveMapping(TMP_DIR, r3);

    const found = findEffectiveMappings(TMP_DIR, 'run-find-01');
    expect(found).toHaveLength(2);
    expect(found.map(r => r.profileId).sort()).toEqual(['profile-a', 'profile-b']);
  });

  it('ディレクトリが存在しない場合 findEffectiveMappings は空配列を返す', () => {
    const found = findEffectiveMappings(TMP_DIR + '/nonexistent', 'run-xyz');
    expect(found).toEqual([]);
  });

  it('上書き保存が正しく機能する', () => {
    const r1 = buildEffectiveMapping('run-overwrite', 'prof', [
      { position: 0, label: 'col', key: 'old_key', meaning: '', inUse: 'yes', required: 'no', rule: '' },
    ]);
    saveEffectiveMapping(TMP_DIR, r1);

    const r2 = buildEffectiveMapping('run-overwrite', 'prof', [
      { position: 0, label: 'col', key: 'new_key', meaning: '', inUse: 'yes', required: 'no', rule: '' },
    ]);
    saveEffectiveMapping(TMP_DIR, r2);

    const loaded = loadEffectiveMapping(TMP_DIR, 'run-overwrite', 'prof');
    expect(loaded!.mapping['col']).toBe('new_key');
  });
});

// --- 実際の接続シナリオのスモークテスト ---

describe('buildEffectiveMapping integration smoke', () => {
  it('正規化 mapping として直接 applyColumnMapping に渡せる形になっている', async () => {
    const { applyColumnMapping } = await import('../../src/core/column-mapper.js');

    const reviews: ColumnReviewEntry[] = [
      { position: 0, label: '顧客名', key: 'customer_name', meaning: '', inUse: 'yes', required: 'yes', rule: '' },
      { position: 1, label: '電話番号', key: 'phone', meaning: '', inUse: 'yes', required: 'no', rule: '' },
      { position: 2, label: '不要列', key: 'old', meaning: '', inUse: 'no', required: 'no', rule: '' },
    ];
    const result = buildEffectiveMapping('run-smoke', 'prof', reviews);

    // mapping を applyColumnMapping に直接渡す
    const record = { '顧客名': '田中太郎', '電話番号': '03-1234-5678', '不要列': 'xxx' };
    const mapped = applyColumnMapping(record, result.mapping);

    expect(mapped['customer_name']).toBe('田中太郎');
    expect(mapped['phone']).toBe('03-1234-5678');
    // 不要列は mapping に含まれないのでオリジナルのキー名のまま
    expect(mapped['不要列']).toBe('xxx');
  });
});
