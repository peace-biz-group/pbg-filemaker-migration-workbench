/**
 * Core type definitions for the FileMaker Data Workbench.
 */

/** A single data record — column name to string value. */
export type RawRecord = Record<string, string>;

/** Profile result for a single column. */
export interface ColumnProfile {
  name: string;
  totalCount: number;
  nonEmptyCount: number;
  missingRate: number;
  uniqueCount: number;
  uniqueCountCapped: boolean;
  topValues: { value: string; count: number }[];
  anomalies: string[];
}

/** Overall profile result. */
export interface ProfileResult {
  fileName: string;
  recordCount: number;
  columnCount: number;
  columns: ColumnProfile[];
  anomalies: AnomalyRecord[];
}

/** Anomaly detected during profiling. */
export interface AnomalyRecord {
  row: number;
  column: string;
  value: string;
  reason: string;
}

/** Duplicate candidate group. */
export interface DuplicateGroup {
  groupId: number;
  matchKey: string;
  matchType: 'phone' | 'email' | 'name_company' | 'name_address' | 'entity_match' | 'source_record';
  records: { row: number; values: Record<string, string> }[];
}

/** Classification result for a record. */
export type CandidateType =
  | 'customer'
  | 'deal'
  | 'transaction'
  | 'activity'
  | 'quarantine';

export interface ClassifiedRecord {
  row: number;
  candidateType: CandidateType;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  data: RawRecord;
}

/** Chunk processing callback. */
export type ChunkProcessor<T> = (
  chunk: RawRecord[],
  chunkIndex: number,
) => Promise<T>;

/** Report summary. */
export interface ReportSummary {
  generatedAt: string;
  inputFile: string;
  recordCount: number;
  columnCount: number;
  normalizedCount: number;
  quarantineCount: number;
  duplicateGroupCount: number;
  classificationBreakdown: Record<CandidateType, number>;
  parseFailCount?: number;
  totalRecordCount?: number;
  mainlineReadyCount?: number;
  reviewCount?: number;
  archiveOnlyCount?: number;
  reviewReasonBreakdown?: Record<string, number>;
  mergeEligibilityBreakdown?: Record<'mainline_ready' | 'review' | 'archive_only', number>;
  semanticOwnerBreakdown?: Record<string, number>;
  sourceRecordKeyMethodBreakdown?: Record<string, number>;
  recordFamilyBreakdown?: Record<string, number>;
  reviewSourceRecordKeyMethodBreakdown?: Record<string, number>;
  reviewRecordFamilyBreakdown?: Record<string, number>;
  reviewSemanticOwnerBreakdown?: Record<string, number>;
  topReviewReasons?: Array<{ reason: string; count: number }>;
  topWarningIndicators?: Array<{ indicator: string; count: number }>;
  reviewSampleSummary?: {
    sampleCap: number;
    reasons: Record<string, number>;
    totalSampledRows: number;
    artifactFile: string;
  };
  tuningHints?: {
    likely_tuning_targets: string[];
    family_with_highest_review_ratio: { family: string; reviewRatio: number; reviewCount: number; totalCount: number } | null;
    key_method_with_highest_review_ratio: { method: string; reviewRatio: number; reviewCount: number; totalCount: number } | null;
    dominant_review_reasons: Array<{ reason: string; count: number }>;
    likely_next_checks: string[];
  };
  insertedCount?: number;
  updatedCount?: number;
  unchangedCount?: number;
  duplicateCount?: number;
  skippedArchiveCount?: number;
  skippedReviewCount?: number;
  identityWarningCount?: number;
  sourceBatchCount?: number;
  modes?: string[];
  sourceRoutingDecisions?: Record<string, SourceRoutingDecision>;
  sourceRecordFlows?: Record<string, SourceRecordFlow>;
  parentExtractionSummaries?: Record<string, ParentExtractionSummary>;
  countReconciliation?: CountReconciliationSummary;
  handoffBundle?: HandoffBundleSummary;
  nextActionView?: NextActionView;
}

export interface SourceRoutingDecision {
  mode: 'mainline' | 'archive';
  reasonCode: 'input_mode' | 'diff_key_mode' | 'profile_inference' | 'default_archive';
  reason: string;
  matchedProfileId?: string;
  matchedProfileLabel?: string;
  matchedProfileConfidence?: 'high' | 'medium' | 'low' | 'none';
  hasChildColumns: boolean;
  childColumnCount: number;
  childColumnNames: string[];
  mixedParentChildExport: boolean;
  recommendedRecordFamily?: string;
}

