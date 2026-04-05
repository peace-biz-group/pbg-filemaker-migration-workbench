/**
 * Record normalizer — applies column mapping + normalization rules to each record in chunks.
 */

import type {
  RawRecord,
  BusinessQuarantineReason,
  IngestDiagnosis,
  ParentExtractionSummary,
  SourceRecordFlow,
  SourceRoutingDecision,
} from '../types/index.js';
import type { WorkbenchConfig } from '../config/schema.js';
import { ingestFile } from '../io/file-reader.js';
import { writeCsv, appendCsv } from '../io/csv-writer.js';
import { normalizePhone } from '../normalizers/phone.js';
import { normalizeEmail } from '../normalizers/email.js';
import { normalizeText } from '../normalizers/text.js';
import { normalizeDate } from '../normalizers/date.js';
import { normalizeCompanyName, normalizeAddress, normalizeStoreName } from '../normalizers/company.js';
import { findBestMapping, applyColumnMapping } from './column-mapper.js';
import { join, resolve } from 'node:path';
import { ensureOutputDir } from '../io/report-writer.js';
import type { IngestOptions } from '../ingest/ingest-options.js';
import { buildRecordIdentity } from './record-identity.js';
import {
  accumulateParentExtraction,
  emptyParentExtractionSummary,
  extractParentFromMixedRecord,
} from './parent-extraction.js';

function matchesAny(colName: string, patterns: string[]): boolean {
  const lower = colName.toLowerCase();
  return patterns.some((p) => lower === p.toLowerCase());
}

function normalizeRecord(record: RawRecord, config: WorkbenchConfig): RawRecord {
  const result: RawRecord = {};
  const rules = config.normalization;

  for (const [key, rawValue] of Object.entries(record)) {
    let value = rawValue ?? '';

    // Trim
    if (rules.trimWhitespace) {
      value = value.trim();
    }

    // Full-width → half-width + whitespace cleanup
    if (rules.normalizeFullWidthToHalfWidth || rules.cleanWhitespaceAndNewlines) {
      value = normalizeText(value);
    }

    // Phone normalization
    if (rules.normalizePhone && matchesAny(key, config.canonicalFields.phone)) {
      value = normalizePhone(value);
    }

    // Email normalization
    if (rules.lowercaseEmail && matchesAny(key, config.canonicalFields.email)) {
      value = normalizeEmail(value);
    }

    // Company name normalization
    if (rules.normalizeCompanyName && matchesAny(key, config.canonicalFields.companyName)) {
      value = normalizeCompanyName(value);
    }

    // Store name normalization
    if (rules.normalizeStoreName && matchesAny(key, config.canonicalFields.storeName)) {
      value = normalizeStoreName(value);
    }

    // Address normalization
    if (rules.normalizeAddress && matchesAny(key, config.canonicalFields.address)) {
      value = normalizeAddress(value);
    }

    // Date normalization
    if (rules.normalizeDates && key.match(/date|日付|日$/i)) {
      const normalized = normalizeDate(value);
      if (normalized) value = normalized;
    }

    result[key] = value;
  }

  return result;
}

function businessQuarantineReason(record: RawRecord, config: WorkbenchConfig): BusinessQuarantineReason | null {
  const allValues = Object.entries(record)
    .filter(([k]) => !k.startsWith('_'))
    .map(([, v]) => v);
  if (allValues.every(v => !v?.trim())) return 'ALL_COLUMNS_EMPTY';

  const allKeyFields = [
    ...config.canonicalFields.phone,
    ...config.canonicalFields.email,
    ...config.canonicalFields.name,
    ...config.canonicalFields.companyName,
    ...config.canonicalFields.storeName,
  ];

  for (const fieldPattern of allKeyFields) {
    for (const [key, val] of Object.entries(record)) {
      if (key.toLowerCase() === fieldPattern.toLowerCase() && val?.trim()) return null;
    }
  }
  return 'BUSINESS_KEY_EMPTY';
}

export interface NormalizeContext {
  sourceBatchId: string;
  importRunId: string;
  sourceKey: string;
  ingestOptions?: IngestOptions;
  /**
   * run 単位の実効 mapping（列レビュー回答から生成）。
   * 指定された場合は config の columnMappings より優先して適用される。
   * null = mapping なし（全列をそのまま通す）。
   * undefined = 未指定（config の findBestMapping にフォールバック）。
   */
  effectiveMapping?: Record<string, string> | null;
  sourceMode?: 'mainline' | 'archive';
  sourceRouting?: SourceRoutingDecision;
}

