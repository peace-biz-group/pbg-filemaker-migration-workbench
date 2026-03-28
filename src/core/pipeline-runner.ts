/**
 * Pipeline runner — wraps existing core functions for use by both CLI and UI.
 * Manages run directories and metadata.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { profileFile } from './profiler.js';
import { normalizeFile, normalizeFiles } from './normalizer.js';
import { detectDuplicates } from './duplicate-detector.js';
import { classifyFile } from './classifier.js';
import { writeCsv } from '../io/csv-writer.js';
import { writeSummaryJson, writeSummaryMarkdown } from '../io/report-writer.js';
import type { WorkbenchConfig } from '../config/schema.js';
import type { ReportSummary, ProfileResult, CandidateType } from '../types/index.js';

export type RunMode = 'profile' | 'normalize' | 'detect-duplicates' | 'classify' | 'run-all' | 'run-batch';

export interface RunMeta {
  id: string;
  mode: RunMode;
  inputFiles: string[];
  configPath?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  error?: string;
  outputDir: string;
  summary?: ReportSummary;
}

function generateRunId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}_${rand}`;
}

export function getRunsBaseDir(outputDir: string): string {
  return join(outputDir, 'runs');
}

export function listRuns(outputDir: string): RunMeta[] {
  const runsDir = getRunsBaseDir(outputDir);
  if (!existsSync(runsDir)) return [];

  const entries = readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();

  const runs: RunMeta[] = [];
  for (const dir of entries) {
    const metaPath = join(runsDir, dir, 'run-meta.json');
    if (existsSync(metaPath)) {
      try {
        runs.push(JSON.parse(readFileSync(metaPath, 'utf-8')));
      } catch {
        // skip corrupted meta
      }
    }
  }
  return runs;
}

export function getRun(outputDir: string, runId: string): RunMeta | null {
  const metaPath = join(getRunsBaseDir(outputDir), runId, 'run-meta.json');
  if (!existsSync(metaPath)) return null;
  return JSON.parse(readFileSync(metaPath, 'utf-8'));
}

export function getRunOutputFiles(outputDir: string, runId: string): string[] {
  const runDir = join(getRunsBaseDir(outputDir), runId);
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir).filter((f) => f !== 'run-meta.json').sort();
}

function saveMeta(meta: RunMeta): void {
  writeFileSync(join(meta.outputDir, 'run-meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

/**
 * Execute a pipeline run. Returns the run metadata.
 */
export async function executeRun(
  mode: RunMode,
  inputFiles: string[],
  config: WorkbenchConfig,
  configPath?: string,
): Promise<RunMeta> {
  const runId = generateRunId();
  const runDir = join(getRunsBaseDir(config.outputDir), runId);
  mkdirSync(runDir, { recursive: true });

  const meta: RunMeta = {
    id: runId,
    mode,
    inputFiles: inputFiles.map((f) => resolve(f)),
    configPath,
    status: 'running',
    startedAt: new Date().toISOString(),
    outputDir: runDir,
  };
  saveMeta(meta);

  // Override outputDir to run-specific dir
  const runConfig = { ...config, outputDir: runDir };

  try {
    // Validate input files exist
    for (const f of inputFiles) {
      if (!existsSync(f)) {
        throw new Error(`Input file not found: ${f}`);
      }
    }

    switch (mode) {
      case 'profile':
        await runProfile(inputFiles[0], runConfig, meta);
        break;
      case 'normalize':
        await runNormalize(inputFiles, runConfig, meta);
        break;
      case 'detect-duplicates':
        await runDetectDuplicates(inputFiles[0], runConfig, meta);
        break;
      case 'classify':
        await runClassify(inputFiles[0], runConfig, meta);
        break;
      case 'run-all':
        await runAll(inputFiles[0], runConfig, meta);
        break;
      case 'run-batch':
        await runBatch(inputFiles, runConfig, meta);
        break;
    }
    meta.status = 'completed';
    meta.completedAt = new Date().toISOString();
  } catch (err) {
    meta.status = 'failed';
    meta.completedAt = new Date().toISOString();
    meta.error = err instanceof Error ? err.message : String(err);
  }

  saveMeta(meta);
  return meta;
}

async function runProfile(file: string, config: WorkbenchConfig, meta: RunMeta): Promise<void> {
  const profile = await profileFile(file, config);
  await writeAnomalies(profile, config);
  meta.summary = buildSummary(meta, profile);
  writeSummaryJson(config.outputDir, meta.summary);
  writeSummaryMarkdown(config.outputDir, meta.summary, profile);
}

