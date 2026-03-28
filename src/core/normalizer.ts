/**
 * Record normalizer — applies normalization rules to each record in chunks.
 */

import type { RawRecord } from '../types/index.js';
import type { WorkbenchConfig } from '../config/schema.js';
import { readFileInChunks } from '../io/file-reader.js';
import { writeCsv, appendCsv } from '../io/csv-writer.js';
import { normalizePhone } from '../normalizers/phone.js';
import { normalizeEmail } from '../normalizers/email.js';
import { normalizeText } from '../normalizers/text.js';
import { normalizeDate } from '../normalizers/date.js';
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

export async function normalizeFile(
  filePath: string,
  config: WorkbenchConfig,
): Promise<NormalizeResult> {
  ensureOutputDir(config.outputDir);
  const normalizedPath = join(config.outputDir, 'normalized.csv');
  const quarantinePath = join(config.outputDir, 'quarantine.csv');

  let normalizedCount = 0;
  let quarantineCount = 0;
  let columns: string[] | undefined;
  let isFirst = true;

  await readFileInChunks(filePath, config.chunkSize, async (chunk, _idx) => {
    const normalized: RawRecord[] = [];
    const quarantine: RawRecord[] = [];

    for (const record of chunk) {
      if (!columns) columns = Object.keys(record);
      const norm = normalizeRecord(record, config);
      if (isQuarantine(norm, config)) {
        quarantine.push(norm);
      } else {
        normalized.push(norm);
      }
    }

    if (isFirst) {
      await writeCsv(normalizedPath, normalized, columns);
      await writeCsv(quarantinePath, quarantine, columns);
      isFirst = false;
    } else {
      await appendCsv(normalizedPath, normalized, columns!);
      await appendCsv(quarantinePath, quarantine, columns!);
    }

    normalizedCount += normalized.length;
    quarantineCount += quarantine.length;
  });

  return { normalizedCount, quarantineCount, normalizedPath, quarantinePath };
}