export interface NormalizeResult {
  normalizedCount: number;
  quarantineCount: number;
  parseFailCount: number;
  normalizedPath: string;
  quarantinePath: string;
  parseQuarantinePath: string;
  schemaFingerprint: string;
  sourceFileHash: string;
  recordCount: number;
  columnCount: number;
  ingestDiagnoses: Record<string, IngestDiagnosis>;
  sourceRecordFlows: Record<string, SourceRecordFlow>;
  parentExtractionSummaries: Record<string, ParentExtractionSummary>;
}

function hasChildData(record: RawRecord, routing?: SourceRoutingDecision): boolean {
  if (!routing || routing.childColumnNames.length === 0) return false;
  return routing.childColumnNames.some((column) => (record[column] ?? '').trim());
}

function emptySourceRecordFlow(): SourceRecordFlow {
  return {
    inputRowCount: 0,
    normalizedRowCount: 0,
    quarantineRowCount: 0,
    parseFailCount: 0,
    rowsWithChildData: 0,
    parentCandidateRowCount: 0,
    ambiguousParentRowCount: 0,
    childOnlyContinuationRowCount: 0,
    mixedParentChildRowCount: 0,
  };
}

/**
 * Normalize a single file. Applies column mapping if matched, then normalization rules.
 * @param filePath Input file path
 * @param config Workbench config
 * @param context Normalization context with lineage info (optional for backward compat)
 * @param outputSuffix Optional suffix for output files (for multi-file runs)
 * @param appendMode If true, append to existing output files instead of overwriting
 */
