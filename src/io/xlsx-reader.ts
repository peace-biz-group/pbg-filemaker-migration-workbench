/**
 * XLSX reader — reads sheet by sheet, converts to chunks of RawRecord.
 * Uses xlsx (SheetJS) which reads sheets into memory per-sheet.
 * For very large XLSX files, consider converting to CSV first.
 */

import * as XLSX from 'xlsx';
import { readWorkbookFromFile } from './xlsx-workbook.js';
import type { RawRecord, ChunkProcessor } from '../types/index.js';

export interface XlsxReaderOptions {
  chunkSize: number;
  sheetName?: string;
}

/**
 * Read an XLSX file and process in chunks.
 * Reads the target sheet into memory, then processes in chunks.
 */
export async function readXlsxInChunks<T>(
  filePath: string,
  options: XlsxReaderOptions,
  processor: ChunkProcessor<T>,
): Promise<T[]> {
  const workbook = readWorkbookFromFile(filePath);
  const sheetName = options.sheetName ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" not found. Available: ${workbook.SheetNames.join(', ')}`);
  }

  const allRecords: RawRecord[] = XLSX.utils.sheet_to_json(sheet, {
    defval: '',
    raw: false,
  });

  const results: T[] = [];
  for (let i = 0; i < allRecords.length; i += options.chunkSize) {
    const chunk = allRecords.slice(i, i + options.chunkSize);
    results.push(await processor(chunk, Math.floor(i / options.chunkSize)));
  }

  return results;
}

/** Get column names from the first row of an XLSX sheet. */
export function readXlsxColumns(filePath: string, sheetName?: string): string[] {
  const workbook = readWorkbookFromFile(filePath);
  const name = sheetName ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[name];
  if (!sheet) return [];
  const rows: RawRecord[] = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  return rows.length > 0 ? Object.keys(rows[0]) : [];
}
