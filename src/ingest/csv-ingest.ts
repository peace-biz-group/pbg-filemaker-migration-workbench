import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse';
import iconv from 'iconv-lite';
import type { RawRecord, IngestResult, ParseFailRecord, CsvIngestDiagnosis } from '../types/index.js';
import type { CsvQuoteMode, IngestOptions } from './ingest-options.js';
import { detectEncoding } from './encoding-detector.js';
import { detectDelimiter } from './delimiter-detector.js';
import { fileHash, schemaFingerprint, rowFingerprint } from './fingerprint.js';
import { open } from 'node:fs/promises';

const MAX_WARNINGS = 50;
const DECODE_FAIL_RATIO = 0.5;
const HEADER_PREVIEW_ROWS = 5;
const AUTO_QUOTE_MODE_SEQUENCE = ['strict', 'relaxed', 'literal'] as const;
const QUOTE_PARSE_ERROR_CODES = new Set([
  'CSV_INVALID_CLOSING_QUOTE',
  'INVALID_OPENING_QUOTE',
  'CSV_NON_TRIMABLE_CHAR_AFTER_CLOSING_QUOTE',
  'CSV_QUOTE_NOT_CLOSED',
]);

type ResolvedCsvQuoteMode = Exclude<CsvQuoteMode, 'auto'>;
type RequestedHasHeader = IngestOptions['hasHeader'];

function emitCsvIngestLog(
  debugContext: string | undefined,
  event: 'start' | 'fallback' | 'resolved' | 'parse-error',
  detail: Record<string, unknown>,
): void {
  if (!debugContext && event === 'resolved') return;
  const payload = { event, context: debugContext ?? 'ingestCsv', ...detail };
  const line = `[csv-ingest] ${JSON.stringify(payload)}`;
  if (event === 'fallback' || event === 'parse-error') {
    console.warn(line);
    return;
  }
  console.info(line);
}

async function readSample(filePath: string, bytes: number): Promise<Buffer> {
  const fd = await open(filePath, 'r');
  const buf = Buffer.alloc(bytes);
  const { bytesRead } = await fd.read(buf, 0, bytes, 0);
  await fd.close();
  return buf.subarray(0, bytesRead);
}

function buildCsvParseOptions(
  delimiter: string,
  fromLine: number,
  quoteMode: ResolvedCsvQuoteMode,
  options: {
    bom: boolean;
    toLine?: number;
    relaxColumnCount?: boolean;
  },
) {
  return {
    columns: false,
    skip_empty_lines: true,
    trim: true,
    delimiter,
    from_line: fromLine,
    ...(options.toLine !== undefined ? { to: options.toLine } : {}),
    ...(options.relaxColumnCount ? { relax_column_count: true } : {}),
    ...(quoteMode === 'relaxed' ? { relax_quotes: true } : {}),
    ...(quoteMode === 'literal' ? { quote: false } : {}),
    bom: options.bom,
  };
}

function getQuoteModeSequence(
  requestedQuoteMode: CsvQuoteMode,
  minimumQuoteMode: ResolvedCsvQuoteMode = 'strict',
): readonly ResolvedCsvQuoteMode[] {
  if (requestedQuoteMode !== 'auto') {
    return [requestedQuoteMode];
  }
  return AUTO_QUOTE_MODE_SEQUENCE.slice(AUTO_QUOTE_MODE_SEQUENCE.indexOf(minimumQuoteMode));
}

function isQuoteParseError(err: unknown): boolean {
  if (!err) return false;
  const maybeCode =
    typeof err === 'object' && 'code' in err && typeof err.code === 'string'
      ? err.code
      : undefined;
  if (maybeCode && QUOTE_PARSE_ERROR_CODES.has(maybeCode)) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /quote/i.test(message);
}

function addParseWarning(parseWarnings: string[], message: string): void {
  if (parseWarnings.length < MAX_WARNINGS) {
    parseWarnings.push(message);
  }
}

function buildSyntheticColumns(length: number): string[] {
  return Array.from({ length }, (_, i) => `c${i}`);
}

