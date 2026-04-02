import type { IngestResult } from '../types/index.js';

export type InputFormat = 'csv' | 'xlsx';

/**
 * Internal canonical table model consumed by downstream pipeline.
 * Format differences are absorbed at adapter boundary.
 */
export type CanonicalTable = IngestResult;
