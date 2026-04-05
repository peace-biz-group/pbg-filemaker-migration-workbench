import type {
  ParentExtractionDecision,
  ParentExtractionSummary,
  ParentExtractionClassification,
  RawRecord,
  SourceRoutingDecision,
} from '../types/index.js';

interface ExtractedValue {
  canonicalKey: string;
  sourceColumn: string;
  value: string;
  strong: boolean;
}

const FIELD_SPECS = [
  {
    canonicalKey: 'customer_id',
    strong: true,
    patterns: [/^(お客様ID|顧客番号|顧客ID|customer.?id|id)$/i],
  },
  {
    canonicalKey: 'customer_name',
    strong: true,
    patterns: [/^(契約者|申込者|氏名|顧客名|名前|customer_name)$/i],
  },
  {
    canonicalKey: 'phone',
    strong: true,
    patterns: [/^(電話番号|連絡先|phone|tel|TEL)$/i],
  },
  {
    canonicalKey: 'phone',
    strong: false,
    patterns: [/^(設置電話番号|代表者携帯|担当者携帯|電番【検索用】)$/i],
  },
  {
    canonicalKey: 'address',
    strong: true,
    patterns: [/^(住所|所在地|address)$/i],
  },
  {
    canonicalKey: 'address',
    strong: false,
    patterns: [/^(設置住所)$/i],
  },
  {
    canonicalKey: 'company_name',
    strong: false,
    patterns: [/^(会社名|法人名|設置店名|company_name)$/i],
  },
];

function initBreakdown<T extends string>(keys: T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

export function emptyParentExtractionSummary(): ParentExtractionSummary {
  return {
    classificationBreakdown: initBreakdown<ParentExtractionClassification>([
      'not_applicable',
      'parent_candidate',
      'ambiguous_parent',
      'child_continuation',
    ]),
    reasonBreakdown: {},
    extractedParentCount: 0,
    ambiguousParentCount: 0,
    childContinuationCount: 0,
  };
}

function nonEmpty(record: RawRecord, column: string): string {
  return (record[column] ?? '').trim();
}

function findExtractedValues(record: RawRecord, routing: SourceRoutingDecision): ExtractedValue[] {
  const used = new Set<string>();
  const values: ExtractedValue[] = [];
  const parentColumns = Object.keys(record).filter((column) => !routing.childColumnNames.includes(column));

  for (const spec of FIELD_SPECS) {
    const match = parentColumns.find((column) =>
      !used.has(column)
      && spec.patterns.some((pattern) => pattern.test(column))
      && nonEmpty(record, column),
    );
    if (!match) continue;
    used.add(match);
    values.push({
      canonicalKey: spec.canonicalKey,
      sourceColumn: match,
      value: nonEmpty(record, match),
      strong: spec.strong,
    });
  }

  return values;
}

function hasChildData(record: RawRecord, routing: SourceRoutingDecision): boolean {
  return routing.childColumnNames.some((column) => nonEmpty(record, column));
}

export function extractParentFromMixedRecord(
  record: RawRecord,
  routing?: SourceRoutingDecision,
): ParentExtractionDecision {
  if (!routing?.mixedParentChildExport) {
    return {
      classification: 'not_applicable',
      reasonCode: 'not_mixed',
      reason: 'mixed parent-child export ではない',
      extractedCanonicalFields: {},
      usedSourceColumns: [],
    };
  }

  const extractedValues = findExtractedValues(record, routing);
  const extractedCanonicalFields = Object.fromEntries(extractedValues.map((value) => [value.canonicalKey, value.value]));
  const usedSourceColumns = extractedValues.map((value) => value.sourceColumn);
  const hasChild = hasChildData(record, routing);
  const strongValues = extractedValues.filter((value) => value.strong);
  const hasId = extractedValues.some((value) => value.canonicalKey === 'customer_id');
  const hasName = extractedValues.some((value) => value.canonicalKey === 'customer_name');
  const hasPhone = extractedValues.some((value) => value.canonicalKey === 'phone');
  const hasAddress = extractedValues.some((value) => value.canonicalKey === 'address');
  const hasCompany = extractedValues.some((value) => value.canonicalKey === 'company_name');

  const safeParent =
    hasId
    || (hasName && (hasPhone || hasAddress || hasCompany))
    || strongValues.length >= 2;

  if (safeParent) {
    return {
      classification: 'parent_candidate',
      reasonCode: 'strong_parent_signals',
      reason: `親属性が十分に揃っているため parent candidate と判定 (${usedSourceColumns.join(', ')})`,
      extractedCanonicalFields,
      usedSourceColumns,
    };
  }

  if (hasChild && extractedValues.length === 0) {
    return {
      classification: 'child_continuation',
      reasonCode: 'child_columns_only',
      reason: 'child history 列のみが埋まっている continuation 行',
      extractedCanonicalFields: {},
      usedSourceColumns: [],
    };
  }

  return {
    classification: 'ambiguous_parent',
    reasonCode: 'insufficient_parent_signals',
    reason: usedSourceColumns.length > 0
      ? `親属性はあるが識別に十分でないため review (${usedSourceColumns.join(', ')})`
      : '親属性の根拠が弱く safe parent と判定できないため review',
    extractedCanonicalFields,
    usedSourceColumns,
  };
}

export function accumulateParentExtraction(
  summary: ParentExtractionSummary,
  decision: ParentExtractionDecision,
): void {
  summary.classificationBreakdown[decision.classification]++;
  summary.reasonBreakdown[decision.reasonCode] = (summary.reasonBreakdown[decision.reasonCode] ?? 0) + 1;
  if (decision.classification === 'parent_candidate') summary.extractedParentCount++;
  if (decision.classification === 'ambiguous_parent') summary.ambiguousParentCount++;
  if (decision.classification === 'child_continuation') summary.childContinuationCount++;
}
