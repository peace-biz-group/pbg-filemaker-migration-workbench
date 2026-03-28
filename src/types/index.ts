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
}
