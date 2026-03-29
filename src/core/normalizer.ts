/**
 * Record normalizer — applies column mapping + normalization rules to each record in chunks.
 */

import type { RawRecord, BusinessQuarantineReason } from '../types/index.js';
import type { WorkbenchConfig } from '../config/schema.js';
import { ingestFile } from '../io/file-reader.js';
import { writeCsv, appendCsv } from '../io/csv-writer.js';
import { normalizePhone } from '../normalizers/phone.js';
import { normalizeEmail } from '../normalizers/email.js';
import { normalizeText } from '../normalizers/text.js';
import { normalizeDate } from '../normalizers/date.js';
import { normalizeCompanyName, normalizeAddress, normalizeStoreName } from '../normalizers/company.js';
import { findBestMapping, applyColumnMapping, mapColumnNames } from './column-mapper.js';
import { join } from 'node:path';
import { ensureOutputDir } from '../io/report-writer.js';
import type { IngestOptions } from '../ingest/ingest-options.js';

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
  const suffix = outputSuffix ? `_${outputSuffix}` : '';
  const normalizedPath = join(config.outputDir, `normalized${suffix}.csv`);
  const quarantinePath = join(config.outputDir, `quarantine${suffix}.csv`);
  const parseQuarantinePath = join(config.outputDir, `parse-quarantine${suffix}.csv`);

  const ingestResult = await ingestFile(filePath, context.ingestOptions ?? {}, config.chunkSize);
  const mapping = findBestMapping(filePath, ingestResult.schemaFingerprint, config);

  let normalizedCount = 0;
  let quarantineCount = 0;
  let mappedColumns: string[] | undefined;
  let isFirst = !appendMode;

  for await (const chunk of ingestResult.records) {
    const normalized: RawRecord[] = [];
    const quarantine: RawRecord[] = [];

    for (const record of chunk) {
      if (!mappedColumns) {
        const cols = Object.keys(record).filter(k => !k.startsWith('_'));
        mappedColumns = mapping
          ? ['_source_file', '_source_key', '_source_batch_id', '_import_run_id', '_schema_fingerprint', '_row_fingerprint', ...mapColumnNames(cols, mapping)]
          : ['_source_file', '_source_key', '_source_batch_id', '_import_run_id', '_schema_fingerprint', '_row_fingerprint', ...cols];
      }

      const mapped = mapping ? applyColumnMapping(record, mapping) : record;
      const norm = normalizeRecord(mapped, config);

      // Add lineage
      norm['_source_file'] = filePath;
      norm['_source_key'] = context.sourceKey;
      norm['_source_batch_id'] = context.sourceBatchId;
      norm['_import_run_id'] = context.importRunId;
      norm['_schema_fingerprint'] = ingestResult.schemaFingerprint;
      // _row_fingerprint already in record from ingest layer

      const reason = businessQuarantineReason(norm, config);
      if (reason) {
        norm['_quarantine_reason'] = reason;
        quarantine.push(norm);
      } else {
        normalized.push(norm);
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

  for (let fileIdx = 0; fileIdx < filePaths.length; fileIdx++) {
    const { path: filePath, label } = filePaths[fileIdx];
    const sourceLabel = label ?? filePath;
    const context: NormalizeContext = contexts?.[fileIdx] ?? { sourceBatchId: '', importRunId: '', sourceKey: sourceLabel };

    const ingestResult = await ingestFile(filePath, context.ingestOptions ?? {}, config.chunkSize);
    const mapping = findBestMapping(filePath, ingestResult.schemaFingerprint, config);
    lastSchemaFp = ingestResult.schemaFingerprint;
    lastSourceFileHash = ingestResult.sourceFileHash;

    for await (const chunk of ingestResult.records) {
      const normalized: RawRecord[] = [];
      const quarantine: RawRecord[] = [];

      for (const record of chunk) {
        const mapped = mapping ? applyColumnMapping(record, mapping) : record;

        // Add source file tag for backward compat
        mapped._source_file = sourceLabel;

        if (!outputColumns) {
          outputColumns = ['_source_file', '_source_key', '_source_batch_id', '_import_run_id', '_schema_fingerprint', '_row_fingerprint', ...Object.keys(mapped).filter((k) => k !== '_source_file' && !k.startsWith('_'))];
        }

        const norm = normalizeRecord(mapped, config);

        // Add lineage
        norm['_source_file'] = sourceLabel;
        norm['_source_key'] = context.sourceKey;
        norm['_source_batch_id'] = context.sourceBatchId;
        norm['_import_run_id'] = context.importRunId;
        norm['_schema_fingerprint'] = ingestResult.schemaFingerprint;

        const reason = businessQuarantineReason(norm, config);
        if (reason) {
          norm['_quarantine_reason'] = reason;
          quarantine.push(norm);
        } else {
          normalized.push(norm);
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
  };
}
