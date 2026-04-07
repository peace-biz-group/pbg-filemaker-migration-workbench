import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { ingestFile } from '../io/file-reader.js';
import { writeCsv, appendCsv } from '../io/csv-writer.js';
import type {
  CsvIngestDiagnosis,
  RawRecord,
  SplitDiagnosisSummary,
  SplitHeaderDecisionResolvedFrom,
  SplitManifest,
  SplitPartMeta,
} from '../types/index.js';
import type { IngestOptions } from '../ingest/ingest-options.js';

export interface SplitCsvFileOptions {
  outputDir: string;
  rowsPerPart?: number;
  ingestOptions?: IngestOptions;
  chunkSize?: number;
}

const DEFAULT_ROWS_PER_PART = 500_000;
const DEFAULT_CHUNK_SIZE = 5_000;

function stemOf(filePath: string): string {
  return basename(filePath, extname(filePath));
}

function toSplitDiagnosisSummary(diagnosis: unknown): SplitDiagnosisSummary {
  if (!diagnosis || typeof diagnosis !== 'object' || !('format' in diagnosis) || diagnosis.format !== 'csv') {
    return {};
  }
  const csvDiagnosis = diagnosis as CsvIngestDiagnosis;
  return {
    appliedEncoding: csvDiagnosis.appliedEncoding,
    appliedDelimiter: csvDiagnosis.appliedDelimiter,
    requestedQuoteMode: csvDiagnosis.requestedQuoteMode,
    appliedQuoteMode: csvDiagnosis.appliedQuoteMode,
  };
}

function projectRow(row: RawRecord, columns: string[]): RawRecord {
  return Object.fromEntries(columns.map((column) => [column, row[column] ?? '']));
}

export function defaultSplitOutputDir(baseOutputDir: string, filePath: string): string {
  return join(baseOutputDir, 'splits', stemOf(filePath));
}

export function saveSplitManifest(manifestPath: string, manifest: SplitManifest): void {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

export function updateSplitManifestStage(
  manifest: SplitManifest,
  stage: SplitManifest['stage'],
): SplitManifest {
  return {
    ...manifest,
    stage,
  };
}

/**
 * split manifest から part 実行用 ingest を組み立てる（hasHeader は part ファイル形状と一致させる）
 */
export function buildPartIngestOptionsFromManifest(
  manifest: SplitManifest,
  base?: IngestOptions,
): IngestOptions {
  const partFilesIncludeHeaderRow = manifest.seed.partFilesIncludeHeaderRow ?? true;
  const merged: IngestOptions = {
    ...(base ?? {}),
    hasHeader: partFilesIncludeHeaderRow,
  };
  const sd = manifest.sourceDiagnosis;
  if (merged.encoding === undefined && sd.appliedEncoding) merged.encoding = sd.appliedEncoding;
  if (merged.delimiter === undefined && sd.appliedDelimiter) merged.delimiter = sd.appliedDelimiter;
  if (merged.csvQuoteMode === undefined && sd.requestedQuoteMode) merged.csvQuoteMode = sd.requestedQuoteMode;
  return merged;
}

function splitHeaderDecisionResolvedFrom(
  ingestOptions?: IngestOptions,
): SplitHeaderDecisionResolvedFrom {
  const h = ingestOptions?.hasHeader;
  if (h === true || h === false) return 'ingest_options_explicit';
  return 'split_source_ingest';
}

export async function splitCsvFile(
  filePath: string,
  options: SplitCsvFileOptions,
): Promise<SplitManifest> {
  const rowsPerPart = options.rowsPerPart ?? DEFAULT_ROWS_PER_PART;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });

  const ingestResult = await ingestFile(filePath, {
    ...(options.ingestOptions ?? {}),
    debugContext: options.ingestOptions?.debugContext ?? 'core:splitCsvFile',
  }, chunkSize);

  const columns = ingestResult.columns;
  const sourceDiagnosis = toSplitDiagnosisSummary(ingestResult.diagnosis);
  const originalHeaderApplied = ingestResult.diagnosis.headerApplied;
  const partFilesIncludeHeaderRow = originalHeaderApplied;
  const parts: SplitPartMeta[] = [];

  let totalRows = 0;
  let currentPartIndex = 0;
  let currentPartRows = 0;
  let currentPartPath = '';
  let currentPartInitialized = false;
  let currentBatch: RawRecord[] = [];

  const startPart = () => {
    currentPartIndex++;
    currentPartRows = 0;
    currentPartPath = join(outputDir, `part-${String(currentPartIndex).padStart(4, '0')}.csv`);
    currentPartInitialized = false;
    parts.push({
      partIndex: currentPartIndex,
      filePath: currentPartPath,
      rowCount: 0,
      schemaFingerprint: ingestResult.schemaFingerprint,
      sourceFileHash: ingestResult.sourceFileHash,
      diagnosis: sourceDiagnosis,
    });
  };

  const flushCurrentBatch = async () => {
    if (currentBatch.length === 0) return;
    if (!currentPartInitialized) {
      await writeCsv(currentPartPath, currentBatch, columns, { includeHeader: partFilesIncludeHeaderRow });
      currentPartInitialized = true;
    } else {
      await appendCsv(currentPartPath, currentBatch, columns);
    }
    currentPartRows += currentBatch.length;
    parts[parts.length - 1]!.rowCount = currentPartRows;
    currentBatch = [];
  };

  for await (const chunk of ingestResult.records) {
    for (const row of chunk) {
      if (currentPartIndex === 0 || currentPartRows >= rowsPerPart) {
        await flushCurrentBatch();
        startPart();
      }
      currentBatch.push(projectRow(row, columns));
      totalRows++;
      if (currentBatch.length + currentPartRows >= rowsPerPart) {
        await flushCurrentBatch();
      }
    }
  }
  await flushCurrentBatch();

  const manifest: SplitManifest = {
    version: 1,
    sourceFile: resolve(filePath),
    generatedAt: new Date().toISOString(),
    rowsPerPart,
    totalParts: parts.length,
    totalRows,
    columns,
    schemaFingerprint: ingestResult.schemaFingerprint,
    stage: 'split_completed',
    sourceDiagnosis,
    seed: {
      sourceFile: resolve(filePath),
      schemaFingerprint: ingestResult.schemaFingerprint,
      firstPartPath: parts[0]?.filePath ?? '',
      lastReusableRunId: null,
      originalHeaderApplied,
      originalHasHeaderRequested: options.ingestOptions?.hasHeader ?? 'auto',
      originalWeakHeaderDetected: false,
      originalColumns: [...columns],
      partFilesIncludeHeaderRow,
      headerDecisionResolvedFrom: splitHeaderDecisionResolvedFrom(options.ingestOptions),
    },
    parts,
  };

  saveSplitManifest(join(outputDir, 'split-manifest.json'), manifest);
  return manifest;
}
