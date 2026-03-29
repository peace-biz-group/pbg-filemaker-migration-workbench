import { open } from 'node:fs/promises';

export interface EncodingDetectResult {
  detectedEncoding: 'utf8' | 'utf8bom' | 'cp932' | 'unknown';
  confidence: 'bom' | 'valid_utf8' | 'heuristic' | 'fallback';
  appliedEncoding: 'utf8' | 'cp932';
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const SAMPLE_BYTES = 8 * 1024;

function isValidUtf8(buf: Buffer): boolean {
  let i = 0;
  while (i < buf.length) {
    const b = buf[i]!;
    if (b < 0x80) { i++; continue; }
    let extra: number;
    if ((b & 0xe0) === 0xc0) extra = 1;
    else if ((b & 0xf0) === 0xe0) extra = 2;
    else if ((b & 0xf8) === 0xf0) extra = 3;
    else return false;
    for (let j = 1; j <= extra; j++) {
      if (i + j >= buf.length || (buf[i + j]! & 0xc0) !== 0x80) return false;
    }
    i += 1 + extra;
  }
  return true;
}

function hasShiftJisBytes(buf: Buffer): boolean {
  for (let i = 0; i < buf.length - 1; i++) {
    const b = buf[i]!;
    if ((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)) {
      const n = buf[i + 1]!;
      if ((n >= 0x40 && n <= 0x7e) || (n >= 0x80 && n <= 0xfc)) return true;
    }
  }
  return false;
}

export async function detectEncoding(filePath: string): Promise<EncodingDetectResult> {
  const fd = await open(filePath, 'r');
  const buf = Buffer.alloc(SAMPLE_BYTES);
  const { bytesRead } = await fd.read(buf, 0, SAMPLE_BYTES, 0);
  await fd.close();
  const s = buf.subarray(0, bytesRead);

  if (s.length >= 3 && s.subarray(0, 3).equals(UTF8_BOM))
    return { detectedEncoding: 'utf8bom', confidence: 'bom', appliedEncoding: 'utf8' };

  if (isValidUtf8(s))
    return { detectedEncoding: 'utf8', confidence: 'valid_utf8', appliedEncoding: 'utf8' };

  if (hasShiftJisBytes(s))
    return { detectedEncoding: 'cp932', confidence: 'heuristic', appliedEncoding: 'cp932' };

  return { detectedEncoding: 'unknown', confidence: 'fallback', appliedEncoding: 'utf8' };
}
