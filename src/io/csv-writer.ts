/**
 * CSV writer — writes records to CSV files.
 */

import { createWriteStream } from 'node:fs';
import { stringify } from 'csv-stringify';
import type { RawRecord } from '../types/index.js';

/**
 * Write an array of records to a CSV file.
 * Uses streaming to avoid building the entire output in memory.
 */
export async function writeCsv(
  filePath: string,
  records: RawRecord[],
  columns?: string[],
  options?: { includeHeader?: boolean },
): Promise<void> {
  const includeHeader = options?.includeHeader !== false;

  if (records.length === 0) {
    return new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(filePath);
      ws.on('error', reject);
      ws.on('finish', resolve);
      if (columns && includeHeader) {
        ws.write(columns.join(',') + '\n');
      }
      ws.end();
    });
  }

  const cols = columns ?? Object.keys(records[0]);

  return new Promise((resolve, reject) => {
    const ws = createWriteStream(filePath);
    const stringifier = stringify({ header: includeHeader, columns: cols });
    stringifier.pipe(ws);
    stringifier.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);

    for (const record of records) {
      stringifier.write(record);
    }
    stringifier.end();
  });
}

/**
 * Append records to an existing CSV (no header re-write).
 */
export async function appendCsv(
  filePath: string,
  records: RawRecord[],
  columns: string[],
): Promise<void> {
  if (records.length === 0) return;

  return new Promise((resolve, reject) => {
    const ws = createWriteStream(filePath, { flags: 'a' });
    const stringifier = stringify({ header: false, columns });
    stringifier.pipe(ws);
    stringifier.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);

    for (const record of records) {
      stringifier.write(record);
    }
    stringifier.end();
  });
}
