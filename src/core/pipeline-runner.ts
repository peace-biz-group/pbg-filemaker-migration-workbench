/**
 * Pipeline runner — wraps existing core functions for use by both CLI and UI.
 * Manages run directories and metadata.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
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

// --- Progress tracking ---

export interface ProgressEvent {
  step: string;
  detail: string;
  percent: number;
}

const activeEmitters = new Map<string, EventEmitter>();

export function getRunEmitter(runId: string): EventEmitter | undefined {
  return activeEmitters.get(runId);
}

function emitProgress(runId: string, step: string, detail: string, percent: number): void {
  const emitter = activeEmitters.get(runId);
  if (emitter) {
    emitter.emit('progress', { step, detail, percent } satisfies ProgressEvent);
  }
}

// --- Delete run ---

export function deleteRun(outputDir: string, runId: string): boolean {
  const runDir = join(getRunsBaseDir(outputDir), runId);
  if (!existsSync(runDir)) return false;
  rmSync(runDir, { recursive: true, force: true });
  return true;
}

/**
 * Execute a pipeline run. Returns the run metadata.
 * If async mode is requested, returns immediately with 'running' status
 * and emits progress events via EventEmitter.
 */
export async function executeRun(
  mode: RunMode,
  inputFiles: string[],
  config: WorkbenchConfig,
  configPath?: string,
  options?: { async?: boolean },
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

  const doExecute = async () => {
    const runConfig = { ...config, outputDir: runDir };
    const emitter = new EventEmitter();
    emitter.on('error', () => {}); // prevent unhandled 'error' event throws
    activeEmitters.set(runId, emitter);

    try {
      for (const f of inputFiles) {
        if (!existsSync(f)) {
          throw new Error(`Input file not found: ${f}`);
        }
      }

      switch (mode) {
        case 'profile':
          await runProfile(inputFiles[0], runConfig, meta, runId);
          break;
        case 'normalize':
          await runNormalize(inputFiles, runConfig, meta, runId);
          break;
        case 'detect-duplicates':
          await runDetectDuplicates(inputFiles[0], runConfig, meta, runId);
          break;
        case 'classify':
          await runClassify(inputFiles[0], runConfig, meta, runId);
          break;
        case 'run-all':
          await runAll(inputFiles[0], runConfig, meta, runId);
          break;
        case 'run-batch':
          await runBatch(inputFiles, runConfig, meta, runId);
          break;
      }
      meta.status = 'completed';
      meta.completedAt = new Date().toISOString();
      saveMeta(meta);
      emitter.emit('complete', meta);
    } catch (err) {
      meta.status = 'failed';
      meta.completedAt = new Date().toISOString();
      meta.error = err instanceof Error ? err.message : String(err);
      saveMeta(meta);
      emitter.emit('error', meta);
    } finally {
      setTimeout(() => activeEmitters.delete(runId), 5000);
    }
  };

  if (options?.async) {
    doExecute();
    return meta;
  }

  await doExecute();
  return meta;
}

async function runProfile(file: string, config: WorkbenchConfig, meta: RunMeta, runId: string): Promise<void> {
  emitProgress(runId, 'profile', 'プロファイル実行中...', 10);
  const profile = await profileFile(file, config);
  emitProgress(runId, 'profile', '異常値書き出し中...', 60);
  await writeAnomalies(profile, config);
  meta.summary = buildSummary(meta, profile);
  writeSummaryJson(config.outputDir, meta.summary);
  writeSummaryMarkdown(config.outputDir, meta.summary, profile);
  emitProgress(runId, 'profile', '完了', 100);
}

async function runNormalize(files: string[], config: WorkbenchConfig, meta: RunMeta, runId: string): Promise<void> {
  emitProgress(runId, 'normalize', '正規化実行中...', 10);
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
  emitProgress(runId, 'normalize', '完了', 100);
}

async function runDetectDuplicates(file: string, config: WorkbenchConfig, meta: RunMeta, runId: string): Promise<void> {
  emitProgress(runId, 'detect-duplicates', '重複検出実行中...', 10);
  const result = await detectDuplicates(file, config);
  meta.summary = buildSummary(meta);
  meta.summary.duplicateGroupCount = result.groups.length;
  writeSummaryJson(config.outputDir, meta.summary);
  emitProgress(runId, 'detect-duplicates', '完了', 100);
}

async function runClassify(file: string, config: WorkbenchConfig, meta: RunMeta, runId: string): Promise<void> {
  emitProgress(runId, 'classify', '分類実行中...', 10);
  const result = await classifyFile(file, config);
  meta.summary = buildSummary(meta);
  meta.summary.classificationBreakdown = result.breakdown;
  writeSummaryJson(config.outputDir, meta.summary);
  emitProgress(runId, 'classify', '完了', 100);
}

async function runAll(file: string, config: WorkbenchConfig, meta: RunMeta, runId: string): Promise<void> {
  emitProgress(runId, 'profile', 'プロファイル実行中...', 5);
  const profile = await profileFile(file, config);
  await writeAnomalies(profile, config);
  emitProgress(runId, 'normalize', '正規化実行中...', 25);
  const normResult = await normalizeFile(file, config);
  emitProgress(runId, 'detect-duplicates', '重複検出実行中...', 50);
  const dupResult = await detectDuplicates(normResult.normalizedPath, config);
  emitProgress(runId, 'classify', '分類実行中...', 75);
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
  emitProgress(runId, 'complete', '完了', 100);
}

async function runBatch(files: string[], config: WorkbenchConfig, meta: RunMeta, runId: string): Promise<void> {
  // Profile each
  const profiles: ProfileResult[] = [];
  let totalRecords = 0;
  let totalColumns = 0;
  for (let i = 0; i < files.length; i++) {
    emitProgress(runId, 'profile', `プロファイル実行中 (${i + 1}/${files.length})...`, Math.round((i / files.length) * 20));
    const p = await profileFile(files[i], config);
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

  emitProgress(runId, 'normalize', '正規化実行中...', 30);
  const normResult = await normalizeFiles(
    files.map((f) => ({ path: f, label: f })),
    config,
  );
  emitProgress(runId, 'detect-duplicates', '重複検出実行中...', 55);
  const dupResult = await detectDuplicates(normResult.normalizedPath, config);
  emitProgress(runId, 'classify', '分類実行中...', 80);
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
  emitProgress(runId, 'complete', '完了', 100);
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
