/**
 * Unified file reader — dispatches to CSV or XLSX reader based on extension.
 */

import { extname } from 'node:path';
import { readCsvInChunks, readCsvColumns } from './csv-reader.js';
import { readXlsxInChunks, readXlsxColumns } from './xlsx-reader.js';
import type { ChunkProcessor } from '../types/index.js';

export function detectFormat(filePath: string): 'csv' | 'xlsx' {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.csv' || ext === '.tsv') return 'csv';
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx';
  throw new Error(`Unsupported file format: ${ext}. Use .csv, .tsv, .xlsx, or .xls`);
}

export async function readFileInChunks<T>(
  filePath: string,
  chunkSize: number,
  processor: ChunkProcessor<T>,
): Promise<T[]> {
  const format = detectFormat(filePath);
  if (format === 'csv') {
    return readCsvInChunks(filePath, { chunkSize }, processor);
  }
  return readXlsxInChunks(filePath, { chunkSize }, processor);
}

export async function readColumns(filePath: string): Promise<string[]> {
  const format = detectFormat(filePath);
  if (format === 'csv') {
    return readCsvColumns(filePath);
  }
  return readXlsxColumns(filePath);
}