export async function normalizeFile(
  filePath: string,
  config: WorkbenchConfig,
  context: NormalizeContext = { sourceBatchId: '', importRunId: '', sourceKey: '' },
  outputSuffix?: string,
  appendMode?: boolean,
): Promise<NormalizeResult> {
  ensureOutputDir(config.outputDir);
  const sourcePathKey = resolve(filePath);
  const suffix = outputSuffix ? `_${outputSuffix}` : '';
  const normalizedPath = join(config.outputDir, `normalized${suffix}.csv`);
  const quarantinePath = join(config.outputDir, `quarantine${suffix}.csv`);
  const parseQuarantinePath = join(config.outputDir, `parse-quarantine${suffix}.csv`);

  const ingestResult = await ingestFile(filePath, context.ingestOptions ?? {}, config.chunkSize);
  // run 単位の実効 mapping が指定されていればそれを優先する
  // undefined = 未指定 → config の mapping にフォールバック
  // null = 明示的に mapping なし
  const mapping = context.effectiveMapping !== undefined
    ? context.effectiveMapping
    : findBestMapping(filePath, ingestResult.schemaFingerprint, config);

  let normalizedCount = 0;
  let quarantineCount = 0;
  let mappedColumns: string[] | undefined;
  let isFirst = !appendMode;
  const sourceRecordFlow = emptySourceRecordFlow();
  const parentExtractionSummary = emptyParentExtractionSummary();

  for await (const chunk of ingestResult.records) {
    const normalized: RawRecord[] = [];
    const quarantine: RawRecord[] = [];

    for (const record of chunk) {
      sourceRecordFlow.inputRowCount++;
      const parentExtraction = extractParentFromMixedRecord(record, context.sourceRouting);
      accumulateParentExtraction(parentExtractionSummary, parentExtraction);
      const mappedBase = mapping ? applyColumnMapping(record, mapping) : { ...record };
      const mapped = { ...parentExtraction.extractedCanonicalFields, ...mappedBase };
      if (!mappedColumns) {
        mappedColumns = ['_source_file', '_source_key', '_source_batch_id', '_import_run_id', '_schema_fingerprint', '_row_fingerprint', '_source_record_key', '_source_record_key_method', '_entity_match_key', '_structural_fingerprint', '_structural_fingerprint_full', '_structural_fingerprint_mainline', '_merge_eligibility', '_review_reason', '_semantic_owner', '_parent_extraction_classification', '_parent_extraction_reason', '_parent_extraction_used_columns', '_final_disposition', '_final_disposition_reason', ...Object.keys(mapped).filter((k) => !k.startsWith('_'))];
      }
      const norm = normalizeRecord(mapped, config);
      const rowHasChildData = hasChildData(record, context.sourceRouting);
      if (rowHasChildData) sourceRecordFlow.rowsWithChildData++;
      if (parentExtraction.classification === 'parent_candidate') sourceRecordFlow.parentCandidateRowCount++;
      if (parentExtraction.classification === 'ambiguous_parent') sourceRecordFlow.ambiguousParentRowCount++;
      if (parentExtraction.classification === 'child_continuation') sourceRecordFlow.childOnlyContinuationRowCount++;
      if (rowHasChildData && parentExtraction.classification !== 'child_continuation') {
        sourceRecordFlow.mixedParentChildRowCount++;
      }

      // Add lineage
      norm['_source_file'] = filePath;
      norm['_source_key'] = context.sourceKey;
      norm['_source_batch_id'] = context.sourceBatchId;
      norm['_import_run_id'] = context.importRunId;
      norm['_schema_fingerprint'] = ingestResult.schemaFingerprint;
      norm['_parent_extraction_classification'] = parentExtraction.classification;
      norm['_parent_extraction_reason'] = parentExtraction.reason;
      norm['_parent_extraction_used_columns'] = parentExtraction.usedSourceColumns.join('|');
      // _row_fingerprint already in record from ingest layer
      const identity = buildRecordIdentity(
        norm,
        {
          sourceFile: filePath,
          mode: context.sourceMode ?? 'archive',
          sourceRouting: context.sourceRouting,
          parentExtraction,
        },
        config,
      );
      norm['_source_record_key'] = identity.sourceRecordKey;
      norm['_source_record_key_method'] = identity.sourceRecordKeyMethod;
      norm['_entity_match_key'] = identity.entityMatchKey;
      norm['_structural_fingerprint'] = identity.structuralFingerprint;
      norm['_structural_fingerprint_full'] = identity.structuralFingerprintFull;
      norm['_structural_fingerprint_mainline'] = identity.structuralFingerprintMainline;
      norm['_merge_eligibility'] = identity.mergeEligibility;
      norm['_review_reason'] = identity.reviewReason ?? '';
      norm['_semantic_owner'] = identity.semanticOwner ?? '';
      norm['_final_disposition'] = identity.mergeEligibility;
      norm['_final_disposition_reason'] = identity.mergeEligibility === 'mainline_ready'
        ? 'eligible_for_mainline_merge'
        : (identity.reviewReason ?? identity.mergeEligibility);

      const emptyReason = businessQuarantineReason(norm, config);
      const reason = parentExtraction.classification === 'child_continuation'
        ? 'CHILD_CONTINUATION'
        : parentExtraction.classification === 'ambiguous_parent'
          ? null
          : emptyReason;
      if (reason) {
        norm['_quarantine_reason'] = reason;
        norm['_final_disposition'] = 'quarantine';
        norm['_final_disposition_reason'] = reason;
        quarantine.push(norm);
        sourceRecordFlow.quarantineRowCount++;
      } else {
        normalized.push(norm);
        sourceRecordFlow.normalizedRowCount++;
      }
    }

    if (isFirst) {
      await writeCsv(normalizedPath, normalized, mappedColumns);
      await writeCsv(quarantinePath, quarantine, mappedColumns ? ['_quarantine_reason', ...mappedColumns] : undefined);
      isFirst = false;
    } else {
      await appendCsv(normalizedPath, normalized, mappedColumns!);
      await appendCsv(quarantinePath, quarantine, mappedColumns ? ['_quarantine_reason', ...mappedColumns] : mappedColumns!);
    }

    normalizedCount += normalized.length;
    quarantineCount += quarantine.length;
  }

  sourceRecordFlow.parseFailCount = ingestResult.parseFailures.length;
  const finalDiagnosis: IngestDiagnosis = {
    ...ingestResult.diagnosis,
    totalRowsRead: sourceRecordFlow.inputRowCount,
    parseFailCount: ingestResult.parseFailures.length,
  };

  // Write parse quarantine
  if (ingestResult.parseFailures.length > 0) {
    await writeCsv(parseQuarantinePath, ingestResult.parseFailures.map(f => ({
      _row_index: String(f.rowIndex),
      _reason: f.reason,
      _detail: f.detail,
      _raw_line_hash: f.rawLineHash,
      _raw_line_preview: f.rawLinePreview,
      _raw_line: f.rawLine,
      _source_file: filePath,
    })));
  }

  return {
    normalizedCount,
    quarantineCount,
    parseFailCount: ingestResult.parseFailures.length,
    normalizedPath,
    quarantinePath,
    parseQuarantinePath,
    schemaFingerprint: ingestResult.schemaFingerprint,
    sourceFileHash: ingestResult.sourceFileHash,
    recordCount: sourceRecordFlow.inputRowCount,
    columnCount: ingestResult.columns.length,
    ingestDiagnoses: { [sourcePathKey]: finalDiagnosis },
    sourceRecordFlows: { [sourcePathKey]: sourceRecordFlow },
    parentExtractionSummaries: { [sourcePathKey]: parentExtractionSummary },
  };
}

