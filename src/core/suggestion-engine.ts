/**
 * Column suggestion engine — heuristic mapper from source column names to semantic fields.
 * Uses keyword matching + value pattern analysis. No LLM, no network.
 */

import type { ColumnProfile } from '../types/index.js';
import type { WorkbenchConfig } from '../config/schema.js';
import type {
  FieldFamily,
  Section,
  ColumnSuggestion,
  ColumnReview,
} from '../types/review.js';
import { basename } from 'node:path';

// --- fieldFamily → default section mapping ---

const FAMILY_TO_SECTION: Record<FieldFamily, Section> = {
  identity: 'basic_info',
  contact: 'contact_info',
  customer_basic: 'basic_info',
  company_store: 'basic_info',
  source_list: 'source_info',
  sales_activity: 'activity_history',
  visit_schedule: 'visit_info',
  progress: 'progress_info',
  estimate: 'estimate_product_info',
  product: 'estimate_product_info',
  finance_review: 'finance_review_info',
  documents: 'document_info',
  cost: 'cost_info',
  notes: 'notes_info',
  metadata: 'system_info',
  raw_extra: 'raw_extra_info',
};

// --- Suggestion rules ---

interface SuggestionRule {
  patterns: RegExp[];
  semanticField: string;
  fieldFamily: FieldFamily;
  confidence: 'high' | 'medium' | 'low';
}

const RULES: SuggestionRule[] = [
  // Identity
  { patterns: [/^(顧客名|customer_name|氏名|名前|担当者名|担当者|name)$/i], semanticField: 'customer_name', fieldFamily: 'identity', confidence: 'high' },

  // Contact
  { patterns: [/^(電話番号|phone|tel|TEL|携帯|携帯電話|連絡先)$/i, /phone|tel/i], semanticField: 'phone', fieldFamily: 'contact', confidence: 'high' },
  { patterns: [/^(メールアドレス|メール|email|mail|Eメール|e-mail)$/i, /mail|メール/i], semanticField: 'email', fieldFamily: 'contact', confidence: 'high' },
  { patterns: [/^(FAX|ファックス|fax番号)$/i], semanticField: 'fax', fieldFamily: 'contact', confidence: 'medium' },

  // Company / Store
  { patterns: [/^(会社名|company|company_name|法人名|企業名)$/i, /会社|法人|企業|company/i], semanticField: 'company_name', fieldFamily: 'company_store', confidence: 'high' },
  { patterns: [/^(店舗名|store|store_name|支店|支店名|営業所)$/i, /店舗|支店|営業所|store/i], semanticField: 'store_name', fieldFamily: 'company_store', confidence: 'high' },

  // Address
  { patterns: [/^(住所|address|所在地|郵便番号|〒)$/i, /住所|所在地|address/i], semanticField: 'address', fieldFamily: 'contact', confidence: 'high' },
  { patterns: [/^(都道府県|prefecture)$/i], semanticField: 'prefecture', fieldFamily: 'contact', confidence: 'medium' },
  { patterns: [/^(市区町村|city)$/i], semanticField: 'city', fieldFamily: 'contact', confidence: 'medium' },

  // Sales activity
  { patterns: [/^(対応日|activity_date|対応日時|活動日)$/i], semanticField: 'activity_date', fieldFamily: 'sales_activity', confidence: 'high' },
  { patterns: [/^(対応種別|activity_type|対応区分|活動種別)$/i], semanticField: 'activity_type', fieldFamily: 'sales_activity', confidence: 'high' },
  { patterns: [/^(対応内容|activity_detail|対応詳細|活動内容)$/i], semanticField: 'activity_detail', fieldFamily: 'sales_activity', confidence: 'medium' },
  { patterns: [/^(契約日|contract_date|契約開始日|成約日)$/i, /契約.*日|contract/i], semanticField: 'contract_date', fieldFamily: 'sales_activity', confidence: 'high' },
  { patterns: [/^(最終対応日|last_contact|最終連絡日)$/i], semanticField: 'last_contact_date', fieldFamily: 'sales_activity', confidence: 'medium' },

  // Source / list
  { patterns: [/^(リスト名|list_name|リスト|媒体|媒体名)$/i, /リスト|list/i], semanticField: 'list_name', fieldFamily: 'source_list', confidence: 'medium' },
  { patterns: [/^(流入元|source|流入経路|獲得経路)$/i], semanticField: 'source', fieldFamily: 'source_list', confidence: 'medium' },

  // Product / service
  { patterns: [/^(商材|product|サービス|商品|商品名|service)$/i, /商材|商品|サービス|product|service/i], semanticField: 'product', fieldFamily: 'product', confidence: 'medium' },

  // Visit
  { patterns: [/^(訪問日|visit_date|訪問予定日)$/i, /訪問/i], semanticField: 'visit_date', fieldFamily: 'visit_schedule', confidence: 'medium' },

  // Progress
  { patterns: [/^(進捗|progress|ステータス|status|進捗状況)$/i, /進捗|progress|status/i], semanticField: 'progress_status', fieldFamily: 'progress', confidence: 'medium' },

  // Finance
  { patterns: [/^(金額|amount|単価|price|売上|revenue|請求)$/i, /金額|amount|単価|price|売上|請求/i], semanticField: 'amount', fieldFamily: 'finance_review', confidence: 'medium' },
  { patterns: [/^(請求番号|invoice|invoice_number)$/i], semanticField: 'invoice_number', fieldFamily: 'finance_review', confidence: 'medium' },

  // Estimate
  { patterns: [/^(見積|estimate|見積番号|見積金額)$/i, /見積|estimate/i], semanticField: 'estimate', fieldFamily: 'estimate', confidence: 'medium' },

  // Documents
  { patterns: [/^(書類|document|資料|添付)$/i, /書類|document|資料/i], semanticField: 'document', fieldFamily: 'documents', confidence: 'medium' },

  // Cost
  { patterns: [/^(原価|cost|コスト|費用)$/i, /原価|cost|コスト|費用/i], semanticField: 'cost', fieldFamily: 'cost', confidence: 'medium' },

  // Notes
  { patterns: [/^(メモ|note|notes|備考|コメント|comment)$/i, /メモ|備考|note|comment/i], semanticField: 'notes', fieldFamily: 'notes', confidence: 'medium' },

  // Metadata / system
  { patterns: [/^(ID|id|_id|レコードID|record_id)$/i], semanticField: 'record_id', fieldFamily: 'metadata', confidence: 'medium' },
  { patterns: [/^(作成日|created|created_at|登録日)$/i, /作成|created|登録/i], semanticField: 'created_at', fieldFamily: 'metadata', confidence: 'medium' },
  { patterns: [/^(更新日|updated|updated_at|修正日)$/i, /更新|updated|修正/i], semanticField: 'updated_at', fieldFamily: 'metadata', confidence: 'medium' },
];

