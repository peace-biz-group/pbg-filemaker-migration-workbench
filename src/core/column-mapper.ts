/**
 * Column mapper — applies columnMappings from config to rename source columns to canonical names.
 * Matches file names against glob-like patterns in the config.
 */

import { basename } from 'node:path';
import type { RawRecord, MappingSuggestion } from '../types/index.js';
import type { WorkbenchConfig } from '../config/schema.js';

/**
 * Simple glob match: supports * as wildcard.
 * "apo_list_*.csv" matches "apo_list_2024.csv"
 */
export function globMatch(pattern: string, fileName: string): boolean {
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

/**
 * Find mapping by schema fingerprint first, then filename pattern, then index.
 */
export function findBestMapping(
  filePath: string,
  schemaFp: string,
  config: WorkbenchConfig,
): Record<string, string> | null {
  // 1. Schema fingerprint mapping
  if (config.schemaMappings && config.schemaMappings[schemaFp]) return config.schemaMappings[schemaFp]!;
  // 2. Filename pattern mapping (columnMappings)
  const nameMapping = findColumnMapping(filePath, config);
  if (nameMapping) return nameMapping;
  // 3. Index mapping
  const fileName = basename(filePath);
  for (const [pattern, mapping] of Object.entries(config.indexMappings ?? {})) {
    if (globMatch(pattern, fileName)) return mapping;
  }
  return null;
}

const SUGGESTION_PATTERNS: Array<{ field: string; re: RegExp; confidence: 'high' | 'medium' }> = [
  { field: 'phone',         re: /tel|phone|電話|携帯|fax/i,       confidence: 'high' },
  { field: 'email',         re: /mail|email/i,                    confidence: 'high' },
  { field: 'contract_date', re: /date|日付|日$|_at$/i,            confidence: 'medium' },
  { field: 'customer_name', re: /name|氏名|名前/i,               confidence: 'medium' },
  { field: 'address',       re: /address|住所|所在地/i,          confidence: 'medium' },
];

export function generateMappingSuggestions(
  schemaFp: string,
  columns: string[],
): { schemaFingerprint: string; columns: string[]; suggestions: MappingSuggestion[] } {
  const suggestions: MappingSuggestion[] = [];
  for (const col of columns) {
    for (const { field, re, confidence } of SUGGESTION_PATTERNS) {
      if (re.test(col)) {
        suggestions.push({ sourceColumn: col, suggestedCanonical: field, confidence, reason: 'name_pattern' });
        break;
      }
    }
  }
  return { schemaFingerprint: schemaFp, columns, suggestions };
}
