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
  matchType: 'phone' | 'email' | 'name_company' | 'name_address';
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
}

// ============================================================
// Lossless Ingest Engine types
// ============================================================

export type ParseQuarantineReason = 'DECODE_FAILED' | 'COLUMN_MISALIGNMENT' | 'PARSE_ERROR';
export type BusinessQuarantineReason = 'BUSINESS_KEY_EMPTY' | 'ALL_COLUMNS_EMPTY';
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
