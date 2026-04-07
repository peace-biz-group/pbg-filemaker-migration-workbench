// test/core/import-preview.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runImportPreview } from '../../src/core/import-preview.js';

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'import-preview-test-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

describe('runImportPreview', () => {
  it('returns columnSamples with topValues sorted by frequency', async () => {
    const csvPath = join(tmpDir, 'test.csv');
    writeFileSync(csvPath, [
      '職業,氏名',
      '会社員,田中',
      '会社員,鈴木',
      '農業,佐藤',
      '会社員,山田',
      '無職,高橋',
    ].join('\n'));

    const result = await runImportPreview(csvPath, 'test.csv', tmpDir);

    expect(result.fileName).toBe('test.csv');
    expect(result.sampledRows).toBe(5);
    expect(result.columnSamples).toHaveProperty('職業');
    const sample = result.columnSamples['職業'];
    expect(sample.nonEmptyCount).toBe(5);
    expect(sample.topValues[0]).toEqual({ value: '会社員', count: 3 });
    expect(sample.topValues.length).toBeLessThanOrEqual(5);
  });

  it('returns empty topValues for all-empty column', async () => {
    const csvPath = join(tmpDir, 'empty.csv');
    writeFileSync(csvPath, ['列A,列B', ',田中', ',鈴木'].join('\n'));

    const result = await runImportPreview(csvPath, 'empty.csv', tmpDir);

    expect(result.columnSamples['列A'].nonEmptyCount).toBe(0);
    expect(result.columnSamples['列A'].topValues).toEqual([]);
  });

  it('returns at most 5 topValues per column', async () => {
    const rows = ['col'];
    for (let i = 0; i < 10; i++) rows.push(`val${i}`);
    const csvPath = join(tmpDir, 'many.csv');
    writeFileSync(csvPath, rows.join('\n'));

    const result = await runImportPreview(csvPath, 'many.csv', tmpDir);

    expect(result.columnSamples['col'].topValues.length).toBeLessThanOrEqual(5);
  });

  it('returns autoApplyResult with unresolvedColumns for unknown columns', async () => {
    const csvPath = join(tmpDir, 'unknown.csv');
    writeFileSync(csvPath, ['未知列A,未知列B', 'val1,val2'].join('\n'));

    const result = await runImportPreview(csvPath, 'unknown.csv', tmpDir);

    expect(result.autoApplyResult).toHaveProperty('unresolvedColumns');
    expect(result.autoApplyResult.unresolvedColumns).toContain('未知列A');
    expect(result.autoApplyResult.unresolvedColumns).toContain('未知列B');
  });

  it('unresolved 0件でも正常レスポンス（空配列）', async () => {
    // 最低限 autoApplyResult.unresolvedColumns が配列であることを確認する
    const csvPath = join(tmpDir, 'zero.csv');
    writeFileSync(csvPath, ['col1'].join('\n'));

    const result = await runImportPreview(csvPath, 'zero.csv', tmpDir);

    expect(Array.isArray(result.autoApplyResult.unresolvedColumns)).toBe(true);
  });
});