function matchRule(columnName: string): SuggestionRule | null {
  const trimmed = columnName.trim();
  for (const rule of RULES) {
    // Try exact patterns first (index 0), then broader patterns
    for (const pattern of rule.patterns) {
      if (pattern.test(trimmed)) return rule;
    }
  }
  return null;
}

/**
 * Check if values in the column look like phone numbers.
 */
function looksLikePhone(values: string[]): boolean {
  if (values.length === 0) return false;
  const phonePattern = /^[0０][\d０-９\-－ ]{8,}/;
  const matches = values.filter((v) => phonePattern.test(v.trim()));
  return matches.length >= values.length * 0.5;
}

/**
 * Check if values look like email addresses.
 */
function looksLikeEmail(values: string[]): boolean {
  if (values.length === 0) return false;
  const matches = values.filter((v) => v.includes('@'));
  return matches.length >= values.length * 0.5;
}

/**
 * Generate a suggestion for a single column.
 */
export function suggestColumn(
  columnName: string,
  profile: ColumnProfile,
  config: WorkbenchConfig,
  filePath: string,
): ColumnSuggestion {
  // 1. Check existing config columnMappings (highest confidence)
  const fileName = basename(filePath);
  for (const [pattern, mapping] of Object.entries(config.columnMappings)) {
    const regex = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      'i',
    );
    if (regex.test(fileName) && mapping[columnName]) {
      const canonical = mapping[columnName];
      // Find family from the canonical name via rules
      const rule = matchRule(canonical);
      const family: FieldFamily = rule?.fieldFamily ?? 'raw_extra';
      return {
        semanticField: canonical,
        fieldFamily: family,
        section: FAMILY_TO_SECTION[family],
        confidence: 'high',
        reason: `既存マッピング: ${pattern} → ${canonical}`,
      };
    }
  }

  // 2. Check canonicalFields for known field name match
  for (const [fieldType, names] of Object.entries(config.canonicalFields)) {
    if (names.some((n: string) => n.toLowerCase() === columnName.toLowerCase())) {
      const familyMap: Record<string, FieldFamily> = {
        phone: 'contact',
        email: 'contact',
        name: 'identity',
        companyName: 'company_store',
        storeName: 'company_store',
        address: 'contact',
      };
      const semanticMap: Record<string, string> = {
        name: 'customer_name',
        companyName: 'company_name',
        storeName: 'store_name',
      };
      const family = familyMap[fieldType] ?? 'raw_extra';
      return {
        semanticField: semanticMap[fieldType] ?? fieldType,
        fieldFamily: family,
        section: FAMILY_TO_SECTION[family],
        confidence: 'high',
        reason: `canonicalFields.${fieldType} に一致`,
      };
    }
  }

  // 3. Rule-based column name matching
  const rule = matchRule(columnName);
  if (rule) {
    return {
      semanticField: rule.semanticField,
      fieldFamily: rule.fieldFamily,
      section: FAMILY_TO_SECTION[rule.fieldFamily],
      confidence: rule.confidence,
      reason: `列名パターン一致: ${columnName}`,
    };
  }

  // 4. Value-pattern heuristics
  const sampleValues = profile.topValues.map((tv) => tv.value);
  if (looksLikePhone(sampleValues)) {
    return {
      semanticField: 'phone',
      fieldFamily: 'contact',
      section: 'contact_info',
      confidence: 'medium',
      reason: '値パターンが電話番号に類似',
    };
  }
  if (looksLikeEmail(sampleValues)) {
    return {
      semanticField: 'email',
      fieldFamily: 'contact',
      section: 'contact_info',
      confidence: 'medium',
      reason: '値パターンがメールアドレスに類似',
    };
  }

  // 5. Fallback — raw_extra
  return {
    semanticField: columnName,
    fieldFamily: 'raw_extra',
    section: 'raw_extra_info',
    confidence: 'low',
    reason: '自動判定できませんでした',
  };
}

