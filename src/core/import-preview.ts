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
  /** サンプリングで読んだ行数。MAX_SAMPLE_ROWS に達した場合は全件未満になる */
  totalRows: number;
  /** true のとき totalRows は全件ではなくサンプルの件数（MAX_SAMPLE_ROWS 件で打ち切り） */
  isSampled: boolean;
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
  let totalRows = 0;

  for await (const chunk of ir.records) {
    for (const row of chunk) {
      if (totalRows >= MAX_SAMPLE_ROWS) break;
      totalRows++;
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
    if (totalRows >= MAX_SAMPLE_ROWS) break;
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

  return { autoApplyResult, columnSamples, totalRows, isSampled: totalRows >= MAX_SAMPLE_ROWS, detectedEncoding, fileName };
}