/**
 * Normalize multiple files into a single merged output.
 * Each file's records get lineage columns for traceability.
 */
export async function normalizeFiles(
  filePaths: { path: string; label?: string }[],
  config: WorkbenchConfig,
  contexts?: NormalizeContext[],
): Promise<NormalizeResult> {
  ensureOutputDir(config.outputDir);
  const normalizedPath = join(config.outputDir, 'normalized.csv');
  const quarantinePath = join(config.outputDir, 'quarantine.csv');
  const parseQuarantinePath = join(config.outputDir, 'parse-quarantine.csv');

  let totalNormalized = 0;
  let totalQuarantine = 0;
  let totalParseFail = 0;
  let isFirst = true;
  let outputColumns: string[] | undefined;
  let lastSchemaFp = '';
  let lastSourceFileHash = '';
  let maxColumnCount = 0;
  const ingestDiagnoses: Record<string, IngestDiagnosis> = {};
  const sourceRecordFlows: Record<string, SourceRecordFlow> = {};
  const parentExtractionSummaries: Record<string, ParentExtractionSummary> = {};

  for (let fileIdx = 0; fileIdx < filePaths.length; fileIdx++) {
    const { path: filePath, label } = filePaths[fileIdx];
    const sourcePathKey = resolve(filePath);
    const sourceLabel = label ?? filePath;
    const context: NormalizeContext = contexts?.[fileIdx] ?? { sourceBatchId: '', importRunId: '', sourceKey: sourceLabel };

    const ingestResult = await ingestFile(filePath, context.ingestOptions ?? {}, config.chunkSize);
    const mapping = context.effectiveMapping !== undefined
      ? context.effectiveMapping
      : findBestMapping(filePath, ingestResult.schemaFingerprint, config);
    lastSchemaFp = ingestResult.schemaFingerprint;
    lastSourceFileHash = ingestResult.sourceFileHash;
    maxColumnCount = Math.max(maxColumnCount, ingestResult.columns.length);
    const sourceRecordFlow = emptySourceRecordFlow();
    const parentExtractionSummary = emptyParentExtractionSummary();

    for await (const chunk of ingestResult.records) {
      const normalized: RawRecord[] = [];
      const quarantine: RawRecord[] = [];

      for (const record of chunk) {
        sourceRecordFlow.inputRowCount++;
        const parentExtraction = extractParentFromMixedRecord(record, context.sourceRouting);
        accumulateParentExtraction(parentExtractionSummary, parentExtraction);
        const mappedBase = mapping ? applyColumnMapping(record, mapping) : { ...record };
        const mapped = { ...parentExtraction.extractedCanonicalFields, ...mappedBase };

        // Add source file tag for backward compat
        mapped._source_file = sourceLabel;

        if (!outputColumns) {
          outputColumns = ['_source_file', '_source_key', '_source_batch_id', '_import_run_id', '_schema_fingerprint', '_row_fingerprint', '_source_record_key', '_source_record_key_method', '_entity_match_key', '_structural_fingerprint', '_structural_fingerprint_full', '_structural_fingerprint_mainline', '_merge_eligibility', '_review_reason', '_semantic_owner', '_parent_extraction_classification', '_parent_extraction_reason', '_parent_extraction_used_columns', '_final_disposition', '_final_disposition_reason', ...Object.keys(mapped).filter((k) => k !== '_source_file' && !k.startsWith('_'))];
        }

        const norm = normalizeRecord(mapped, config);
        const rowHasChildData = hasChildData(record, context.sourceRouting);
        if (rowHasChildData) sourceRecordFlow.rowsWithChildData++;
        if (parentExtraction.classification === 'parent_candidate') sourceRecordFlow.parentCandidateRowCount++;
        if (parentExtraction.classification === 'ambiguous_parent') sourceRecordFlow.ambiguousParentRowCount++;
        if (parentExtraction.classification === 'child_continuation') sourceRecordFlow.childOnlyContinuationRowCount++;
        if (rowHasChildData && parentExtraction.classification !== 'child_continuation') {
          sourceRecordFlow.mixedParentChildRowCount++;
        }

        // Add lineage
        norm['_source_file'] = sourceLabel;
        norm['_source_key'] = context.sourceKey;
        norm['_source_batch_id'] = context.sourceBatchId;
        norm['_import_run_id'] = context.importRunId;
        norm['_schema_fingerprint'] = ingestResult.schemaFingerprint;
        norm['_parent_extraction_classification'] = parentExtraction.classification;
        norm['_parent_extraction_reason'] = parentExtraction.reason;
        norm['_parent_extraction_used_columns'] = parentExtraction.usedSourceColumns.join('|');
        const identity = buildRecordIdentity(
          norm,
          {
            sourceFile: filePath,
            mode: context.sourceMode ?? 'archive',
            sourceRouting: context.sourceRouting,
            parentExtraction,
          },
          config,
        );
        norm['_source_record_key'] = identity.sourceRecordKey;
        norm['_source_record_key_method'] = identity.sourceRecordKeyMethod;
        norm['_entity_match_key'] = identity.entityMatchKey;
        norm['_structural_fingerprint'] = identity.structuralFingerprint;
        norm['_structural_fingerprint_full'] = identity.structuralFingerprintFull;
        norm['_structural_fingerprint_mainline'] = identity.structuralFingerprintMainline;
        norm['_merge_eligibility'] = identity.mergeEligibility;
        norm['_review_reason'] = identity.reviewReason ?? '';
        norm['_semantic_owner'] = identity.semanticOwner ?? '';
        norm['_final_disposition'] = identity.mergeEligibility;
        norm['_final_disposition_reason'] = identity.mergeEligibility === 'mainline_ready'
          ? 'eligible_for_mainline_merge'
          : (identity.reviewReason ?? identity.mergeEligibility);

        const emptyReason = businessQuarantineReason(norm, config);
        const reason = parentExtraction.classification === 'child_continuation'
          ? 'CHILD_CONTINUATION'
          : parentExtraction.classification === 'ambiguous_parent'
            ? null
            : emptyReason;
        if (reason) {
          norm['_quarantine_reason'] = reason;
          norm['_final_disposition'] = 'quarantine';
          norm['_final_disposition_reason'] = reason;
          quarantine.push(norm);
          sourceRecordFlow.quarantineRowCount++;
        } else {
          normalized.push(norm);
          sourceRecordFlow.normalizedRowCount++;
        }
      }

      if (isFirst) {
        await writeCsv(normalizedPath, normalized, outputColumns);
        await writeCsv(quarantinePath, quarantine, outputColumns ? ['_quarantine_reason', ...outputColumns] : undefined);
        isFirst = false;
      } else {
        await appendCsv(normalizedPath, normalized, outputColumns!);
        await appendCsv(quarantinePath, quarantine, outputColumns ? ['_quarantine_reason', ...outputColumns] : outputColumns!);
      }

      totalNormalized += normalized.length;
      totalQuarantine += quarantine.length;
    }

    // Write parse quarantine for this file
    if (ingestResult.parseFailures.length > 0) {
      const parseRows = ingestResult.parseFailures.map(f => ({
        _row_index: String(f.rowIndex),
        _reason: f.reason,
        _detail: f.detail,
        _raw_line_hash: f.rawLineHash,
        _raw_line_preview: f.rawLinePreview,
        _raw_line: f.rawLine,
        _source_file: filePath,
      }));
      if (fileIdx === 0) {
        await writeCsv(parseQuarantinePath, parseRows);
      } else {
        await appendCsv(parseQuarantinePath, parseRows, Object.keys(parseRows[0]!));
      }
      totalParseFail += ingestResult.parseFailures.length;
    }
    sourceRecordFlow.parseFailCount = ingestResult.parseFailures.length;
    sourceRecordFlows[sourcePathKey] = sourceRecordFlow;
    parentExtractionSummaries[sourcePathKey] = parentExtractionSummary;
    ingestDiagnoses[sourcePathKey] = {
      ...ingestResult.diagnosis,
      totalRowsRead: sourceRecordFlow.inputRowCount,
      parseFailCount: ingestResult.parseFailures.length,
    };
  }

  return {
    normalizedCount: totalNormalized,
    quarantineCount: totalQuarantine,
    parseFailCount: totalParseFail,
    normalizedPath,
    quarantinePath,
    parseQuarantinePath,
    schemaFingerprint: lastSchemaFp,
    sourceFileHash: lastSourceFileHash,
    recordCount: Object.values(sourceRecordFlows).reduce((sum, flow) => sum + flow.inputRowCount, 0),
    columnCount: maxColumnCount,
    ingestDiagnoses,
    sourceRecordFlows,
    parentExtractionSummaries,
  };
}