export interface SourceRecordFlow {
  inputRowCount: number;
  normalizedRowCount: number;
  quarantineRowCount: number;
  parseFailCount: number;
  rowsWithChildData: number;
  parentCandidateRowCount: number;
  ambiguousParentRowCount: number;
  childOnlyContinuationRowCount: number;
  mixedParentChildRowCount: number;
}

export type ParentExtractionClassification =
  | 'not_applicable'
  | 'parent_candidate'
  | 'ambiguous_parent'
  | 'child_continuation';

export interface ParentExtractionDecision {
  classification: ParentExtractionClassification;
  reasonCode: 'not_mixed' | 'strong_parent_signals' | 'insufficient_parent_signals' | 'child_columns_only';
  reason: string;
  extractedCanonicalFields: Record<string, string>;
  usedSourceColumns: string[];
}

export interface ParentExtractionSummary {
  classificationBreakdown: Record<ParentExtractionClassification, number>;
  reasonBreakdown: Record<string, number>;
  extractedParentCount: number;
  ambiguousParentCount: number;
  childContinuationCount: number;
}

export type EligibilityStage = 'mainline_ready' | 'review' | 'archive_only' | 'quarantine';
export type FinalDisposition =
  | EligibilityStage
  | 'inserted'
  | 'updated'
  | 'unchanged'
  | 'duplicate';

export interface CountReconciliationSummary {
  inputRowCount: number;
  normalizedRowCount: number;
  quarantineRowCount: number;
  accountedRowCount: number;
  unaccountedRowCount: number;
  parentExtractionBreakdown: Record<ParentExtractionClassification, number>;
  eligibilityBreakdown: Record<EligibilityStage, number>;
  finalDispositionBreakdown: Record<FinalDisposition, number>;
  extractionToEligibility: Record<ParentExtractionClassification, Record<EligibilityStage, number>>;
  extractionToDisposition: Record<ParentExtractionClassification, Record<FinalDisposition, number>>;
  eligibilityToDisposition: Record<EligibilityStage, Record<FinalDisposition, number>>;
  dispositionReasonBreakdown: Record<string, number>;
  dispositionReasonByFinalDisposition: Record<FinalDisposition, Record<string, number>>;
}

export interface HandoffArtifactView {
  file: string;
  rowCount: number;
  finalDispositions: FinalDisposition[];
  finalDispositionBreakdown: Record<FinalDisposition, number>;
  parentExtractionBuckets: ParentExtractionClassification[];
}

export interface HandoffBundleSummary {
  generatedAt: string;
  projectionOnly: true;
  sourceArtifacts: {
    normalized: string;
    quarantine: string;
    reconciliation: string;
  };
  counts: {
    opsCoreReady: number;
    reviewPack: number;
    quarantinePack: number;
    total: number;
  };
  integrity: {
    recordCount: number;
    accountedRowCount: number;
    unaccountedRowCount: number;
    matchesReconciliation: boolean;
  };
  artifacts: {
    opsCoreReady: HandoffArtifactView;
    reviewPack: HandoffArtifactView;
    quarantinePack: HandoffArtifactView;
  };
}

export interface NextActionView {
  countIntegrity: 'matched';
  artifacts: HandoffArtifactView[];
}

// ============================================================
// Lossless Ingest Engine types
// ============================================================

export type ParseQuarantineReason = 'DECODE_FAILED' | 'COLUMN_MISALIGNMENT' | 'PARSE_ERROR';
export type BusinessQuarantineReason = 'BUSINESS_KEY_EMPTY' | 'ALL_COLUMNS_EMPTY' | 'CHILD_CONTINUATION';
export type QuarantineReason = ParseQuarantineReason | BusinessQuarantineReason;

export interface ParseFailRecord {
  rowIndex: number;
  rawLine: string;
  rawLineHash: string;
  rawLinePreview: string;
  reason: ParseQuarantineReason;
  detail: string;
}

