/**
 * Review workflow type definitions.
 * All review outputs are proposals/candidates — never canonical.
 */

// --- Fixed classification enums ---

export const FILE_TYPES = [
  'apo_list',
  'customer_master',
  'call_history',
  'visit_history',
  'progress_management',
  'estimate_product',
  'document_review',
  'mixed_unknown',
] as const;
export type FileType = (typeof FILE_TYPES)[number];

export const FIELD_FAMILIES = [
  'identity',
  'contact',
  'customer_basic',
  'company_store',
  'source_list',
  'sales_activity',
  'visit_schedule',
  'progress',
  'estimate',
  'product',
  'finance_review',
  'documents',
  'cost',
  'notes',
  'metadata',
  'raw_extra',
] as const;
export type FieldFamily = (typeof FIELD_FAMILIES)[number];

export const SECTIONS = [
  'basic_info',
  'contact_info',
  'source_info',
  'activity_history',
  'visit_info',
  'progress_info',
  'estimate_product_info',
  'finance_review_info',
  'document_info',
  'cost_info',
  'notes_info',
  'system_info',
  'raw_extra_info',
] as const;
export type Section = (typeof SECTIONS)[number];

export const REVIEW_STATUSES = [
  'draft',
  'reviewed',
  'needs_owner_review',
  'approved',
  'rejected',
  'archived',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const DECISIONS = ['accepted', 'adjusted', 'unknown', 'unused'] as const;
export type Decision = (typeof DECISIONS)[number];

// --- Per-column suggestion (auto-generated) ---

export interface ColumnSuggestion {
  semanticField: string;
  fieldFamily: FieldFamily;
  section: Section;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

// --- Per-column review (human + suggestion) ---

export interface ColumnReview {
  sourceColumn: string;
  sampleValues: string[];
  missingRate: number;
  uniqueCount: number;
  suggestion: ColumnSuggestion;
  humanSemanticField: string | null;
  humanFieldFamily: FieldFamily | null;
  humanSection: Section | null;
  decision: Decision;
}

// --- Review metadata (persisted as review-meta.json) ---

export interface ReviewMeta {
  id: string;
  runId: string;
  fileName: string;
  sourceFileHash: string;
  schemaFingerprint: string;
  createdAt: string;
  updatedAt: string;
  reviewStatus: ReviewStatus;
  columns: ColumnReview[];
  primaryFileType: FileType | null;
  mixedFamilies: FieldFamily[];
  reviewer: string;
  notes: string;
}

// --- Bundle output types ---

export interface MappingProposalEntry {
  sourceColumn: string;
  proposedCanonical: string;
  fieldFamily: FieldFamily;
  section: Section;
  decision: Decision;
  isHumanOverride: boolean;
}

export interface SectionLayoutEntry {
  section: Section;
  columns: string[];
}
