/**
 * Stream-based CSV reader with chunk processing.
 * Thin facade over ingestCsv with the legacy ChunkProcessor API.
 */

import { ingestCsv } from '../ingest/csv-ingest.js';
import type { IngestOptions } from '../ingest/ingest-options.js';
import type { ChunkProcessor } from '../types/index.js';

export interface CsvReaderOptions {
  chunkSize: number;
  encoding?: string;
  delimiter?: string;
}

/** Thin facade — wraps ingestCsv with the legacy ChunkProcessor API. */
export async function readCsvInChunks<T>(
  filePath: string,
  options: CsvReaderOptions & IngestOptions,
  processor: ChunkProcessor<T>,
): Promise<T[]> {
  const result = await ingestCsv(filePath, options, options.chunkSize);
  const results: T[] = [];
  let idx = 0;
  for await (const chunk of result.records) {
    results.push(await processor(chunk, idx++));
  }
  return results;
}

/** Read column names from first row. */
export async function readCsvColumns(filePath: string, opts?: IngestOptions): Promise<string[]> {
  const result = await ingestCsv(filePath, { ...(opts ?? {}), previewRows: 0 });
  return result.columns;
}
