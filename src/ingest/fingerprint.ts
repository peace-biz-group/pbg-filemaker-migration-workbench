import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

export async function fileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (d: Buffer) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function fastFileFingerprint(filePath: string): Promise<string> {
  const { size } = await stat(filePath);
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath, { end: 512 * 1024 - 1 });
    stream.on('data', (d: Buffer) => hash.update(d));
    stream.on('end', () => {
      hash.update(String(size));
      resolve(hash.digest('hex'));
    });
    stream.on('error', reject);
  });
}

export function schemaFingerprint(columns: string[]): string {
  return createHash('sha256').update([...columns].sort().join('|')).digest('hex');
}

export function rowFingerprint(sourceFileHash: string, rowIndex: number, rawPayload: string): string {
  return createHash('sha256')
    .update(sourceFileHash).update('\0')
    .update(String(rowIndex)).update('\0')
    .update(rawPayload)
    .digest('hex');
}

export function sourceBatchId(fileHashes: string[]): string {
  return createHash('sha256').update([...fileHashes].sort().join('|')).digest('hex');
}

export function logicalSourceKey(sourceKeys: string[]): string {
  return createHash('sha256').update([...sourceKeys].sort().join('|')).digest('hex');
}

export function semanticStructuralFingerprint(record: Record<string, string>, fields?: string[]): string {
  const payload = Object.entries(record)
    .filter(([k]) => !k.startsWith('_') && (!fields || fields.includes(k)))
    .map(([k, v]) => [k, (v ?? '').trim()] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  return createHash('sha256').update(payload).digest('hex');
}