function isLikelyDataCell(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/https?:\/\//i.test(trimmed)) return true;
  if (/^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/.test(trimmed)) return true;
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) return true;
  if (/^\d{2,4}-\d{2,4}-\d{3,4}$/.test(trimmed)) return true;
  if (/[\u0000-\u001f]/.test(trimmed)) return true;
  if (/^[\d０-９]+$/.test(trimmed)) return true;
  return false;
}

function resolveHeaderApplied(requestedHasHeader: RequestedHasHeader, previewRows: string[][]): boolean {
  if (requestedHasHeader === true) return true;
  if (requestedHasHeader === false) return false;

  const firstRow = previewRows[0] ?? [];
  const nonEmptyCells = firstRow.filter((value) => value.trim());
  if (nonEmptyCells.length === 0) return true;

  const dataLikeCount = nonEmptyCells.filter(isLikelyDataCell).length;
  const sharedNonEmptyColumns = firstRow.filter((value, index) => (
    value.trim() && previewRows.slice(1).some((row) => (row[index] ?? '').trim())
  )).length;

  if (dataLikeCount >= 3) return false;
  if (dataLikeCount >= 2 && sharedNonEmptyColumns >= 2) return false;
  return true;
}

async function readPreviewRows(
  filePath: string,
  encoding: 'utf8' | 'cp932',
  delimiter: string,
  fromLine: number,
  quoteMode: ResolvedCsvQuoteMode,
  rowLimit = HEADER_PREVIEW_ROWS,
): Promise<string[][]> {
  const stream = createReadStream(filePath);
  const decoded = stream.pipe(iconv.decodeStream(encoding));
  const parser = decoded.pipe(parse(buildCsvParseOptions(
    delimiter,
    fromLine,
    quoteMode,
    {
      bom: encoding === 'utf8',
      toLine: fromLine + rowLimit - 1,
      relaxColumnCount: true,
    },
  )));

  const previewRows: string[][] = [];
  try {
    for await (const row of parser) {
      previewRows.push((row as string[]).map(String));
      if (previewRows.length >= rowLimit) break;
    }
  } finally {
    stream.destroy();
  }

  return previewRows;
}

async function resolvePeekColumns(
  filePath: string,
  encoding: 'utf8' | 'cp932',
  delimiter: string,
  requestedHasHeader: RequestedHasHeader,
  skipRows: number,
  requestedQuoteMode: CsvQuoteMode,
  debugContext?: string,
): Promise<{ columns: string[]; quoteMode: ResolvedCsvQuoteMode; headerApplied: boolean }> {
  const fromLine = skipRows + 1;
  let lastQuoteError: unknown;

  for (const quoteMode of getQuoteModeSequence(requestedQuoteMode)) {
    try {
      const firstRow = (await readPreviewRows(filePath, encoding, delimiter, fromLine, quoteMode, 1))[0] ?? [];
      let previewRows = [firstRow];
      if (requestedHasHeader === 'auto') {
        try {
          previewRows = await readPreviewRows(filePath, encoding, delimiter, fromLine, quoteMode);
        } catch {
          previewRows = [firstRow];
        }
      }
      const headerApplied = resolveHeaderApplied(requestedHasHeader, previewRows);
      if (!firstRow.length) {
        return { columns: [], quoteMode, headerApplied };
      }
      return {
        columns: headerApplied ? firstRow : buildSyntheticColumns(firstRow.length),
        quoteMode,
        headerApplied,
      };
    } catch (err) {
      if (requestedQuoteMode !== 'auto' || !isQuoteParseError(err)) {
        throw err;
      }
      emitCsvIngestLog(debugContext, 'fallback', {
        filePath,
        stage: 'peekColumns',
        requestedQuoteMode,
        fromQuoteMode: quoteMode,
        toQuoteMode: getQuoteModeSequence(requestedQuoteMode)[getQuoteModeSequence(requestedQuoteMode).indexOf(quoteMode) + 1],
        error: err instanceof Error ? err.message : String(err),
      });
      lastQuoteError = err;
    }
  }

  throw lastQuoteError;
}

