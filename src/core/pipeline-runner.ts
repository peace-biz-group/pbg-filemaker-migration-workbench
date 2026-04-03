/**
 * Pipeline runner — wraps existing core functions for use by both CLI and UI.
 * Manages run directories and metadata.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join, resolve, basename } from 'node:path';
import { profileFile } from './profiler.js';
import { normalizeFile, normalizeFiles } from './normalizer.js';
import type { NormalizeContext } from './normalizer.js';
import { detectDuplicates } from './duplicate-detector.js';
import { classifyFile } from './classifier.js';
import { writeCsv } from '../io/csv-writer.js';
import { writeSummaryJson, writeSummaryMarkdown } from '../io/report-writer.js';
import { ingestFile } from '../io/file-reader.js';
import { sourceBatchId, logicalSourceKey } from '../ingest/fingerprint.js';
import { generateMappingSuggestions } from './column-mapper.js';
import type { WorkbenchConfig } from '../config/schema.js';
import type { ReportSummary, ProfileResult, CandidateType, IngestDiagnosis } from '../types/index.js';
import { buildRunDiffSummaryV1, saveRunDiffSummary } from './run-diff-summary.js';
import { globMatch } from './column-mapper.js';
import {
  computeConfigHash,
  defaultStatePath,
  finishImportRun,
  readState,
  resolveSourceBatch,
  startImportRun,
  writeState,
  type SourceBatchRecord,
  type SourceMode,
  type MergeSummary,
} from './import-state.js';
import { mergeMainlineRows } from './mainline-merge.js';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { stringify as stringifyCsvSync } from 'csv-stringify/sync';

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
  // new fields (optional for backward compat)
  sourceBatchId?: string;
  logicalSourceKey?: string;
  sourceFileHashes?: Record<string, string>;
  schemaFingerprints?: Record<string, string>;
  ingestDiagnoses?: Record<string, IngestDiagnosis>;
  /** 最初の入力ファイルの列名一覧（drift context 用） */
  columnNames?: string[];
  /** 入力ファイルごとの列名一覧（run diff / drift 用） */
  inputColumns?: Record<string, string[]>;
  previousRunId?: string;
  /** 実効 mapping と関連づく profileId */
  profileId?: string;
  /** fast-path 実行情報 */
  usedFastPath?: boolean;
  fastPathProfileId?: string;
  skippedColumnReview?: boolean;
  /** confirm 段階で duplicate warning が表示された場合 true */
  duplicateWarningShown?: boolean;
  /** duplicate warning を見た上で明示的に override して実行した場合 true */
  duplicateOverride?: boolean;
  /** confirm 段階で schema drift warning が表示された場合 true */
  schemaDriftWarningShown?: boolean;
  /** schema drift warning を見た上で明示的に override して進んだ場合 true */
  schemaDriftOverride?: boolean;
  statePath?: string;
  sourceBatches?: SourceBatchRecord[];
  sourceModes?: Record<string, SourceMode>;
  importRunId?: string;
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
 * 保存済みの run メタデータを部分更新する。
 * fast path など、実行後に追記したいフィールドに使用する。
 */
