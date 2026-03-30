/**
 * Japanese UI label dictionaries for the local review UI.
 * Maps internal/technical identifiers to simple Japanese strings for end users.
 * Served via GET /api/labels endpoint.
 */

/** File type identifiers → Japanese display names */
export const FILE_TYPE_LABELS: Record<string, string> = {
  apo_list: 'アポリスト',
  customer_master: '顧客一覧',
  call_history: '電話履歴',
  visit_history: '訪問履歴',
  progress_management: '案件進行',
  estimate_product: '見積・商品',
  document_review: '書類・審査',
  mixed_unknown: 'よく分からない',
  // CandidateType values from classifier
  customer: '顧客',
  deal: '案件',
  transaction: '取引',
  activity: '対応履歴',
  quarantine: '確認が必要',
};

/** Review decision identifiers → Japanese display names */
export const DECISION_LABELS: Record<string, string> = {
  accepted: 'このままでよい',
  adjusted: '修正した',
  unknown: 'わからない',
  unused: '使わない',
};

/** Canonical/semantic field names → simple Japanese labels (for column review UI) */
export const SEMANTIC_FIELD_LABELS: Record<string, string> = {
  customer_name: 'お客様名',
  name: 'お客様名',
  company_name: '会社名',
  store_name: '店舗名',
  phone: '電話番号',
  mobile: '携帯番号',
  email: 'メール',
  address: '住所',
  staff: '担当者名',
  date: '日付',
  amount: '金額',
  note: 'メモ',
  document: '書類',
  status: '状況',
  unknown: 'わからない',
  unused: '使わない',
  // Common source column names that appear in FileMaker exports
  '氏名': 'お客様名',
  '名前': 'お客様名',
  '顧客名': 'お客様名',
  '電話番号': '電話番号',
  '携帯番号': '携帯番号',
  '住所': '住所',
  'メールアドレス': 'メール',
  '担当者名': '担当者名',
  '会社名': '会社名',
  '店舗名': '店舗名',
};

/** Template match reason keys → Japanese explanations */
export const MATCH_REASON_LABELS: Record<string, string> = {
  filename: 'ファイル名が近いです',
  schema_fingerprint: '前に使った列と同じです',
  column_overlap: '前に使った形と似ています',
  column_count: '列の数が近いです',
  encoding: '文字コードが同じです',
  header: 'ヘッダの形が同じです',
};

/** Encoding option labels */
export const ENCODING_LABELS: Record<string, string> = {
  auto: '自動検出',
  utf8: 'UTF-8',
  cp932: 'Shift-JIS (CP932)',
};

/** All label dictionaries combined for the /api/labels endpoint */
export const ALL_LABELS = {
  fileTypes: FILE_TYPE_LABELS,
  decisions: DECISION_LABELS,
  semanticFields: SEMANTIC_FIELD_LABELS,
  matchReasons: MATCH_REASON_LABELS,
  encodings: ENCODING_LABELS,
};