async function probeQuoteMode(
  filePath: string,
  encoding: 'utf8' | 'cp932',
  delimiter: string,
  fromLine: number,
  requestedQuoteMode: CsvQuoteMode,
  minimumQuoteMode: ResolvedCsvQuoteMode,
  previewLimit?: number,
  debugContext?: string,
): Promise<ResolvedCsvQuoteMode> {
  if (previewLimit === 0) {
    return minimumQuoteMode;
  }

  let lastQuoteError: unknown;

  for (const quoteMode of getQuoteModeSequence(requestedQuoteMode, minimumQuoteMode)) {
    const stream = createReadStream(filePath);
    const decoded = stream.pipe(iconv.decodeStream(encoding));
    const parser = decoded.pipe(parse(buildCsvParseOptions(
      delimiter,
      fromLine,
      quoteMode,
      {
        bom: false,
        relaxColumnCount: true,
      },
    )));

    try {
      let rowCount = 0;
      for await (const _row of parser) {
        rowCount++;
        if (previewLimit !== undefined && rowCount >= previewLimit) {
          break;
        }
      }
      return quoteMode;
    } catch (err) {
      if (requestedQuoteMode !== 'auto' || !isQuoteParseError(err)) {
        throw err;
      }
      emitCsvIngestLog(debugContext, 'fallback', {
        filePath,
        stage: 'bodyProbe',
        requestedQuoteMode,
        fromQuoteMode: quoteMode,
        toQuoteMode: getQuoteModeSequence(requestedQuoteMode, minimumQuoteMode)[getQuoteModeSequence(requestedQuoteMode, minimumQuoteMode).indexOf(quoteMode) + 1],
        error: err instanceof Error ? err.message : String(err),
      });
      lastQuoteError = err;
    } finally {
      stream.destroy();
    }
  }

  throw lastQuoteError;
}

