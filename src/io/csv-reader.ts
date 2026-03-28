/**
 * Stream-based CSV reader with chunk processing.
 */

import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import type { RawRecord, ChunkProcessor } from '../types/index.js';

export interface CsvReaderOptions {
  chunkSize: number;
  encoding?: BufferEncoding;
  delimiter?: string;
}

/**
 * Read a CSV file in chunks, calling processor for each chunk.
 * Never loads the entire file into memory.
 */
export async function readCsvInChunks<T>(
  filePath: string,
  options: CsvReaderOptions,
  processor: ChunkProcessor<T>,
): Promise<T[]> {
  const results: T[] = [];
  let chunk: RawRecord[] = [];
  let chunkIndex = 0;

  const parser = createReadStream(filePath, {
    encoding: options.encoding ?? 'utf-8',
  }).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter: options.delimiter,
      relax_column_count: true,
      bom: true,
    }),
  );

  for await (const record of parser) {
    chunk.push(record as RawRecord);
    if (chunk.length >= options.chunkSize) {
      results.push(await processor(chunk, chunkIndex++));
      chunk = [];
    }
  }

  if (chunk.length > 0) {
    results.push(await processor(chunk, chunkIndex));
  }

  return results;
}

/** Read CSV and return all column names (from the first record). */
export async function readCsvColumns(filePath: string): Promise<string[]> {
  const parser = createReadStream(filePath, { encoding: 'utf-8' }).pipe(
    parse({ columns: true, to: 1, bom: true }),
  );
  for await (const record of parser) {
    return Object.keys(record as RawRecord);
  }
  return [];
}
