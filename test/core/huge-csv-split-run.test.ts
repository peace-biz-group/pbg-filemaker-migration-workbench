import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config/defaults.js';
import { executeRun, getRun } from '../../src/core/pipeline-runner.js';
import { resumeSplitRun, startSplitRun } from '../../src/core/huge-csv-split-run.js';
import type { WorkbenchConfig } from '../../src/config/schema.js';

const TEMP_DIRS: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

function makeConfig(outputDir: string): WorkbenchConfig {
  const config = loadConfig();
  config.outputDir = outputDir;
  return config;
}

function writeTempCsv(name: string, contents: string): string {
  const dir = makeTempDir('huge-split-run-src-');
  const filePath = join(dir, name);
  writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

function makeHeaderlessMappingConfig(outputDir: string): WorkbenchConfig {
  const config = makeConfig(outputDir);
  config.indexMappings = {
    'filemaker_export*.csv': {
      c2: 'store_name',
      c4: 'phone',
      c5: 'customer_name',
      c6: 'address',
    },
  };
  return config;
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('split-run', () => {
  it('runs part 001 then stops for resume', async () => {
    const outputDir = makeTempDir('huge-split-run-out-');
    const filePath = writeTempCsv(
      'source.csv',
      ['name,comment', 'r1,a', 'r2,b', 'r3,c', 'r4,d', 'r5,e'].join('\n') + '\n',
    );

    const summary = await startSplitRun({
      filePath,
      config: makeConfig(outputDir),
      mode: 'normalize',
      rowsPerPart: 2,
    });

    expect(summary.stage).toBe('part1_completed');
    expect(summary.completedParts).toBe(1);
    expect(summary.stopReason).toBe('awaiting_resume');
    expect(summary.partResults[0]?.runId).toBeTruthy();
    const manifest = JSON.parse(readFileSync(summary.splitManifestPath, 'utf8')) as {
      seed: { initialPartRunId?: string; firstPartPath: string; lastReusableRunId?: string | null };
    };
    expect(manifest.seed.initialPartRunId).toBe(summary.partResults[0]?.runId);
    expect(manifest.seed.firstPartPath).toContain('part-0001.csv');
    expect(manifest.seed.lastReusableRunId).toBeNull();
  });

  it('cannot resume when reusable context is missing', async () => {
    const outputDir = makeTempDir('huge-split-run-out-');
    const filePath = writeTempCsv(
      'source.csv',
      ['name,comment', 'r1,a', 'r2,b', 'r3,c'].join('\n') + '\n',
    );

    const summary = await startSplitRun({
      filePath,
      config: makeConfig(outputDir),
      mode: 'normalize',
      rowsPerPart: 2,
    });

    const resumed = await resumeSplitRun({
      manifestPath: summary.splitManifestPath,
      config: makeConfig(outputDir),
    });

    expect(resumed.stage).toBe('stopped');
    expect(resumed.stopReason).toBe('reusable_context_missing');
    expect(resumed.reusedEffectiveMapping).toBe(false);
  });

  it('resumes remaining parts from manifest only when one reusable run is discoverable', async () => {
    const outputDir = makeTempDir('huge-split-run-out-');
    const filePath = writeTempCsv(
      'source.csv',
      ['name,comment', 'r1,a', 'r2,b', 'r3,c', 'r4,d', 'r5,e'].join('\n') + '\n',
    );
    const config = makeConfig(outputDir);

    const initial = await startSplitRun({
      filePath,
      config,
      mode: 'normalize',
      rowsPerPart: 2,
    });
    const manifest = JSON.parse(readFileSync(initial.splitManifestPath, 'utf8')) as {
      parts: Array<{ filePath: string }>;
    };

    const reusableRun = await executeRun(
      'normalize',
      [manifest.parts[0]!.filePath],
      config,
      undefined,
      {
        profileId: 'apo-profile',
        effectiveMapping: { name: 'customer_name' },
      },
    );

    const resumed = await resumeSplitRun({
      manifestPath: initial.splitManifestPath,
      config,
    });

    expect(resumed.stage).toBe('resume_completed');
    expect(resumed.completedParts).toBe(3);
    expect(resumed.reusedFromRunId).toBe(reusableRun.id);
    expect(resumed.reusedProfileId).toBe('apo-profile');
    expect(resumed.reusedEffectiveMapping).toBe(true);
    expect(resumed.reusedSourceRouting).toBe(true);
    expect(resumed.schemaFingerprintMatchedAllParts).toBe(true);
    const manifestAfterResume = JSON.parse(readFileSync(initial.splitManifestPath, 'utf8')) as {
      seed: { lastReusableRunId?: string | null };
    };
    expect(manifestAfterResume.seed.lastReusableRunId).toBe(reusableRun.id);
  });

  it('stops resume when multiple reusable runs are discoverable', async () => {
    const outputDir = makeTempDir('huge-split-run-out-');
    const filePath = writeTempCsv(
      'source.csv',
      ['name,comment', 'r1,a', 'r2,b', 'r3,c', 'r4,d'].join('\n') + '\n',
    );
    const config = makeConfig(outputDir);

    const initial = await startSplitRun({
      filePath,
      config,
      mode: 'normalize',
      rowsPerPart: 2,
    });
    const manifest = JSON.parse(readFileSync(initial.splitManifestPath, 'utf8')) as {
      parts: Array<{ filePath: string }>;
    };

    await executeRun(
      'normalize',
      [manifest.parts[0]!.filePath],
      config,
      undefined,
      {
        profileId: 'apo-profile-a',
        effectiveMapping: { name: 'customer_name' },
      },
    );
    await executeRun(
      'normalize',
      [manifest.parts[0]!.filePath],
      config,
      undefined,
      {
        profileId: 'apo-profile-b',
        effectiveMapping: { name: 'customer_name' },
      },
    );

    const resumed = await resumeSplitRun({
      manifestPath: initial.splitManifestPath,
      config,
    });

    expect(resumed.stage).toBe('stopped');
    expect(resumed.stopReason).toBe('ambiguous_reusable_context');
    expect(resumed.reusableRunCandidateIds?.length).toBe(2);
  });

  it('stops resume when a later part schema fingerprint differs', async () => {
    const outputDir = makeTempDir('huge-split-run-out-');
    const filePath = writeTempCsv(
      'source.csv',
      ['name,comment', 'r1,a', 'r2,b', 'r3,c', 'r4,d'].join('\n') + '\n',
    );
    const config = makeConfig(outputDir);

    const initial = await startSplitRun({
      filePath,
      config,
      mode: 'normalize',
      rowsPerPart: 2,
    });
    const manifest = JSON.parse(readFileSync(initial.splitManifestPath, 'utf8')) as {
      parts: Array<{ filePath: string }>;
    };

    writeFileSync(manifest.parts[1]!.filePath, 'other,comment\nr3,c\nr4,d\n', 'utf8');

    const reusableRun = await executeRun(
      'normalize',
      [manifest.parts[0]!.filePath],
      config,
      undefined,
      {
        profileId: 'apo-profile',
        effectiveMapping: { name: 'customer_name' },
      },
    );

    const resumed = await resumeSplitRun({
      manifestPath: initial.splitManifestPath,
      config,
    });

    expect(resumed.stage).toBe('stopped');
    expect(resumed.stopReason).toBe('schema_changed');
    expect(resumed.schemaFingerprintMatchedAllParts).toBe(false);
  });

  it('uses original source filename mapping and headerless detection for part 001 normalize', async () => {
    const outputDir = makeTempDir('huge-split-run-out-');
    const filePath = writeTempCsv(
      'filemaker_export_sample.csv',
      [
        '"","","店舗A","https://example.com/a","090-1111-2222","田中","東京都千代田区1-1","2025/04/01"',
        '"","","店舗B","https://example.com/b","090-3333-4444","佐藤","東京都港区2-2","2025/04/02"',
        '"","","店舗C","https://example.com/c","090-5555-6666","鈴木","東京都渋谷区3-3","2025/04/03"',
        '"","","店舗D","https://example.com/d","090-7777-8888","高橋","東京都新宿区4-4","2025/04/04"',
      ].join('\n') + '\n',
    );
    const config = makeHeaderlessMappingConfig(outputDir);

    const summary = await startSplitRun({
      filePath,
      config,
      mode: 'normalize',
      rowsPerPart: 2,
    });

    expect(summary.partResults[0]?.normalizedCount).toBe(2);
    expect(summary.partResults[0]?.quarantineCount).toBe(0);

    const run = getRun(dirname(summary.splitManifestPath), summary.partResults[0]!.runId!);
    expect(run?.ingestDiagnoses?.[run.inputFiles[0]!]?.headerApplied).toBe(false);
    expect(run?.columnNames?.slice(0, 4)).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect(run?.partOriginalSourceDiagnostics?.originalHeaderApplied).toBe(false);
    expect(run?.partOriginalSourceDiagnostics?.effectiveHasHeaderForPart).toBe(false);
    expect(run?.partOriginalSourceDiagnostics?.headerDecisionResolvedFrom).toBe('split_source_ingest');
  });
});