export function patchRunMeta(
  outputDir: string,
  runId: string,
  patch: Partial<RunMeta>,
): RunMeta | null {
  const current = getRun(outputDir, runId);
  if (!current) return null;
  const updated = { ...current, ...patch };
  writeFileSync(
    join(getRunsBaseDir(outputDir), runId, 'run-meta.json'),
    JSON.stringify(updated, null, 2),
    'utf-8',
  );
  return updated;
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

/** Resolve per-file ingest options: merge global config + per-file override. */
function resolveFileIngestOptions(filePath: string, config: WorkbenchConfig): Record<string, unknown> {
  const global = config.ingestOptions ?? {};
  const fileEntry = config.inputs.find(i => resolve(i.path) === resolve(filePath));
  const perFile = fileEntry?.ingestOptions ?? {};
  return { ...global, ...perFile };
}

function resolveSourceMode(filePath: string, config: WorkbenchConfig): SourceMode {
  const full = resolve(filePath);
  const fileName = basename(filePath);
  const fromInput = config.inputs.find(i => resolve(i.path) === full)?.mode;
  if (fromInput) return fromInput;
  for (const [pattern, rule] of Object.entries(config.diffKeys ?? {})) {
    if (globMatch(pattern, fileName) && rule.mode) return rule.mode;
  }
  return 'archive';
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
  options?: {
    async?: boolean;
    effectiveMapping?: Record<string, string>;
    profileId?: string;
    duplicateWarningShown?: boolean;
    duplicateOverride?: boolean;
    schemaDriftWarningShown?: boolean;
    schemaDriftOverride?: boolean;
  },
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
    ...(options?.duplicateWarningShown ? { duplicateWarningShown: true } : {}),
    ...(options?.duplicateOverride ? { duplicateOverride: true } : {}),
    ...(options?.schemaDriftWarningShown ? { schemaDriftWarningShown: true } : {}),
    ...(options?.schemaDriftOverride ? { schemaDriftOverride: true } : {}),
  };
  saveMeta(meta);
  const statePath = defaultStatePath(config.outputDir);
  meta.statePath = statePath;
  meta.importRunId = runId;

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

      // Compute file hashes + ingest diagnoses
      const sourceFileHashes: Record<string, string> = {};
      const schemaFingerprints: Record<string, string> = {};
      const ingestDiagnoses: Record<string, IngestDiagnosis> = {};
      const inputColumns: Record<string, string[]> = {};
      const sourceModes: Record<string, SourceMode> = {};

      for (const f of inputFiles) {
        const abs = resolve(f);
        sourceModes[abs] = resolveSourceMode(f, config);
        const ir = await ingestFile(f, resolveFileIngestOptions(f, config), 1);
        // consume one chunk to trigger diagnosis
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _chunk of ir.records) { break; }
        sourceFileHashes[abs] = ir.sourceFileHash;
        schemaFingerprints[abs] = ir.schemaFingerprint;
        ingestDiagnoses[abs] = ir.diagnosis;
        inputColumns[abs] = ir.columns;
        // drift context 用: 最初のファイルの列名を保存
        if (!meta.columnNames && ir.columns.length > 0) {
          meta.columnNames = ir.columns;
        }

        // Write mapping suggestions
        const suggestions = generateMappingSuggestions(ir.schemaFingerprint, ir.columns);
        if (suggestions.suggestions.length > 0) {
          writeFileSync(
            join(runDir, 'mapping-suggestions.json'),
            JSON.stringify(suggestions, null, 2),
            'utf-8',
          );
        }
      }

      const batchId = sourceBatchId(Object.values(sourceFileHashes));
      const srcKeys = inputFiles.map(f => {
        const entry = config.inputs.find(i => resolve(i.path) === resolve(f));
        return entry?.sourceKey ?? basename(f);
      });
      const lsk = logicalSourceKey(srcKeys);

      // Find previous run for diff
      const allRuns = listRuns(config.outputDir).filter(r => r.id !== runId && r.logicalSourceKey === lsk && r.status === 'completed');
      const prevRunId = allRuns[0]?.id;

      meta.sourceBatchId = batchId;
      meta.logicalSourceKey = lsk;
      meta.sourceFileHashes = sourceFileHashes;
      meta.schemaFingerprints = schemaFingerprints;
      meta.ingestDiagnoses = ingestDiagnoses;
      meta.inputColumns = inputColumns;
      meta.previousRunId = prevRunId;
      meta.sourceModes = sourceModes;
      if (options?.profileId) meta.profileId = options.profileId;
      saveMeta(meta);

      const state = readState(statePath);
      const configHash = computeConfigHash(config);
      const importedAt = new Date().toISOString();
      const sourceBatches = inputFiles.map((f) => {
        const abs = resolve(f);
        const entry = config.inputs.find(i => resolve(i.path) === resolve(f));
        const stats = statSync(f);
        return resolveSourceBatch(state, {
          filePath: f,
          fileLabel: entry?.label,
          fileSize: stats.size,
          sha256: sourceFileHashes[abs] ?? '',
          mode: sourceModes[abs] ?? 'archive',
          configHash,
          sourceType: 'filemaker_export',
          importedAt,
        });
      });
      meta.sourceBatches = sourceBatches;
      saveMeta(meta);
      const sourceBatchIds = sourceBatches.map(b => b.source_batch_id);
      startImportRun(state, {
        runId,
        command: mode,
        sourceBatchIds,
        outputDir: runDir,
        startedAt: meta.startedAt,
      });
      writeState(statePath, state);
      writeFileSync(join(runDir, 'source-batches.json'), JSON.stringify(sourceBatches, null, 2), 'utf-8');

      // Build contexts
      const effectiveMapping = options?.effectiveMapping;
      const contexts: NormalizeContext[] = inputFiles.map((f, i) => ({
        sourceBatchId: batchId,
        importRunId: runId,
        sourceKey: srcKeys[i] ?? basename(f),
        ingestOptions: resolveFileIngestOptions(f, config),
        sourceMode: sourceModes[resolve(f)] ?? 'archive',
        // run 単位の実効 mapping（列レビュー回答から生成）
        effectiveMapping,
      }));

      switch (mode) {
        case 'profile':
          await runProfile(inputFiles[0], runConfig, meta, runId);
          break;
        case 'normalize':
          await runNormalize(inputFiles, runConfig, meta, runId, contexts);
          break;
        case 'detect-duplicates':
          await runDetectDuplicates(inputFiles[0], runConfig, meta, runId);
          break;
        case 'classify':
          await runClassify(inputFiles[0], runConfig, meta, runId);
          break;
        case 'run-all':
          await runAll(inputFiles[0], runConfig, meta, runId, contexts[0]);
          break;
        case 'run-batch':
          await runBatch(inputFiles, runConfig, meta, runId, contexts);
          break;
      }
      meta.status = 'completed';
      meta.completedAt = new Date().toISOString();
      saveMeta(meta);
      const persisted = readState(statePath);
      const mergeSummary: MergeSummary = {
        inserted: meta.summary?.insertedCount ?? 0,
        updated: meta.summary?.updatedCount ?? 0,
        unchanged: meta.summary?.unchangedCount ?? 0,
        duplicate: meta.summary?.duplicateCount ?? 0,
        skipped_archive: meta.summary?.skippedArchiveCount ?? 0,
        skipped_review: meta.summary?.skippedReviewCount ?? 0,
        warnings: [],
      };
      const importRun = finishImportRun(persisted, runId, {
        finishedAt: meta.completedAt,
        status: 'completed',
        summary: mergeSummary,
      });
      writeState(statePath, persisted);
      if (importRun) {
        writeFileSync(join(runDir, 'import-run.json'), JSON.stringify(importRun, null, 2), 'utf-8');
      }

      // Write ingest-diagnoses.json
      writeFileSync(
        join(meta.outputDir, 'ingest-diagnoses.json'),
        JSON.stringify(ingestDiagnoses, null, 2),
        'utf-8',
      );

      // 実効 mapping を使った run の場合は監査証跡として出力ディレクトリに保存する
      if (effectiveMapping !== undefined && effectiveMapping !== null) {
        writeFileSync(
          join(meta.outputDir, 'effective-mapping.json'),
          JSON.stringify({
            appliedAt: new Date().toISOString(),
            runId,
            mapping: effectiveMapping,
            columnCount: Object.keys(effectiveMapping).length,
          }, null, 2),
          'utf-8',
        );
      }

      // Write run-diff.json (v1)
      const diffSummary = buildRunDiffSummaryV1(config.outputDir, meta);
      if (diffSummary) {
        saveRunDiffSummary(meta.outputDir, diffSummary);
      }

      emitter.emit('complete', meta);
    } catch (err) {
      meta.status = 'failed';
      meta.completedAt = new Date().toISOString();
      meta.error = err instanceof Error ? err.message : String(err);
      saveMeta(meta);
      const persisted = readState(statePath);
      const importRun = finishImportRun(persisted, runId, {
        finishedAt: meta.completedAt,
        status: 'failed',
        summary: {
          inserted: meta.summary?.insertedCount ?? 0,
          updated: meta.summary?.updatedCount ?? 0,
          unchanged: meta.summary?.unchangedCount ?? 0,
          duplicate: meta.summary?.duplicateCount ?? 0,
          skipped_archive: meta.summary?.skippedArchiveCount ?? 0,
          skipped_review: meta.summary?.skippedReviewCount ?? 0,
          warnings: [],
        },
        errorMessage: meta.error,
      });
      writeState(statePath, persisted);
      if (importRun) {
        writeFileSync(join(runDir, 'import-run.json'), JSON.stringify(importRun, null, 2), 'utf-8');
      }
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

async function runNormalize(files: string[], config: WorkbenchConfig, meta: RunMeta, runId: string, contexts: NormalizeContext[]): Promise<void> {
  emitProgress(runId, 'normalize', '正規化実行中...', 10);
  let normResult;
  if (files.length === 1) {
    normResult = await normalizeFile(files[0], config, contexts[0]);
  } else {
    normResult = await normalizeFiles(
      files.map((f) => ({ path: f, label: f })),
      config,
      contexts,
    );
  }
  meta.summary = buildSummary(meta);
  meta.summary.normalizedCount = normResult.normalizedCount;
  meta.summary.quarantineCount = normResult.quarantineCount;
  meta.summary.parseFailCount = normResult.parseFailCount;
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

async function runAll(file: string, config: WorkbenchConfig, meta: RunMeta, runId: string, context: NormalizeContext): Promise<void> {
  emitProgress(runId, 'profile', 'プロファイル実行中...', 5);
  const profile = await profileFile(file, config);
  await writeAnomalies(profile, config);
  emitProgress(runId, 'normalize', '正規化実行中...', 25);
  const normResult = await normalizeFile(file, config, context);
  const collisionCount = annotateDeterministicCollisions(normResult.normalizedPath, meta.outputDir);
  const identity = summarizeIdentity(normResult.normalizedPath, meta.outputDir, config);
  const mergeSummary = await applyMainlineMerge(config, meta, runId, normResult.normalizedPath);
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
    parseFailCount: normResult.parseFailCount,
    duplicateGroupCount: dupResult.groups.length,
    classificationBreakdown: classResult.breakdown,
    totalRecordCount: identity.totalRecords,
    mainlineReadyCount: identity.mainlineReadyCount,
    reviewCount: identity.reviewCount,
    archiveOnlyCount: identity.archiveOnlyCount,
    reviewReasonBreakdown: identity.reviewReasonBreakdown,
    mergeEligibilityBreakdown: identity.mergeEligibilityBreakdown,
    semanticOwnerBreakdown: identity.semanticOwnerBreakdown,
    sourceRecordKeyMethodBreakdown: identity.sourceRecordKeyMethodBreakdown,
    recordFamilyBreakdown: identity.recordFamilyBreakdown,
    reviewSourceRecordKeyMethodBreakdown: identity.reviewSourceRecordKeyMethodBreakdown,
    reviewRecordFamilyBreakdown: identity.reviewRecordFamilyBreakdown,
    reviewSemanticOwnerBreakdown: identity.reviewSemanticOwnerBreakdown,
    topReviewReasons: identity.topReviewReasons,
    topWarningIndicators: identity.topWarningIndicators,
    reviewSampleSummary: identity.reviewSampleSummary,
    tuningHints: identity.tuningHints,
    insertedCount: mergeSummary.inserted,
    updatedCount: mergeSummary.updated,
    unchangedCount: mergeSummary.unchanged,
    duplicateCount: mergeSummary.duplicate,
    skippedArchiveCount: mergeSummary.skipped_archive,
    skippedReviewCount: mergeSummary.skipped_review ?? 0,
    identityWarningCount: mergeSummary.warnings.length,
    sourceBatchCount: meta.sourceBatches?.length ?? 0,
    modes: Array.from(new Set(Object.values(meta.sourceModes ?? {}))),
  };
  meta.summary.identityWarningCount = (meta.summary.identityWarningCount ?? 0) + collisionCount;
  writeSummaryJson(config.outputDir, meta.summary);
  writeSummaryMarkdown(config.outputDir, meta.summary, profile);
  emitProgress(runId, 'complete', '完了', 100);
}

async function runBatch(files: string[], config: WorkbenchConfig, meta: RunMeta, runId: string, contexts: NormalizeContext[]): Promise<void> {
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
    contexts,
  );
  const collisionCount = annotateDeterministicCollisions(normResult.normalizedPath, meta.outputDir);
  const identity = summarizeIdentity(normResult.normalizedPath, meta.outputDir, config);
  const mergeSummary = await applyMainlineMerge(config, meta, runId, normResult.normalizedPath);
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
    parseFailCount: normResult.parseFailCount,
    duplicateGroupCount: dupResult.groups.length,
    classificationBreakdown: classResult.breakdown,
    totalRecordCount: identity.totalRecords,
    mainlineReadyCount: identity.mainlineReadyCount,
    reviewCount: identity.reviewCount,
    archiveOnlyCount: identity.archiveOnlyCount,
    reviewReasonBreakdown: identity.reviewReasonBreakdown,
    mergeEligibilityBreakdown: identity.mergeEligibilityBreakdown,
    semanticOwnerBreakdown: identity.semanticOwnerBreakdown,
    sourceRecordKeyMethodBreakdown: identity.sourceRecordKeyMethodBreakdown,
    recordFamilyBreakdown: identity.recordFamilyBreakdown,
    reviewSourceRecordKeyMethodBreakdown: identity.reviewSourceRecordKeyMethodBreakdown,
    reviewRecordFamilyBreakdown: identity.reviewRecordFamilyBreakdown,
    reviewSemanticOwnerBreakdown: identity.reviewSemanticOwnerBreakdown,
    topReviewReasons: identity.topReviewReasons,
    topWarningIndicators: identity.topWarningIndicators,
    reviewSampleSummary: identity.reviewSampleSummary,
    tuningHints: identity.tuningHints,
    insertedCount: mergeSummary.inserted,
    updatedCount: mergeSummary.updated,
    unchangedCount: mergeSummary.unchanged,
    duplicateCount: mergeSummary.duplicate,
    skippedArchiveCount: mergeSummary.skipped_archive,
    skippedReviewCount: mergeSummary.skipped_review ?? 0,
    identityWarningCount: mergeSummary.warnings.length,
    sourceBatchCount: meta.sourceBatches?.length ?? 0,
    modes: Array.from(new Set(Object.values(meta.sourceModes ?? {}))),
  };
  meta.summary.identityWarningCount = (meta.summary.identityWarningCount ?? 0) + collisionCount;
  writeSummaryJson(config.outputDir, meta.summary);
  writeSummaryMarkdown(config.outputDir, meta.summary, profiles[0]);
  emitProgress(runId, 'complete', '完了', 100);
}

