/**
 * Seed profiles — 代表的なファイル種別の仮置き定義。
 * 「仮」であることを provisional: true で明示。
 * 将来、管理画面や設定ファイルから追加・編集可能にする想定。
 */

import type { FileProfile } from './types.js';

export const SEED_PROFILES: FileProfile[] = [
  {
    id: 'customer-list',
    label: '顧客一覧',
    filenameHints: ['顧客*', '*顧客*', 'customer*', '*customer*'],
    defaultEncoding: 'cp932',
    defaultHasHeader: true,
    columns: [
      { position: 0, label: '顧客番号', key: 'customer_id', required: true, rule: '数字', headerHints: ['顧客番号', '顧客ID', 'ID'] },
      { position: 1, label: '会社名', key: 'company_name', required: true, headerHints: ['会社名', '法人名', '企業名'] },
      { position: 2, label: '担当者名', key: 'contact_name', required: false, headerHints: ['担当者名', '氏名', '名前'] },
      { position: 3, label: '電話番号', key: 'phone', required: false, rule: '半角数字・ハイフン', headerHints: ['電話番号', 'TEL', 'tel'] },
      { position: 4, label: 'メールアドレス', key: 'email', required: false, rule: 'メール形式', headerHints: ['メール', 'email', 'Email'] },
      { position: 5, label: '住所', key: 'address', required: false, headerHints: ['住所', '所在地'] },
    ],
    previewColumns: [0, 1, 2, 3],
    category: '顧客管理系',
    provisional: true,
  },
  {
    id: 'apo-list',
    label: 'アポイント一覧',
    filenameHints: ['apo*', 'アポ*', '*アポ*', '*apo*'],
    defaultEncoding: 'cp932',
    defaultHasHeader: true,
    columns: [
      { position: 0, label: '日付', key: 'appointment_date', required: true, rule: '日付形式', headerHints: ['日付', '予定日', 'アポ日'] },
      { position: 1, label: '会社名', key: 'company_name', required: true, headerHints: ['会社名', '法人名'] },
      { position: 2, label: '担当者名', key: 'contact_name', required: false, headerHints: ['担当者', '氏名'] },
      { position: 3, label: '電話番号', key: 'phone', required: false, rule: '半角数字・ハイフン', headerHints: ['電話番号', 'TEL'] },
      { position: 4, label: '結果', key: 'result', required: false, headerHints: ['結果', 'ステータス', '状況'] },
      { position: 5, label: '備考', key: 'notes', required: false, headerHints: ['備考', 'メモ', 'ノート'] },
    ],
    previewColumns: [0, 1, 2, 4],
    category: 'アポリスト系',
    provisional: true,
  },
  {
    id: 'call-history',
    label: 'コール履歴',
    filenameHints: ['call*', 'コール*', '*コール*', '*call*', '架電*'],
    defaultEncoding: 'cp932',
    defaultHasHeader: true,
    columns: [
      { position: 0, label: '日時', key: 'call_datetime', required: true, rule: '日時形式', headerHints: ['日時', '架電日', 'コール日'] },
      { position: 1, label: '電話番号', key: 'phone', required: true, rule: '半角数字・ハイフン', headerHints: ['電話番号', 'TEL'] },
      { position: 2, label: '会社名', key: 'company_name', required: false, headerHints: ['会社名', '法人名'] },
      { position: 3, label: '担当者名', key: 'contact_name', required: false, headerHints: ['担当者', '氏名'] },
      { position: 4, label: '結果', key: 'result', required: false, headerHints: ['結果', 'ステータス'] },
      { position: 5, label: '備考', key: 'notes', required: false, headerHints: ['備考', 'メモ'] },
    ],
    previewColumns: [0, 1, 2, 4],
    category: 'コール履歴系',
    provisional: true,
  },
  {
    id: 'visit-history',
    label: '訪問履歴',
    filenameHints: ['visit*', '訪問*', '*訪問*', '*visit*'],
    defaultEncoding: 'cp932',
    defaultHasHeader: true,
    columns: [
      { position: 0, label: '訪問日', key: 'visit_date', required: true, rule: '日付形式', headerHints: ['訪問日', '日付', '実施日'] },
      { position: 1, label: '会社名', key: 'company_name', required: true, headerHints: ['会社名', '法人名'] },
      { position: 2, label: '担当者名', key: 'contact_name', required: false, headerHints: ['担当者', '氏名'] },
      { position: 3, label: '訪問者', key: 'visitor', required: false, headerHints: ['訪問者', '営業担当'] },
      { position: 4, label: '結果', key: 'result', required: false, headerHints: ['結果', '報告'] },
      { position: 5, label: '備考', key: 'notes', required: false, headerHints: ['備考', 'メモ'] },
    ],
    previewColumns: [0, 1, 2, 4],
    category: '訪問履歴系',
    provisional: true,
  },
];
