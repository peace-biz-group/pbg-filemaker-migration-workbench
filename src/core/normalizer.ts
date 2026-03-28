/**
 * Record normalizer — applies column mapping + normalization rules to each record in chunks.
 */

import type { RawRecord } from '../types/index.js';
import type { WorkbenchConfig } from '../config/schema.js';
import { readFileInChunks } from '../io/file-reader.js';
import { writeCsv, appendCsv } from '../io/csv-writer.js';
import { normalizePhone } from '../normalizers/phone.js';
import { normalizeEmail } from '../normalizers/email.js';
import { normalizeText } from '../normalizers/text.js';
import { normalizeDate } from '../normalizers/date.js';
import { normalizeCompanyName, normalizeAddress, normalizeStoreName } from '../normalizers/company.js';
import { findColumnMapping, applyColumnMapping, mapColumnNames } from './column-mapper.js';
import { join } from 'node:path';
import { ensureOutputDir } from '../io/report-writer.js';

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

function isQuarantine(record: RawRecord, config: WorkbenchConfig): boolean {
  // A record goes to quarantine if ALL key identifier fields are empty
  const allKeyFields = [
    ...config.canonicalFields.phone,
    ...config.canonicalFields.email,
    ...config.canonicalFields.name,
    ...config.canonicalFields.companyName,
    ...config.canonicalFields.storeName,
  ];

  for (const fieldPattern of allKeyFields) {
    for (const [key, val] of Object.entries(record)) {
      if (key.toLowerCase() === fieldPattern.toLowerCase() && val?.trim()) {
        return false;
      }
    }
  }
  return true;
}

export interface NormalizeResult {
  normalizedCount: number;
  quarantineCount: number;
  normalizedPath: string;
  quarantinePath: string;
}

/**
 * Normalize a single file. Applies column mapping if matched, then normalization rules.
 * @param filePath Input file path
 * @param config Workbench config
 * @param outputSuffix Optional suffix for output files (for multi-file runs)
 * @param appendMode If true, append to existing output files instead of overwriting
 */
export async function normalizeFile(
  filePath: string,
  config: WorkbenchConfig,
  outputSuffix?: string,
  appendMode?: boolean,
): Promise<NormalizeResult> {
  ensureOutputDir(config.outputDir);
  const suffix = outputSuffix ? `_${outputSuffix}` : '';
  const normalizedPath = join(config.outputDir, `normalized${suffix}.csv`);
  const quarantinePath = join(config.outputDir, `quarantine${suffix}.csv`);

  // Find column mapping for this file
  const mapping = findColumnMapping(filePath, config);

  let normalizedCount = 0;
  let quarantineCount = 0;
  let columns: string[] | undefined;
  let mappedColumns: string[] | undefined;
  let isFirst = !appendMode;

  await readFileInChunks(filePath, config.chunkSize, async (chunk, _idx) => {
    const normalized: RawRecord[] = [];
    const quarantine: RawRecord[] = [];

    for (const record of chunk) {
      if (!columns) {
        columns = Object.keys(record);
        mappedColumns = mapping ? mapColumnNames(columns, mapping) : columns;
      }

      // Apply column mapping
      const mapped = mapping ? applyColumnMapping(record, mapping) : record;

      // Apply normalization
      const norm = normalizeRecord(mapped, config);

      if (isQuarantine(norm, config)) {
        quarantine.push(norm);
      } else {
        normalized.push(norm);
      }
    }

    if (isFirst) {
      await writeCsv(normalizedPath, normalized, mappedColumns);
      await writeCsv(quarantinePath, quarantine, mappedColumns);
      isFirst = false;
    } else {
      await appendCsv(normalizedPath, normalized, mappedColumns!);
      await appendCsv(quarantinePath, quarantine, mappedColumns!);
    }

    normalizedCount += normalized.length;
    quarantineCount += quarantine.length;
  });

  return { normalizedCount, quarantineCount, normalizedPath, quarantinePath };
}

/**
 * Normalize multiple files into a single merged output.
 * Each file's records get a _source_file column for traceability.
 */
export async function normalizeFiles(
  filePaths: { path: string; label?: string }[],
  config: WorkbenchConfig,
): Promise<NormalizeResult> {
  ensureOutputDir(config.outputDir);
  const normalizedPath = join(config.outputDir, 'normalized.csv');
  const quarantinePath = join(config.outputDir, 'quarantine.csv');

  let totalNormalized = 0;
  let totalQuarantine = 0;
  let isFirst = true;
  let outputColumns: string[] | undefined;

  for (const { path: filePath, label } of filePaths) {
    const sourceLabel = label ?? filePath;
    const mapping = findColumnMapping(filePath, config);

    await readFileInChunks(filePath, config.chunkSize, async (chunk, _idx) => {
      const normalized: RawRecord[] = [];
      const quarantine: RawRecord[] = [];

      for (const record of chunk) {
        // Apply column mapping
        const mapped = mapping ? applyColumnMapping(record, mapping) : record;

        // Add source file tag
        mapped._source_file = sourceLabel;

        if (!outputColumns) {
          outputColumns = ['_source_file', ...Object.keys(mapped).filter((k) => k !== '_source_file')];
        }

        // Apply normalization
        const norm = normalizeRecord(mapped, config);

        if (isQuarantine(norm, config)) {
          quarantine.push(norm);
        } else {
          normalized.push(norm);
        }
      }

      if (isFirst) {
        await writeCsv(normalizedPath, normalized, outputColumns);
        await writeCsv(quarantinePath, quarantine, outputColumns);
        isFirst = false;
      } else {
        await appendCsv(normalizedPath, normalized, outputColumns!);
        await appendCsv(quarantinePath, quarantine, outputColumns!);
      }

      totalNormalized += normalized.length;
      totalQuarantine += quarantine.length;
    });
  }

  return {
    normalizedCount: totalNormalized,
    quarantineCount: totalQuarantine,
    normalizedPath,
    quarantinePath,
  };
}
