import * as XLSX from 'xlsx';
import { readWorkbookFromFile } from '../io/xlsx-workbook.js';
import type { RawRecord, IngestResult, XlsxIngestDiagnosis } from '../types/index.js';
import type { IngestOptions } from './ingest-options.js';
import { fileHash, schemaFingerprint, rowFingerprint } from './fingerprint.js';

export async function ingestXlsx(
  filePath: string,
  options: IngestOptions = {},
  chunkSize = 5000,
): Promise<IngestResult> {
  const srcHash = await fileHash(filePath);
  const hasHeader = options.hasHeader !== false;
  const skipRows = options.skipRows ?? 0;

  const wb = readWorkbookFromFile(filePath);
  const sheetName = wb.SheetNames[0] ?? '';
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`No sheet found in ${filePath}`);

  const allRows: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) as string[][];
  const dataRows = allRows.slice(skipRows);

  let columns: string[];
  let dataStart: number;
  if (hasHeader && dataRows.length > 0) {
    columns = (dataRows[0] ?? []).map(String);
    dataStart = 1;
  } else {
    const first = dataRows[0] ?? [];
    columns = first.map((_, i) => `c${i}`);
    dataStart = 0;
  }

  const schemaFp = schemaFingerprint(columns);
  const rows = dataRows.slice(dataStart);
  const previewLimit = options.previewRows;
  const parseWarnings: string[] = [];

  const diagnosis: XlsxIngestDiagnosis = {
    format: 'xlsx',
    sheetName,
    headerApplied: hasHeader,
    totalRowsRead: 0,
    parseFailCount: 0,
    parseWarnings,
  };

  async function* generate(): AsyncGenerator<RawRecord[]> {
    let chunk: RawRecord[] = [];
    let rowIndex = 0;

    for (const row of rows) {
      if (previewLimit !== undefined && rowIndex >= previewLimit) break;
      rowIndex++;

      const record: RawRecord = {};
      for (let i = 0; i < columns.length; i++) {
        record[columns[i]!] = row[i] ?? '';
      }
      record['_row_fingerprint'] = rowFingerprint(srcHash, rowIndex, columns.map(c => record[c]).join('|'));

      chunk.push(record);
      if (chunk.length >= chunkSize) { yield chunk; chunk = []; }
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
    parseFailures: [],
  };
}
