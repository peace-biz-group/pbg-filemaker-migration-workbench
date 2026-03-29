/**
 * Unified file reader — dispatches to CSV or XLSX reader based on extension.
 */

import { extname } from 'node:path';
import { ingestCsv } from '../ingest/csv-ingest.js';
import { ingestXlsx } from '../ingest/xlsx-ingest.js';
import { readCsvInChunks, readCsvColumns } from './csv-reader.js';
import { readXlsxInChunks, readXlsxColumns } from './xlsx-reader.js';
import type { ChunkProcessor, IngestResult } from '../types/index.js';
import type { IngestOptions } from '../ingest/ingest-options.js';

export function detectFormat(filePath: string): 'csv' | 'xlsx' {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.csv' || ext === '.tsv') return 'csv';
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx';
  throw new Error(`Unsupported file format: ${ext}. Use .csv, .tsv, .xlsx, or .xls`);
}

export async function ingestFile(filePath: string, options: IngestOptions = {}, chunkSize = 5000): Promise<IngestResult> {
  const format = detectFormat(filePath);
  if (format === 'csv') return ingestCsv(filePath, options, chunkSize);
  return ingestXlsx(filePath, options, chunkSize);
}

export async function readFileInChunks<T>(
  filePath: string,
  chunkSize: number,
  processor: ChunkProcessor<T>,
  ingestOptions?: IngestOptions,
): Promise<T[]> {
  const format = detectFormat(filePath);
  if (format === 'csv') {
    return readCsvInChunks(filePath, { chunkSize, ...(ingestOptions ?? {}) }, processor);
  }
  return readXlsxInChunks(filePath, { chunkSize }, processor);
}

export async function readColumns(filePath: string, ingestOptions?: IngestOptions): Promise<string[]> {
  const format = detectFormat(filePath);
  if (format === 'csv') return readCsvColumns(filePath, ingestOptions);
  return readXlsxColumns(filePath);
}