function annotateDeterministicCollisions(normalizedPath: string, runOutputDir: string): number {
  if (!existsSync(normalizedPath)) return 0;
  const raw = readFileSync(normalizedPath, 'utf-8');
  const rows = parseCsvSync(raw, { columns: true, skip_empty_lines: true, bom: true }) as Array<Record<string, string>>;
  if (rows.length === 0) return 0;

  const byKey = new Map<string, Set<string>>();
  for (const row of rows) {
    if ((row._source_record_key_method ?? '') !== 'deterministic') continue;
    const key = row._source_record_key ?? '';
    if (!key) continue;
    const fp = row._structural_fingerprint_mainline || row._structural_fingerprint || '';
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key)!.add(fp);
  }
  const collidedKeys = new Set(Array.from(byKey.entries()).filter(([, fps]) => fps.size > 1).map(([k]) => k));
  if (collidedKeys.size === 0) return 0;

  const collisions: Array<{ source_record_key: string; count: number }> = [];
  for (const key of collidedKeys) {
    collisions.push({ source_record_key: key, count: byKey.get(key)?.size ?? 0 });
  }
  writeFileSync(join(runOutputDir, 'deterministic-collisions.json'), JSON.stringify(collisions, null, 2), 'utf-8');

  for (const row of rows) {
    if (!collidedKeys.has(row._source_record_key ?? '')) continue;
    row._merge_eligibility = 'review';
    row._review_reason = 'deterministic_collision';
  }
  const out = stringifyCsvSync(rows, { header: true, columns: Object.keys(rows[0] ?? {}) });
  writeFileSync(normalizedPath, out, 'utf-8');
  return collisions.length;
}