async function runNormalize(files: string[], config: WorkbenchConfig, meta: RunMeta): Promise<void> {
  let normResult;
  if (files.length === 1) {
    normResult = await normalizeFile(files[0], config);
  } else {
    normResult = await normalizeFiles(
      files.map((f) => ({ path: f, label: f })),
      config,
    );
  }
  meta.summary = buildSummary(meta);
  meta.summary.normalizedCount = normResult.normalizedCount;
  meta.summary.quarantineCount = normResult.quarantineCount;
  writeSummaryJson(config.outputDir, meta.summary);
}

async function runDetectDuplicates(file: string, config: WorkbenchConfig, meta: RunMeta): Promise<void> {
  const result = await detectDuplicates(file, config);
  meta.summary = buildSummary(meta);
  meta.summary.duplicateGroupCount = result.groups.length;
  writeSummaryJson(config.outputDir, meta.summary);
}

async function runClassify(file: string, config: WorkbenchConfig, meta: RunMeta): Promise<void> {
  const result = await classifyFile(file, config);
  meta.summary = buildSummary(meta);
  meta.summary.classificationBreakdown = result.breakdown;
  writeSummaryJson(config.outputDir, meta.summary);
}

async function runAll(file: string, config: WorkbenchConfig, meta: RunMeta): Promise<void> {
  const profile = await profileFile(file, config);
  await writeAnomalies(profile, config);
  const normResult = await normalizeFile(file, config);
  const dupResult = await detectDuplicates(normResult.normalizedPath, config);
  const classResult = await classifyFile(normResult.normalizedPath, config);

  meta.summary = {
    generatedAt: new Date().toISOString(),
    inputFile: meta.inputFiles.join(', '),
    recordCount: profile.recordCount,
    columnCount: profile.columnCount,
    normalizedCount: normResult.normalizedCount,
    quarantineCount: normResult.quarantineCount,
    duplicateGroupCount: dupResult.groups.length,
    classificationBreakdown: classResult.breakdown,
  };
  writeSummaryJson(config.outputDir, meta.summary);
  writeSummaryMarkdown(config.outputDir, meta.summary, profile);
}

async function runBatch(files: string[], config: WorkbenchConfig, meta: RunMeta): Promise<void> {
  // Profile each
  const profiles: ProfileResult[] = [];
  let totalRecords = 0;
  let totalColumns = 0;
  for (const f of files) {
    const p = await profileFile(f, config);
    profiles.push(p);
    totalRecords += p.recordCount;
    totalColumns = Math.max(totalColumns, p.columnCount);
  }

  // Write merged anomalies
  const allAnomalies = profiles.flatMap((p) =>
    p.anomalies.map((a) => ({
      file: p.fileName,
      row: String(a.row),
      column: a.column,
      value: a.value,
      reason: a.reason,
    })),
  );
  if (allAnomalies.length > 0) {
    await writeCsv(join(config.outputDir, 'anomalies.csv'), allAnomalies);
  }

  const normResult = await normalizeFiles(
    files.map((f) => ({ path: f, label: f })),
    config,
  );
  const dupResult = await detectDuplicates(normResult.normalizedPath, config);
  const classResult = await classifyFile(normResult.normalizedPath, config);

  meta.summary = {
    generatedAt: new Date().toISOString(),
    inputFile: meta.inputFiles.join(', '),
    recordCount: totalRecords,
    columnCount: totalColumns,
    normalizedCount: normResult.normalizedCount,
    quarantineCount: normResult.quarantineCount,
    duplicateGroupCount: dupResult.groups.length,
    classificationBreakdown: classResult.breakdown,
  };
  writeSummaryJson(config.outputDir, meta.summary);
  writeSummaryMarkdown(config.outputDir, meta.summary, profiles[0]);
}

async function writeAnomalies(profile: ProfileResult, config: WorkbenchConfig): Promise<void> {
  if (profile.anomalies.length > 0) {
    await writeCsv(
      join(config.outputDir, 'anomalies.csv'),
      profile.anomalies.map((a) => ({
        row: String(a.row),
        column: a.column,
        value: a.value,
        reason: a.reason,
      })),
    );
  }
}

function buildSummary(meta: RunMeta, profile?: ProfileResult): ReportSummary {
  const empty: Record<CandidateType, number> = {
    customer: 0, deal: 0, transaction: 0, activity: 0, quarantine: 0,
  };
  return {
    generatedAt: new Date().toISOString(),
    inputFile: meta.inputFiles.join(', '),
    recordCount: profile?.recordCount ?? 0,
    columnCount: profile?.columnCount ?? 0,
    normalizedCount: 0,
    quarantineCount: 0,
    duplicateGroupCount: 0,
    classificationBreakdown: empty,
  };
}
