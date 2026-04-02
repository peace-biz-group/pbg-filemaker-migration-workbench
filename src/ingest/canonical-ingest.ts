import { extname } from 'node:path';
import { ingestCsv } from './csv-ingest.js';
import { ingestXlsx } from './xlsx-ingest.js';
import type { IngestOptions } from './ingest-options.js';
import type { ChunkProcessor } from '../types/index.js';
import type { CanonicalTable, InputFormat } from './canonical-table.js';

interface IngestAdapter {
  ingest: (filePath: string, options: IngestOptions, chunkSize: number) => Promise<CanonicalTable>;
}

const adapters: Record<InputFormat, IngestAdapter> = {
  csv: { ingest: ingestCsv },
  xlsx: { ingest: ingestXlsx },
};

export function detectInputFormat(filePath: string): InputFormat {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.csv' || ext === '.tsv') return 'csv';
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx';
  throw new Error(`Unsupported file format: ${ext}. Use .csv, .tsv, .xlsx, or .xls`);
}

export async function ingestToCanonical(
  filePath: string,
  options: IngestOptions = {},
  chunkSize = 5000,
): Promise<CanonicalTable> {
  const format = detectInputFormat(filePath);
  return adapters[format].ingest(filePath, options, chunkSize);
}

export async function processCanonicalInChunks<T>(
  filePath: string,
  chunkSize: number,
  processor: ChunkProcessor<T>,
  options: IngestOptions = {},
): Promise<T[]> {
  const canonical = await ingestToCanonical(filePath, options, chunkSize);
  const results: T[] = [];
  let chunkIndex = 0;
  for await (const chunk of canonical.records) {
    results.push(await processor(chunk, chunkIndex));
    chunkIndex++;
  }
  return results;
}

export async function readCanonicalColumns(filePath: string, options: IngestOptions = {}): Promise<string[]> {
  const canonical = await ingestToCanonical(filePath, options, 1);
  return canonical.columns;
}