export interface CsvIngestDiagnosis {
  format: 'csv';
  detectedEncoding: 'utf8' | 'utf8bom' | 'cp932' | 'unknown';
  encodingConfidence: 'bom' | 'valid_utf8' | 'heuristic' | 'fallback';
  appliedEncoding: 'utf8' | 'cp932';
  detectedDelimiter: ',' | '\t' | ';';
  appliedDelimiter: ',' | '\t' | ';';
  headerApplied: boolean;
  totalRowsRead: number;
  parseFailCount: number;
  parseWarnings: string[];
}

export interface XlsxIngestDiagnosis {
  format: 'xlsx';
  sheetName: string;
  headerApplied: boolean;
  totalRowsRead: number;
  parseFailCount: number;
  parseWarnings: string[];
}

export type IngestDiagnosis = CsvIngestDiagnosis | XlsxIngestDiagnosis;

export interface IngestResult {
  diagnosis: IngestDiagnosis;
  sourceFileHash: string;
  schemaFingerprint: string;
  columns: string[];
  records: AsyncIterable<RawRecord[]>;
  parseFailures: ParseFailRecord[];
}

export interface MappingSuggestion {
  sourceColumn: string;
  suggestedCanonical: string;
  confidence: 'high' | 'medium';
  reason: 'name_pattern';
}

export interface RunDiffBySource {
  sourceKey: string;
  recordCountDelta: number;
  normalizedCountDelta: number;
  quarantineCountDelta: number;
  parseFailDelta: number;
  schemaChanged: boolean;
  schemaFingerprintPrev?: string;
  schemaFingerprintCurr?: string;
}

export interface RunDiff {
  previousRunId: string;
  currentRunId: string;
  logicalSourceKey: string;
  bySource: RunDiffBySource[];
  totals: { recordCountDelta: number; normalizedCountDelta: number; quarantineCountDelta: number; parseFailDelta: number };
}

// ============================================================
// Template System types (Review Workflow v2)
// ============================================================

/**
 * A reusable file template saved from a review session.
 * Stored as JSON in {outputDir}/.templates/{id}.json
 */
export interface FileTemplate {
  id: string;                        // UUID or schemaFingerprint-based
  displayName: string;               // Japanese display name, e.g. "アポリスト"
  createdAt: string;                 // ISO 8601 timestamp
  updatedAt: string;
  columnCount: number;
  columnNames: string[];             // original column names in order
  schemaFingerprint: string;         // SHA-256 of sorted column names
  defaultEncoding: 'utf8' | 'cp932';
  hasHeader: boolean;
  fileTypeLabel: string;             // e.g. "アポリスト", "顧客一覧"
  columnMapping: Record<string, string>; // source col → canonical field
  sectionGroups?: { label: string; columns: string[] }[];
  knownFilenamePatterns: string[];   // normalized filename stems that matched
}

/**
 * A template match result with score and reasons.
 */
export interface TemplateMatch {
  template: FileTemplate;
  score: number;                     // 0-1 composite score
  reasons: TemplateMatchReason[];
}

export interface TemplateMatchReason {
  factor: 'filename' | 'schema_fingerprint' | 'column_overlap' | 'column_count' | 'encoding' | 'header';
  description: string;               // Japanese explanation for UI
  contribution: number;              // 0-1 contribution to score
}

// ============================================================
// Run Diff Summary v1
// ============================================================

export type DiffClassification =
  | 'same_content'       // 前回と同じ内容
  | 'row_count_changed'  // 件数が変わった
  | 'schema_changed'     // 列の構成が変わった
  | 'profile_changed'    // 設定が変わった
  | 'no_comparable';     // 比較対象なし

export interface RunDiffSummaryV1 {
  version: 1;
  previousRunId: string;
  currentRunId: string;
  logicalSourceKey: string;
  totals: {
    recordCountDelta: number;
    normalizedCountDelta: number;
    quarantineCountDelta: number;
    parseFailDelta: number;
  };
  profileId?: string;
  sameProfile: boolean;
  sameSchemaFingerprint: boolean;
  sameRawFingerprint: boolean;
  sameEffectiveMapping: boolean;
  rowCountPrev: number;
  rowCountCurr: number;
  columnCountPrev: number;
  columnCountCurr: number;
  hasHeaderPrev?: boolean;
  hasHeaderCurr?: boolean;
  sourceFilenamesPrev: string[];
  sourceFilenamesCurr: string[];
  addedColumns: string[];
  removedColumns: string[];
  classification: DiffClassification;
  classificationLabel: string;
  generatedAt: string;
}