/**
 * Generate suggestions for all columns in a profile.
 */
export function suggestAllColumns(
  profiles: ColumnProfile[],
  config: WorkbenchConfig,
  filePath: string,
): ColumnReview[] {
  return profiles.map((col) => {
    const suggestion = suggestColumn(col.name, col, config, filePath);
    const sampleValues = col.topValues.slice(0, 5).map((tv) => tv.value);
    return {
      sourceColumn: col.name,
      sampleValues,
      missingRate: col.missingRate,
      uniqueCount: col.uniqueCount,
      suggestion,
      humanSemanticField: null,
      humanFieldFamily: null,
      humanSection: null,
      decision: 'unknown' as const,
    };
  });
}

/**
 * Suggest primary file type from column family distribution.
 */
export function suggestFileType(
  columns: ColumnReview[],
): { fileType: string; confidence: 'high' | 'medium' | 'low' } {
  const familyCounts = new Map<string, number>();
  for (const col of columns) {
    const family = col.suggestion.fieldFamily;
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
  }

  // Heuristic: check dominant families
  const hasSalesActivity = (familyCounts.get('sales_activity') ?? 0) >= 2;
  const hasContact = (familyCounts.get('contact') ?? 0) >= 2;
  const hasIdentity = (familyCounts.get('identity') ?? 0) >= 1;
  const hasVisit = (familyCounts.get('visit_schedule') ?? 0) >= 1;
  const hasProgress = (familyCounts.get('progress') ?? 0) >= 1;
  const hasEstimate = (familyCounts.get('estimate') ?? 0) >= 1 || (familyCounts.get('product') ?? 0) >= 1;
  const hasFinance = (familyCounts.get('finance_review') ?? 0) >= 1;
  const hasDocument = (familyCounts.get('documents') ?? 0) >= 1;

  if (hasSalesActivity && hasContact) {
    return { fileType: 'apo_list', confidence: 'medium' };
  }
  if (hasContact && hasIdentity && !hasSalesActivity) {
    return { fileType: 'customer_master', confidence: 'medium' };
  }
  if (hasVisit) {
    return { fileType: 'visit_history', confidence: 'low' };
  }
  if (hasProgress) {
    return { fileType: 'progress_management', confidence: 'low' };
  }
  if (hasEstimate) {
    return { fileType: 'estimate_product', confidence: 'low' };
  }
  if (hasFinance && hasDocument) {
    return { fileType: 'document_review', confidence: 'low' };
  }
  return { fileType: 'mixed_unknown', confidence: 'low' };
}
