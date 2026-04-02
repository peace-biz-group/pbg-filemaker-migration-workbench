import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';

/**
 * Read workbook bytes with Node fs and parse via SheetJS read().
 * This is stable in ESM where readFile helper may not be attached.
 */
export function readWorkbookFromFile(filePath: string): XLSX.WorkBook {
  const fileBuffer = readFileSync(filePath);
  return XLSX.read(fileBuffer, { type: 'buffer' });
}