export function summarizeIdentity(
  normalizedPath: string,
  runOutputDir?: string,
  config?: WorkbenchConfig,
): {
  totalRecords: number;
  mainlineReadyCount: number;
  reviewCount: number;
  archiveOnlyCount: number;
  reviewReasonBreakdown: Record<string, number>;
  mergeEligibilityBreakdown: Record<'mainline_ready' | 'review' | 'archive_only', number>;
  semanticOwnerBreakdown: Record<string, number>;
  sourceRecordKeyMethodBreakdown: Record<string, number>;
  recordFamilyBreakdown: Record<string, number>;
  reviewSourceRecordKeyMethodBreakdown: Record<string, number>;
  reviewRecordFamilyBreakdown: Record<string, number>;
  reviewSemanticOwnerBreakdown: Record<string, number>;
  topReviewReasons: Array<{ reason: string; count: number }>;
  topWarningIndicators: Array<{ indicator: string; count: number }>;
  reviewSampleSummary: {
    sampleCap: number;
    reasons: Record<string, number>;
    totalSampledRows: number;
    artifactFile: string;
  };
  tuningHints: {
    likely_tuning_targets: string[];
    family_with_highest_review_ratio: { family: string; reviewRatio: number; reviewCount: number; totalCount: number } | null;
    key_method_with_highest_review_ratio: { method: string; reviewRatio: number; reviewCount: number; totalCount: number } | null;
    dominant_review_reasons: Array<{ reason: string; count: number }>;
    likely_next_checks: string[];
  };
} {
  const resolveFamily = (row: Record<string, string>): string => {
    const explicit = (row._record_family ?? '').trim();
    if (explicit) return explicit;
    const file = basename((row._source_file ?? '').trim());
    if (!config) return 'unknown';
    for (const [pattern, strategy] of Object.entries(config.identityStrategies ?? {})) {
      if (globMatch(pattern, file) && strategy.recordFamily) return strategy.recordFamily;
    }
    return 'unknown';
  };
  if (!existsSync(normalizedPath)) {
    return {
      totalRecords: 0,
      mainlineReadyCount: 0,
      reviewCount: 0,
      archiveOnlyCount: 0,
      reviewReasonBreakdown: {},
      mergeEligibilityBreakdown: { mainline_ready: 0, review: 0, archive_only: 0 },
      semanticOwnerBreakdown: {},
      sourceRecordKeyMethodBreakdown: {},
      recordFamilyBreakdown: {},
      reviewSourceRecordKeyMethodBreakdown: {},
      reviewRecordFamilyBreakdown: {},
      reviewSemanticOwnerBreakdown: {},
      topReviewReasons: [],
      topWarningIndicators: [],
      reviewSampleSummary: {
        sampleCap: 5,
        reasons: {},
        totalSampledRows: 0,
        artifactFile: 'identity-review-samples.json',
      },
      tuningHints: {
        likely_tuning_targets: [],
        family_with_highest_review_ratio: null,
        key_method_with_highest_review_ratio: null,
        dominant_review_reasons: [],
        likely_next_checks: [],
      },
    };
  }
  const raw = readFileSync(normalizedPath, 'utf-8');
  const rows = parseCsvSync(raw, { columns: true, skip_empty_lines: true, bom: true }) as Array<Record<string, string>>;
  const reviewReasonBreakdown: Record<string, number> = {};
  const mergeEligibilityBreakdown: Record<'mainline_ready' | 'review' | 'archive_only', number> = {
    mainline_ready: 0,
    review: 0,
    archive_only: 0,
  };
  const semanticOwnerBreakdown: Record<string, number> = {};
  const sourceRecordKeyMethodBreakdown: Record<string, number> = {};
  const recordFamilyBreakdown: Record<string, number> = {};
  const reviewSourceRecordKeyMethodBreakdown: Record<string, number> = {};
  const reviewRecordFamilyBreakdown: Record<string, number> = {};
  const reviewSemanticOwnerBreakdown: Record<string, number> = {};
  const sampleCap = 5;
  const sampleReasonPriority = [
    'fallback_key',
    'activity_timestamp_insufficient',
    'semantic_owner_unknown',
    'semantic_owner_hybrid',
    'deterministic_collision',
    'archive_mode',
  ];
  const compactBusinessFields = (row: Record<string, string>, family: string): Record<string, string> => {
    const pick = (candidates: string[]): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const k of candidates) {
        const v = (row[k] ?? '').trim();
        if (v) out[k] = v;
      }
      return out;
    };
    if (family === 'apo_list') {
      return pick(['customer_name', 'name', 'phone', 'address', 'list_created_date', 'created_at']);
    }
    if (family.includes('customer') || family.includes('deal')) {
      return pick(['customer_name', 'name', 'phone', 'address', 'contract_id', 'deal_id', 'application_id']);
    }
    if (family.includes('call') || family.includes('visit') || family.includes('retry') || family.includes('activity')) {
      return pick(['activity_date', 'activity_datetime', 'operator', 'staff', 'result', 'outcome', 'note', 'memo']);
    }
    return pick(['customer_name', 'name', 'phone', 'address', 'activity_date', 'result']);
  };
  const reviewSamplesByReason: Record<string, Array<Record<string, unknown>>> = {};
  for (const row of rows) {
    const eligibility = ((row._merge_eligibility ?? '').trim() || 'review') as 'mainline_ready' | 'review' | 'archive_only';
    if (eligibility in mergeEligibilityBreakdown) {
      mergeEligibilityBreakdown[eligibility]++;
    }
    const reason = (row._review_reason ?? '').trim();
    if (reason) {
      reviewReasonBreakdown[reason] = (reviewReasonBreakdown[reason] ?? 0) + 1;
    }
    const owner = ((row._semantic_owner ?? '').trim() || 'unknown');
    semanticOwnerBreakdown[owner] = (semanticOwnerBreakdown[owner] ?? 0) + 1;

    const method = ((row._source_record_key_method ?? '').trim() || 'unknown');
    sourceRecordKeyMethodBreakdown[method] = (sourceRecordKeyMethodBreakdown[method] ?? 0) + 1;

    const family = resolveFamily(row);
    recordFamilyBreakdown[family] = (recordFamilyBreakdown[family] ?? 0) + 1;

    if (eligibility === 'review') {
      reviewSourceRecordKeyMethodBreakdown[method] = (reviewSourceRecordKeyMethodBreakdown[method] ?? 0) + 1;
      reviewRecordFamilyBreakdown[family] = (reviewRecordFamilyBreakdown[family] ?? 0) + 1;
      reviewSemanticOwnerBreakdown[owner] = (reviewSemanticOwnerBreakdown[owner] ?? 0) + 1;

      const sampleReason = reason || 'other';
      const bucket = reviewSamplesByReason[sampleReason] ?? [];
      if (bucket.length < sampleCap) {
        bucket.push({
          source_file: row._source_file ?? '',
          source_key: row._source_key ?? '',
          record_family: family,
          source_record_key_method: method,
          source_record_key: row._source_record_key ?? '',
          entity_match_key: row._entity_match_key ?? '',
          merge_eligibility: eligibility,
          review_reason: sampleReason,
          semantic_owner: owner,
          fields: compactBusinessFields(row, family),
        });
      }
      reviewSamplesByReason[sampleReason] = bucket;
    }
  }
  const topReviewReasons = Object.entries(reviewReasonBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));
  const topWarningIndicators = Object.entries({
    ...reviewReasonBreakdown,
    ...(reviewSourceRecordKeyMethodBreakdown.fallback ? { fallback_method_review: reviewSourceRecordKeyMethodBreakdown.fallback } : {}),
  })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([indicator, count]) => ({ indicator, count }));
  const dominant_review_reasons = topReviewReasons.slice(0, 3);
  const buildTopRatio = (
    totalBreakdown: Record<string, number>,
    reviewBreakdown: Record<string, number>,
    keyName: 'family' | 'method',
  ): { family: string; reviewRatio: number; reviewCount: number; totalCount: number } | { method: string; reviewRatio: number; reviewCount: number; totalCount: number } | null => {
    let bestKey = '';
    let bestRatio = -1;
    let bestReview = 0;
    let bestTotal = 0;
    for (const [k, total] of Object.entries(totalBreakdown)) {
      if (!total) continue;
      const review = reviewBreakdown[k] ?? 0;
      const ratio = review / total;
      if (ratio > bestRatio || (ratio === bestRatio && review > bestReview)) {
        bestKey = k;
        bestRatio = ratio;
        bestReview = review;
        bestTotal = total;
      }
    }
    if (!bestKey) return null;
    if (keyName === 'family') {
      return { family: bestKey, reviewRatio: Number(bestRatio.toFixed(4)), reviewCount: bestReview, totalCount: bestTotal };
    }
    return { method: bestKey, reviewRatio: Number(bestRatio.toFixed(4)), reviewCount: bestReview, totalCount: bestTotal };
  };
  const family_with_highest_review_ratio = buildTopRatio(recordFamilyBreakdown, reviewRecordFamilyBreakdown, 'family') as
    | { family: string; reviewRatio: number; reviewCount: number; totalCount: number }
    | null;
  const key_method_with_highest_review_ratio = buildTopRatio(sourceRecordKeyMethodBreakdown, reviewSourceRecordKeyMethodBreakdown, 'method') as
    | { method: string; reviewRatio: number; reviewCount: number; totalCount: number }
    | null;
  const likely_tuning_targets = new Set<string>();
  const likely_next_checks = new Set<string>();
  for (const { reason } of dominant_review_reasons) {
    if (reason === 'fallback_key') {
      likely_tuning_targets.add('source_record_key');
      likely_next_checks.add('inspect source native IDs and deterministic field set for dominant family');
    } else if (reason === 'activity_timestamp_insufficient') {
      likely_tuning_targets.add('activity_timestamp_fields');
      likely_next_checks.add('inspect timestamp/operator/result mappings for activity-like family');
    } else if (reason === 'semantic_owner_unknown' || reason === 'semantic_owner_hybrid') {
      likely_tuning_targets.add('semantic_owner_inputs');
      likely_next_checks.add('inspect family classification and semantic owner inference input columns');
    } else if (reason === 'deterministic_collision') {
      likely_tuning_targets.add('deterministic_key_fields');
      likely_next_checks.add('inspect deterministic key field set and mainline fingerprint field set');
    } else if (reason === 'archive_mode') {
      likely_tuning_targets.add('source_mode_routing');
      likely_next_checks.add('verify sourceMode and intended archive routing');
    }
  }
  if (family_with_highest_review_ratio && family_with_highest_review_ratio.reviewRatio >= 0.5) {
    likely_next_checks.add(`review-heavy family detected: ${family_with_highest_review_ratio.family}`);
  }
  if (key_method_with_highest_review_ratio && key_method_with_highest_review_ratio.reviewRatio >= 0.5) {
    likely_next_checks.add(`review-heavy key method detected: ${key_method_with_highest_review_ratio.method}`);
  }
  const tuningHints = {
    likely_tuning_targets: Array.from(likely_tuning_targets),
    family_with_highest_review_ratio,
    key_method_with_highest_review_ratio,
    dominant_review_reasons,
    likely_next_checks: Array.from(likely_next_checks),
  };
  const orderedSampleReasons = [
    ...sampleReasonPriority.filter((r) => (reviewSamplesByReason[r] ?? []).length > 0),
    ...Object.keys(reviewSamplesByReason).filter((r) => !sampleReasonPriority.includes(r)).sort(),
  ];
  const reviewSamples: Record<string, Array<Record<string, unknown>>> = {};
  for (const reason of orderedSampleReasons) {
    reviewSamples[reason] = reviewSamplesByReason[reason];
  }
  const reviewSampleSummary = {
    sampleCap,
    reasons: Object.fromEntries(Object.entries(reviewSamples).map(([reason, sampleRows]) => [reason, sampleRows.length])),
    totalSampledRows: Object.values(reviewSamples).reduce((acc, items) => acc + items.length, 0),
    artifactFile: 'identity-review-samples.json',
  };
  const summary = {
    totalRecords: rows.length,
    mainlineReadyCount: mergeEligibilityBreakdown.mainline_ready,
    reviewCount: mergeEligibilityBreakdown.review,
    archiveOnlyCount: mergeEligibilityBreakdown.archive_only,
    reviewReasonBreakdown,
    mergeEligibilityBreakdown,
    semanticOwnerBreakdown,
    sourceRecordKeyMethodBreakdown,
    recordFamilyBreakdown,
    reviewSourceRecordKeyMethodBreakdown,
    reviewRecordFamilyBreakdown,
    reviewSemanticOwnerBreakdown,
    topReviewReasons,
    topWarningIndicators,
    reviewSampleSummary,
    tuningHints,
  };
  if (runOutputDir) {
    writeFileSync(join(runOutputDir, 'review-reason-summary.json'), JSON.stringify(reviewReasonBreakdown, null, 2), 'utf-8');
    writeFileSync(join(runOutputDir, 'merge-eligibility-summary.json'), JSON.stringify(mergeEligibilityBreakdown, null, 2), 'utf-8');
    writeFileSync(join(runOutputDir, 'identity-diagnosis.json'), JSON.stringify(summary, null, 2), 'utf-8');
    writeFileSync(join(runOutputDir, 'identity-tuning-hints.json'), JSON.stringify(tuningHints, null, 2), 'utf-8');
    writeFileSync(
      join(runOutputDir, 'identity-review-samples.json'),
      JSON.stringify({ sampleCap, reasons: reviewSampleSummary.reasons, samples: reviewSamples }, null, 2),
      'utf-8',
    );
  }
  return summary;
}

