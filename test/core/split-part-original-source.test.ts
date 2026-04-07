import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { executeRun } from '../../src/core/pipeline-runner.js';
import { loadConfig } from '../../src/config/defaults.js';
import type { WorkbenchConfig } from '../../src/config/schema.js';

const TEMP_DIRS: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('split part + original source context', () => {
  it('uses original source path for inputs, diffKeys, indexMappings, and records diagnostics', async () => {
    const dir = makeTempDir('orig-src-ctx-');
    const originalPath = join(dir, 'apo_export_test.csv');
    writeFileSync(originalPath, 'placeholder\n', 'utf8');

    const partPath = join(dir, 'part-0001.csv');
    writeFileSync(
      partPath,
      ['c0,c1,c2', '090-1111-2222,山田,東京都'].join('\n') + '\n',
      'utf8',
    );

    const outDir = join(dir, 'output');
    mkdirSync(outDir, { recursive: true });

    const config = loadConfig() as WorkbenchConfig;
    config.outputDir = outDir;
    config.inputs = [
      {
        path: resolve(originalPath),
        mode: 'mainline',
        label: 'アポ',
        sourceKey: 'apo-export',
      },
    ];
    config.indexMappings = {
      'apo_export_test.csv': {
        c0: 'phone',
        c1: 'customer_name',
        c2: 'address',
      },
    };

    const meta = await executeRun(
      'normalize',
      [partPath],
      config,
      undefined,
      {
        originalSourceContext: {
          filePath: resolve(originalPath),
          schemaFingerprint: 'test-schema-fp-abc',
        },
        mappingLookupFilePathOverride: resolve(originalPath),
      },
    );

    const absPart = resolve(partPath);
    expect(meta.status).toBe('completed');
    expect(meta.sourceModes?.[absPart]).toBe('mainline');
    expect(meta.sourceRouting?.[absPart]?.reasonCode).toBe('input_mode');
    expect(meta.sourceRouting?.[absPart]?.routingResolvedFrom).toBe('input_mode');
    expect(meta.sourceRouting?.[absPart]?.lookupUsedSourceName).toBe('apo_export_test.csv');
    expect(meta.logicalSourceKey).toBeTruthy();
    expect(meta.partOriginalSourceDiagnostics?.originalSourceFile).toBe(resolve(originalPath));
    expect(meta.partOriginalSourceDiagnostics?.originalSourceName).toBe('apo_export_test.csv');
    expect(meta.partOriginalSourceDiagnostics?.originalSchemaFingerprint).toBe('test-schema-fp-abc');
    expect(meta.partOriginalSourceDiagnostics?.lookupUsedSourceName).toBe('apo_export_test.csv');
    expect(meta.partOriginalSourceDiagnostics?.routingResolvedFrom).toBe('input_mode');

    expect(meta.summary?.normalizedCount).toBeGreaterThan(0);
    expect(meta.summary?.quarantineCount).toBe(0);
    expect(meta.summary?.partOriginalSourceDiagnostics?.lookupUsedSourceName).toBe('apo_export_test.csv');
  });

  it('applies sourceRoutingOverride with routingResolvedFrom source_routing_override', async () => {
    const dir = makeTempDir('routing-ovr-');
    const originalPath = join(dir, 'src.csv');
    writeFileSync(originalPath, 'x\n', 'utf8');
    const partPath = join(dir, 'part.csv');
    writeFileSync(partPath, ['c0', '090-0000-0000'].join('\n') + '\n', 'utf8');

    const outDir = join(dir, 'out');
    mkdirSync(outDir, { recursive: true });

    const config = loadConfig() as WorkbenchConfig;
    config.outputDir = outDir;
    config.indexMappings = { 'src.csv': { c0: 'phone' } };

    const meta = await executeRun(
      'normalize',
      [partPath],
      config,
      undefined,
      {
        mappingLookupFilePathOverride: resolve(originalPath),
        originalSourceContext: { filePath: resolve(originalPath) },
        sourceRoutingOverride: {
          mode: 'mainline',
          reasonCode: 'profile_inference',
          reason: 'test override',
          hasChildColumns: false,
          childColumnCount: 0,
          childColumnNames: [],
          mixedParentChildExport: false,
          matchedProfileConfidence: 'high',
        },
      },
    );

    const absPart = resolve(partPath);
    expect(meta.sourceRouting?.[absPart]?.routingResolvedFrom).toBe('source_routing_override');
    expect(meta.sourceRouting?.[absPart]?.mode).toBe('mainline');
    expect(meta.partOriginalSourceDiagnostics?.routingResolvedFrom).toBe('source_routing_override');
  });
});
