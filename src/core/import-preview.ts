// src/core/import-preview.ts
import type { CsvIngestDiagnosis } from '../types/index.js';
import { ingestFile } from '../io/file-reader.js';
import { runAutoApplyPreview, type AutoApplyPreviewResult } from './auto-apply-orchestrator.js';

export interface ColumnSample {
  nonEmptyCount: number;
  topValues: Array<{ value: string; count: number }>;
}

export interface ImportPreviewResult {
  autoApplyResult: AutoApplyPreviewResult;
  columnSamples: Record<string, ColumnSample>;
  sampledRows: number;
  detectedEncoding: string;
  fileName: string;
}

const MAX_SAMPLE_ROWS = 100_000;

export async function runImportPreview(
  filePath: string,
  fileName: string,
  outputDir: string,
): Promise<ImportPreviewResult> {
  const ir = await ingestFile(filePath, { encoding: 'auto' }, 5000);

  const columns = ir.columns;
  const detectedEncoding =
    ir.diagnosis.format === 'csv'
      ? (ir.diagnosis as CsvIngestDiagnosis).appliedEncoding
      : 'xlsx';

  // Per-column frequency counting (up to MAX_SAMPLE_ROWS to handle large files)
  const frequencies = new Map<string, Map<string, number>>();
  const nonEmptyCounts = new Map<string, number>();
  let sampledRows = 0;

  for await (const chunk of ir.records) {
    for (const row of chunk) {
      if (sampledRows >= MAX_SAMPLE_ROWS) break;
      sampledRows++;
      for (const [col, val] of Object.entries(row)) {
        const v = (val ?? '').toString().trim();
        if (v) {
          if (!frequencies.has(col)) frequencies.set(col, new Map());
          const m = frequencies.get(col)!;
          m.set(v, (m.get(v) ?? 0) + 1);
          nonEmptyCounts.set(col, (nonEmptyCounts.get(col) ?? 0) + 1);
        }
      }
    }
    if (sampledRows >= MAX_SAMPLE_ROWS) break;
  }

  const columnSamples: Record<string, ColumnSample> = {};
  for (const col of columns) {
    const m = frequencies.get(col) ?? new Map<string, number>();
    const topValues = [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([value, count]) => ({ value, count }));
    columnSamples[col] = {
      nonEmptyCount: nonEmptyCounts.get(col) ?? 0,
      topValues,
    };
  }

  const autoApplyResult = runAutoApplyPreview(
    columns,
    detectedEncoding,
    ir.diagnosis.headerApplied,
    ir.schemaFingerprint,
    outputDir,
  );

  return { autoApplyResult, columnSamples, sampledRows, detectedEncoding, fileName };
}
