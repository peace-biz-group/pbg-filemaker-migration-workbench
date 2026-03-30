import type { RawRecord } from '../types/index.js';

export interface MojibakePattern {
  name: string;
  description: string;
  exampleMatch: string;
}

export interface MojibakeScanResult {
  hasMojibake: boolean;
  mojibakeRatio: number;
  hasControlChars: boolean;
  controlCharCount: number;
  patterns: MojibakePattern[];
  warnings: string[];
}

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const REPLACEMENT_CHAR_RE = /\uFFFD/;

/**
 * Returns true if the cell value shows signs of mojibake.
 * Heuristic: >= 2 chars in U+00C0..U+00FF (Latin Extended) in a string of >= 4 chars.
 * Also flags the Unicode replacement character U+FFFD.
 */
function cellHasMojibake(value: string): boolean {
  if (value.length === 0) return false;

  if (REPLACEMENT_CHAR_RE.test(value)) return true;

  if (value.length >= 4) {
    let latinExtCount = 0;
    for (let i = 0; i < value.length; i++) {
      const cp = value.charCodeAt(i);
      if (cp >= 0x00c0 && cp <= 0x00ff) {
        latinExtCount++;
        if (latinExtCount >= 2) return true;
      }
    }
  }

  return false;
}

/**
 * Scan a sample of rows for mojibake patterns and control characters.
 * @param rows - Array of RawRecord (Record<string, string>)
 * @param sampleSize - Max rows to scan (default: 50)
 */
export function scanForMojibake(
  rows: RawRecord[],
  sampleSize = 50,
): MojibakeScanResult {
  const sample = rows.slice(0, sampleSize);

  let totalNonEmptyCells = 0;
  let mojibakeAffectedCells = 0;
  let controlCharCount = 0;
  let foundReplacement = false;
  let foundLatinExtMojibake = false;

  for (const row of sample) {
    for (const value of Object.values(row)) {
      if (value === '') continue;
      totalNonEmptyCells++;

      // Control chars
      const ctrlMatches = value.match(CONTROL_CHAR_RE);
      if (ctrlMatches) {
        controlCharCount += ctrlMatches.length;
      }

      // Mojibake detection
      if (cellHasMojibake(value)) {
        mojibakeAffectedCells++;
        if (REPLACEMENT_CHAR_RE.test(value)) {
          foundReplacement = true;
        } else {
          foundLatinExtMojibake = true;
        }
      }
    }
  }

  const mojibakeRatio =
    totalNonEmptyCells > 0 ? mojibakeAffectedCells / totalNonEmptyCells : 0;
  const hasMojibake = mojibakeRatio > 0.02;
  const hasControlChars = controlCharCount > 0;

  // Build detected patterns list
  const patterns: MojibakePattern[] = [];

  if (foundReplacement) {
    patterns.push({
      name: 'replacement_char',
      description: '文字化けの置換文字（□）が含まれています',
      exampleMatch: '\uFFFD',
    });
  }

  if (foundLatinExtMojibake) {
    patterns.push({
      name: 'latin1_cjk_leak',
      description:
        'Latin拡張文字（U+00C0–U+00FF）が多数含まれており、Shift-JISをLatin-1として読み込んだ可能性があります',
      exampleMatch: 'Ã¥Â¤§',
    });
  }

  if (hasControlChars) {
    patterns.push({
      name: 'control_chars',
      description: '制御文字が含まれています',
      exampleMatch: '\x01',
    });
  }

  // Build warnings
  const warnings: string[] = [];

  if (mojibakeRatio > 0.3) {
    const pct = Math.round(mojibakeRatio * 100);
    warnings.push(
      `文字化けが多いです（セルの約${pct}%）。文字コードを「Shift-JIS (CP932)」に変更してください。`,
    );
  } else if (mojibakeRatio > 0.02) {
    warnings.push(
      '文字化けの可能性があります。文字コードを変更してみてください。',
    );
  }

  if (hasControlChars) {
    warnings.push(`制御文字が含まれています（${controlCharCount}箇所）。`);
  }

  return {
    hasMojibake,
    mojibakeRatio,
    hasControlChars,
    controlCharCount,
    patterns,
    warnings,
  };
}