export async function ingestCsv(
  filePath: string,
  options: IngestOptions = {},
  chunkSize = 5000,
): Promise<IngestResult> {
  // Resolve encoding
  const encResult = await detectEncoding(filePath);
  const appliedEncoding: 'utf8' | 'cp932' =
    options.encoding && options.encoding !== 'auto' ? options.encoding : encResult.appliedEncoding;

  // Resolve delimiter
  const sample2k = await readSample(filePath, 2048);
  const decodedSample = iconv.decode(sample2k, appliedEncoding);
  const detectedDelimiter = detectDelimiter(decodedSample);
  const appliedDelimiter: ',' | '\t' | ';' =
    options.delimiter && options.delimiter !== 'auto' ? options.delimiter : detectedDelimiter;

  const requestedHasHeader = options.hasHeader ?? 'auto';
  const skipRows = options.skipRows ?? 0;
  const requestedQuoteMode = options.csvQuoteMode ?? 'auto';
  const debugContext = options.debugContext;
  const previewLimit = options.previewRows;

  emitCsvIngestLog(debugContext, 'start', {
    filePath,
    requestedQuoteMode,
  });

  // Resolve quote mode while keeping the parser stream-based.
  const peekResult = await resolvePeekColumns(
    filePath,
    appliedEncoding,
    appliedDelimiter,
    requestedHasHeader,
    skipRows,
    requestedQuoteMode,
    debugContext,
  );
  const headerApplied = peekResult.headerApplied;
  const fromLine = headerApplied ? skipRows + 2 : skipRows + 1;
  const appliedQuoteMode = await probeQuoteMode(
    filePath,
    appliedEncoding,
    appliedDelimiter,
    fromLine,
    requestedQuoteMode,
    peekResult.quoteMode,
    previewLimit,
    debugContext,
  );

  const columns = peekResult.columns;
  const schemaFp = schemaFingerprint(columns);
  const srcHash = await fileHash(filePath);

  const parseFailures: ParseFailRecord[] = [];
  const parseWarnings: string[] = [];

  const diagnosis: CsvIngestDiagnosis = {
    format: 'csv',
    detectedEncoding: encResult.detectedEncoding,
    encodingConfidence: encResult.confidence,
    appliedEncoding,
    detectedDelimiter,
    appliedDelimiter,
    requestedQuoteMode,
    appliedQuoteMode,
    headerApplied,
    totalRowsRead: 0,
    parseFailCount: 0,
    parseWarnings,
  };

  if (requestedQuoteMode === 'auto' && appliedQuoteMode !== 'strict') {
    const modePath = AUTO_QUOTE_MODE_SEQUENCE.slice(
      0,
      AUTO_QUOTE_MODE_SEQUENCE.indexOf(appliedQuoteMode) + 1,
    ).join(' -> ');
    addParseWarning(parseWarnings, `CSV quote fallback applied: ${modePath}`);
  }
  emitCsvIngestLog(debugContext, 'resolved', {
    filePath,
    requestedQuoteMode,
    appliedQuoteMode,
  });

  async function* generate(): AsyncGenerator<RawRecord[]> {
    const stream = createReadStream(filePath);
    const decoded = stream.pipe(iconv.decodeStream(appliedEncoding));
    const parser = decoded.pipe(parse(buildCsvParseOptions(
      appliedDelimiter,
      fromLine,
      appliedQuoteMode,
      {
        bom: false, // BOM already handled by encoding
        relaxColumnCount: true,
      },
    )));

    let chunk: RawRecord[] = [];
    let rowIndex = 0;

    try {
      for await (const rawRow of parser) {
        if (previewLimit !== undefined && rowIndex >= previewLimit) break;
        rowIndex++;
        const row = rawRow as string[];
        const rawPayload = row.join('|');

        // Column count check
        if (columns.length > 0 && row.length !== columns.length) {
          const rawLine = row.join(appliedDelimiter);
          const rawLineHash = createHash('sha256').update(rawLine).digest('hex');
          addParseWarning(parseWarnings, `Row ${rowIndex}: expected ${columns.length} cols, got ${row.length}`);
          parseFailures.push({
            rowIndex,
            rawLine,
            rawLineHash,
            rawLinePreview: rawLine.slice(0, 200),
            reason: 'COLUMN_MISALIGNMENT',
            detail: `expected ${columns.length} columns, got ${row.length}`,
          });
          diagnosis.parseFailCount++;
          continue;
        }

        // Decode failure check
        const replCount = [...rawPayload].filter(c => c === '\uFFFD').length;
        if (rawPayload.length > 0 && replCount / rawPayload.length >= DECODE_FAIL_RATIO) {
          const rawLineHash = createHash('sha256').update(rawPayload).digest('hex');
          parseFailures.push({
            rowIndex,
            rawLine: rawPayload.slice(0, 1000),
            rawLineHash,
            rawLinePreview: rawPayload.slice(0, 200),
            reason: 'DECODE_FAILED',
            detail: `${Math.round(replCount / rawPayload.length * 100)}% replacement chars`,
          });
          diagnosis.parseFailCount++;
          continue;
        } else if (replCount > 0) {
          addParseWarning(parseWarnings, `Row ${rowIndex}: replacement chars present (encoding mismatch?)`);
        }

        // Build record
        const record: RawRecord = {};
        for (let i = 0; i < columns.length; i++) {
          record[columns[i]!] = row[i] ?? '';
        }
        record['_row_fingerprint'] = rowFingerprint(srcHash, rowIndex, rawPayload);

        chunk.push(record);
        if (chunk.length >= chunkSize) { yield chunk; chunk = []; }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitCsvIngestLog(debugContext, 'parse-error', {
        filePath,
        stage: 'bodyRead',
        requestedQuoteMode,
        appliedQuoteMode,
        rowIndex: rowIndex + 1,
        error: msg,
      });
      parseFailures.push({
        rowIndex: rowIndex + 1,
        rawLine: '',
        rawLineHash: '',
        rawLinePreview: '',
        reason: 'PARSE_ERROR',
        detail: msg,
      });
      diagnosis.parseFailCount++;
    } finally {
      stream.destroy();
    }

    if (chunk.length > 0) yield chunk;
    diagnosis.totalRowsRead = rowIndex;
  }

  return {
    diagnosis,
    sourceFileHash: srcHash,
    schemaFingerprint: schemaFp,
    columns,
    records: generate(),
    parseFailures,
  };
}
