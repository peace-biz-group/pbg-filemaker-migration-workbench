/**
 * Column mapper — applies columnMappings from config to rename source columns to canonical names.
 * Matches file names against glob-like patterns in the config.
 */

import { basename } from 'node:path';
import type { RawRecord } from '../types/index.js';
import type { WorkbenchConfig } from '../config/schema.js';

/**
 * Simple glob match: supports * as wildcard.
 * "apo_list_*.csv" matches "apo_list_2024.csv"
 */
function globMatch(pattern: string, fileName: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    'i',
  );
  return regex.test(fileName);
}

/**
 * Find the column mapping that matches the given file name.
 * Returns the mapping (source → canonical) or null if no match.
 */
export function findColumnMapping(
  filePath: string,
  config: WorkbenchConfig,
): Record<string, string> | null {
  const fileName = basename(filePath);
  for (const [pattern, mapping] of Object.entries(config.columnMappings)) {
    if (globMatch(pattern, fileName)) {
      return mapping;
    }
  }
  return null;
}

/**
 * Apply column mapping to a record: rename keys from source names to canonical names.
 * Columns not in the mapping are kept with their original names.
 */
export function applyColumnMapping(
  record: RawRecord,
  mapping: Record<string, string>,
): RawRecord {
  const result: RawRecord = {};
  for (const [key, value] of Object.entries(record)) {
    const canonicalName = mapping[key] ?? key;
    result[canonicalName] = value;
  }
  return result;
}

/**
 * Get the mapped column names (preserving order, applying renames).
 */
export function mapColumnNames(
  originalColumns: string[],
  mapping: Record<string, string>,
): string[] {
  return originalColumns.map((col) => mapping[col] ?? col);
}