async function applyMainlineMerge(
  config: WorkbenchConfig,
  meta: RunMeta,
  runId: string,
  normalizedPath: string,
): Promise<MergeSummary> {
  const statePath = meta.statePath ?? defaultStatePath(config.outputDir);
  const state = readState(statePath);
  const sourceBatchBySourceKey: Record<string, string> = {};
  const modeBySourceKey: Record<string, SourceMode> = {};
  for (const filePath of meta.inputFiles) {
    const entry = config.inputs.find(i => resolve(i.path) === resolve(filePath));
    const sourceKey = entry?.sourceKey ?? basename(filePath);
    const mode = meta.sourceModes?.[filePath] ?? 'archive';
    modeBySourceKey[sourceKey] = mode;
    const batch = meta.sourceBatches?.find(b => resolve(b.file_path) === resolve(filePath));
    if (batch) sourceBatchBySourceKey[sourceKey] = batch.source_batch_id;
  }
  const summary = await mergeMainlineRows({
    normalizedPath,
    sourceBatchBySourceKey,
    modeBySourceKey,
    importRunId: runId,
    config,
    ledger: state.merge_ledger,
  });
  writeState(statePath, state);
  writeFileSync(join(meta.outputDir, 'merge-summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  return summary;
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
    parseFailCount: 0,
    duplicateGroupCount: 0,
    classificationBreakdown: empty,
  };
}
