/**
 * Unified file reader — canonical ingest model with format adapters at the boundary.
 */

import type { ChunkProcessor, IngestResult } from '../types/index.js';
import type { IngestOptions } from '../ingest/ingest-options.js';
import {
  detectInputFormat,
  ingestToCanonical,
  processCanonicalInChunks,
  readCanonicalColumns,
} from '../ingest/canonical-ingest.js';

export function detectFormat(filePath: string): 'csv' | 'xlsx' {
  return detectInputFormat(filePath);
}

export async function ingestFile(filePath: string, options: IngestOptions = {}, chunkSize = 5000): Promise<IngestResult> {
  return ingestToCanonical(filePath, options, chunkSize);
}

export async function readFileInChunks<T>(
  filePath: string,
  chunkSize: number,
  processor: ChunkProcessor<T>,
  ingestOptions?: IngestOptions,
): Promise<T[]> {
  return processCanonicalInChunks(filePath, chunkSize, processor, ingestOptions ?? {});
}

export async function readColumns(filePath: string, ingestOptions?: IngestOptions): Promise<string[]> {
  return readCanonicalColumns(filePath, ingestOptions ?? {});
}
