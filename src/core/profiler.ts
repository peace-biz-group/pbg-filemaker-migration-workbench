/**
 * Data profiler — analyzes columns for missing rates, value distributions, anomalies.
 */

import type { RawRecord, ColumnProfile, ProfileResult, AnomalyRecord } from '../types/index.js';
import type { WorkbenchConfig } from '../config/schema.js';
import { readFileInChunks } from '../io/file-reader.js';
import { validatePhone, normalizePhone } from '../normalizers/phone.js';
import { validateEmail, normalizeEmail } from '../normalizers/email.js';
import { validateDate, normalizeDate } from '../normalizers/date.js';

const VALUE_COUNTS_CAP = 10_000;

interface ColumnAccumulator {
  name: string;
  totalCount: number;
  nonEmptyCount: number;
  valueCounts: Map<string, number>;
  overflowed: boolean;
}

function resolveField(record: RawRecord, candidates: string[]): string | undefined {
  for (const c of candidates) {
    const key = Object.keys(record).find(
      (k) => k.toLowerCase() === c.toLowerCase(),
    );
    if (key && record[key]?.trim()) return record[key].trim();
  }
  return undefined;
}

export async function profileFile(
  filePath: string,
  config: WorkbenchConfig,
): Promise<ProfileResult> {
  const accumulators = new Map<string, ColumnAccumulator>();
  const anomalies: AnomalyRecord[] = [];
  let totalRecords = 0;
  let columnNames: string[] = [];

  await readFileInChunks(filePath, config.chunkSize, async (chunk, _idx) => {
    for (const record of chunk) {
      totalRecords++;
      const rowNum = totalRecords;

      if (columnNames.length === 0) {
        // Skip internal lineage columns (prefixed with _)
        columnNames = Object.keys(record).filter(k => !k.startsWith('_'));
        for (const name of columnNames) {
          accumulators.set(name, {
            name,
            totalCount: 0,
            nonEmptyCount: 0,
            valueCounts: new Map(),
            overflowed: false,
          });
        }
      }

      for (const col of columnNames) {
        const acc = accumulators.get(col)!;
        acc.totalCount++;
        const val = record[col] ?? '';
        if (val.trim()) {
          acc.nonEmptyCount++;
          if (!acc.overflowed) {
            const trimmed = val.trim();
            acc.valueCounts.set(trimmed, (acc.valueCounts.get(trimmed) ?? 0) + 1);
            if (acc.valueCounts.size >= VALUE_COUNTS_CAP) acc.overflowed = true;
          }
        }
      }

      // Check phone anomalies
      const phoneVal = resolveField(record, config.canonicalFields.phone);
      if (phoneVal) {
        const normalized = normalizePhone(phoneVal);
        const issue = validatePhone(normalized);
        if (issue) {
          anomalies.push({ row: rowNum, column: 'phone', value: phoneVal, reason: issue });
        }
      }

      // Check email anomalies
      const emailVal = resolveField(record, config.canonicalFields.email);
      if (emailVal) {
        const normalized = normalizeEmail(emailVal);
        const issue = validateEmail(normalized);
        if (issue) {
          anomalies.push({ row: rowNum, column: 'email', value: emailVal, reason: issue });
        }
      }

      // Check date anomalies — look for columns ending with _date or 日
      for (const col of columnNames) {
        if (col.match(/date|日付|日$/i)) {
          const val = record[col]?.trim();
          if (val) {
            const normalized = normalizeDate(val);
            const issue = validateDate(normalized);
            if (issue) {
              anomalies.push({ row: rowNum, column: col, value: val, reason: issue });
            }
          }
        }
      }
    }
  });

  const columns: ColumnProfile[] = [];
  for (const acc of accumulators.values()) {
    const topValues = [...acc.valueCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([value, count]) => ({ value, count }));

    columns.push({
      name: acc.name,
      totalCount: acc.totalCount,
      nonEmptyCount: acc.nonEmptyCount,
      missingRate: acc.totalCount > 0 ? 1 - acc.nonEmptyCount / acc.totalCount : 0,
      uniqueCount: acc.valueCounts.size,
      uniqueCountCapped: acc.overflowed,
      topValues,
      anomalies: [],
    });
  }

  return {
    fileName: filePath,
    recordCount: totalRecords,
    columnCount: columnNames.length,
    columns,
    anomalies,
  };
}
