import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse';
import iconv from 'iconv-lite';
import type { RawRecord, IngestResult, ParseFailRecord, CsvIngestDiagnosis } from '../types/index.js';
import type { IngestOptions } from './ingest-options.js';
import { detectEncoding } from './encoding-detector.js';
import { detectDelimiter } from './delimiter-detector.js';
import { fileHash, schemaFingerprint, rowFingerprint } from './fingerprint.js';
import { open } from 'node:fs/promises';

const MAX_WARNINGS = 50;
const DECODE_FAIL_RATIO = 0.5;

async function readSample(filePath: string, bytes: number): Promise<Buffer> {
  const fd = await open(filePath, 'r');
  const buf = Buffer.alloc(bytes);
  const { bytesRead } = await fd.read(buf, 0, bytes, 0);
  await fd.close();
  return buf.subarray(0, bytesRead);
}

async function peekColumns(
  filePath: string,
  encoding: 'utf8' | 'cp932',
  delimiter: string,
  hasHeader: boolean,
  skipRows: number,
): Promise<string[]> {
  const stream = createReadStream(filePath);
  const decoded = stream.pipe(iconv.decodeStream(encoding));
  const fromLine = skipRows + 1;
  const parser = decoded.pipe(parse({
    columns: false,
    skip_empty_lines: true,
    trim: true,
    delimiter,
    from_line: fromLine,
    to: fromLine,
    bom: encoding === 'utf8',
  }));

  let firstRow: string[] = [];
  try {
    for await (const row of parser) {
      firstRow = row as string[];
      break;
    }
  } finally {
    stream.destroy();
  }

  if (!firstRow.length) return [];
  return hasHeader ? firstRow.map(String) : firstRow.map((_, i) => `c${i}`);
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

  const hasHeader = options.hasHeader !== false;
  const skipRows = options.skipRows ?? 0;

  // Get columns by peeking first row
  const columns = await peekColumns(filePath, appliedEncoding, appliedDelimiter, hasHeader, skipRows);
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
    headerApplied: hasHeader,
    totalRowsRead: 0,
    parseFailCount: 0,
    parseWarnings,
  };

  const previewLimit = options.previewRows;

  async function* generate(): AsyncGenerator<RawRecord[]> {
    const fromLine = hasHeader ? skipRows + 2 : skipRows + 1;
    const stream = createReadStream(filePath);
    const decoded = stream.pipe(iconv.decodeStream(appliedEncoding));
    const parser = decoded.pipe(parse({
      columns: false,
      skip_empty_lines: true,
      trim: true,
      delimiter: appliedDelimiter,
      from_line: fromLine,
      relax_column_count: true,
      bom: false, // BOM already handled by encoding
    }));

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
          if (parseWarnings.length < MAX_WARNINGS) {
            parseWarnings.push(`Row ${rowIndex}: expected ${columns.length} cols, got ${row.length}`);
          }
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
        } else if (replCount > 0 && parseWarnings.length < MAX_WARNINGS) {
          parseWarnings.push(`Row ${rowIndex}: replacement chars present (encoding mismatch?)`);
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
      parseFailures.push({
        rowIndex: rowIndex + 1,
        rawLine: '',
        rawLineHash: '',
        rawLinePreview: '',
        reason: 'PARSE_ERROR',
        detail: msg,
      });
      diagnosis.parseFailCount++;
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
