/**
 * Pipeline runner — wraps existing core functions for use by both CLI and UI.
 * Manages run directories and metadata.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { join, resolve, basename } from 'node:path';
import { profileFile } from './profiler.js';
import { normalizeFile, normalizeFiles } from './normalizer.js';
import type { NormalizeContext } from './normalizer.js';
import { detectDuplicates } from './duplicate-detector.js';
import { classifyFile } from './classifier.js';
import { generateHandoffBundle } from './handoff-bundle.js';
import { writeCsv } from '../io/csv-writer.js';
import { writeSummaryJson, writeSummaryMarkdown } from '../io/report-writer.js';
import { ingestFile } from '../io/file-reader.js';
import { sourceBatchId, logicalSourceKey } from '../ingest/fingerprint.js';
import { generateMappingSuggestions } from './column-mapper.js';
import type { WorkbenchConfig } from '../config/schema.js';
import type {
  CountReconciliationSummary,
  EligibilityStage,
  FinalDisposition,
  NextActionView,
  ParentExtractionClassification,
  ReportSummary,
  ProfileResult,
  CandidateType,
  IngestDiagnosis,
  SourceRoutingDecision,
  SourceRecordFlow,
} from '../types/index.js';
import { buildRunDiffSummaryV1, saveRunDiffSummary } from './run-diff-summary.js';
import { globMatch } from './column-mapper.js';
import { analyzeSourceRouting } from './source-routing.js';
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
import { buildContentFingerprint, buildDiffIdentity, firstRule } from './mainline-merge.js';
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
  sourceRouting?: Record<string, SourceRoutingDecision>;
  importRunId?: string;
  nextActionView?: NextActionView;
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

function initBreakdown<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function readCsvRows(path: string): Array<Record<string, string>> {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  if (!raw.trim()) return [];
  return parseCsvSync(raw, { columns: true, skip_empty_lines: true, bom: true }) as Array<Record<string, string>>;
}

function writeCsvRows(path: string, rows: Array<Record<string, string>>): void {
  if (rows.length === 0) return;
  writeFileSync(path, stringifyCsvSync(rows, { header: true, columns: Object.keys(rows[0] ?? {}) }), 'utf-8');
}

function normalizeParentExtractionClassification(value: string | undefined): ParentExtractionClassification {
  const raw = (value ?? '').trim();
  if (raw === 'parent_candidate' || raw === 'ambiguous_parent' || raw === 'child_continuation' || raw === 'not_applicable') {
    return raw;
  }
  return 'not_applicable';
}

function normalizeEligibilityStage(row: Record<string, string>, isQuarantine = false): EligibilityStage {
  if (isQuarantine) return 'quarantine';
  const raw = (row._merge_eligibility ?? '').trim();
  if (raw === 'mainline_ready' || raw === 'review' || raw === 'archive_only') return raw;
  return 'review';
}

function normalizeFinalDisposition(row: Record<string, string>, isQuarantine = false): FinalDisposition {
  if (isQuarantine) return 'quarantine';
  const raw = (row._final_disposition ?? '').trim();
  if (
    raw === 'mainline_ready'
    || raw === 'review'
    || raw === 'archive_only'
    || raw === 'quarantine'
    || raw === 'inserted'
    || raw === 'updated'
    || raw === 'unchanged'
    || raw === 'duplicate'
  ) {
    return raw;
  }
  return normalizeEligibilityStage(row, isQuarantine);
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
      const sourceRouting: Record<string, SourceRoutingDecision> = {};

      for (const f of inputFiles) {
        const abs = resolve(f);
        const ir = await ingestFile(f, resolveFileIngestOptions(f, config), 1);
        // consume one chunk to trigger diagnosis
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _chunk of ir.records) { break; }
        const routing = analyzeSourceRouting(f, ir.columns, config);
        sourceModes[abs] = routing.mode;
        sourceRouting[abs] = routing;
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
      meta.sourceRouting = sourceRouting;
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
          notes: sourceRouting[abs]?.reason,
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
        sourceRouting: sourceRouting[resolve(f)],
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
        JSON.stringify(meta.ingestDiagnoses ?? ingestDiagnoses, null, 2),
        'utf-8',
      );
      writeFileSync(
        join(meta.outputDir, 'source-routing.json'),
        JSON.stringify(meta.sourceRouting ?? sourceRouting, null, 2),
        'utf-8',
      );
      if (meta.summary?.parentExtractionSummaries) {
        writeFileSync(
          join(meta.outputDir, 'parent-extraction-diagnostics.json'),
          JSON.stringify(meta.summary.parentExtractionSummaries, null, 2),
          'utf-8',
        );
      }
      if (meta.summary?.countReconciliation) {
        writeFileSync(
          join(meta.outputDir, 'count-reconciliation.json'),
          JSON.stringify(meta.summary.countReconciliation, null, 2),
          'utf-8',
        );
      }

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
  meta.summary.recordCount = normResult.recordCount;
  meta.summary.columnCount = normResult.columnCount;
  meta.summary.normalizedCount = normResult.normalizedCount;
  meta.summary.quarantineCount = normResult.quarantineCount;
  meta.summary.parseFailCount = normResult.parseFailCount;
  meta.summary.sourceRecordFlows = normResult.sourceRecordFlows;
  meta.summary.sourceRoutingDecisions = meta.sourceRouting;
  meta.summary.parentExtractionSummaries = normResult.parentExtractionSummaries;
  meta.summary.countReconciliation = buildCountReconciliation(normResult.normalizedPath, normResult.quarantinePath, meta.outputDir);
  const handoff = await buildHandoffProjection(
    meta.outputDir,
    normResult.normalizedPath,
    normResult.quarantinePath,
    meta.summary.countReconciliation,
    meta.summary.recordCount,
  );
  meta.summary.handoffBundle = handoff.handoffBundle;
  meta.summary.nextActionView = handoff.nextActionView;
  meta.nextActionView = handoff.nextActionView;
  meta.ingestDiagnoses = { ...(meta.ingestDiagnoses ?? {}), ...normResult.ingestDiagnoses };
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
  meta.ingestDiagnoses = { ...(meta.ingestDiagnoses ?? {}), ...normResult.ingestDiagnoses };
  const collisionCount = annotateDeterministicCollisions(normResult.normalizedPath, meta.outputDir);
  const mergeSummary = await applyMainlineMerge(config, meta, runId, normResult.normalizedPath);
  const identity = summarizeIdentity(normResult.normalizedPath, meta.outputDir, config);
  const reconciliation = buildCountReconciliation(normResult.normalizedPath, normResult.quarantinePath, meta.outputDir);
  const handoff = await buildHandoffProjection(meta.outputDir, normResult.normalizedPath, normResult.quarantinePath, reconciliation, totalInputRowCount(normResult.sourceRecordFlows, profile.recordCount));
  emitProgress(runId, 'detect-duplicates', '重複検出実行中...', 50);
  const dupResult = await detectDuplicates(normResult.normalizedPath, config);
  emitProgress(runId, 'classify', '分類実行中...', 75);
  const classResult = await classifyFile(normResult.normalizedPath, config);

  meta.summary = {
    generatedAt: new Date().toISOString(),
    inputFile: meta.inputFiles.join(', '),
    recordCount: totalInputRowCount(normResult.sourceRecordFlows, profile.recordCount),
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
    sourceRoutingDecisions: meta.sourceRouting,
    sourceRecordFlows: normResult.sourceRecordFlows,
    parentExtractionSummaries: normResult.parentExtractionSummaries,
    countReconciliation: reconciliation,
    handoffBundle: handoff.handoffBundle,
    nextActionView: handoff.nextActionView,
  };
  meta.nextActionView = handoff.nextActionView;
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
  meta.ingestDiagnoses = { ...(meta.ingestDiagnoses ?? {}), ...normResult.ingestDiagnoses };
  const collisionCount = annotateDeterministicCollisions(normResult.normalizedPath, meta.outputDir);
  const mergeSummary = await applyMainlineMerge(config, meta, runId, normResult.normalizedPath);
  const identity = summarizeIdentity(normResult.normalizedPath, meta.outputDir, config);
  const reconciliation = buildCountReconciliation(normResult.normalizedPath, normResult.quarantinePath, meta.outputDir);
  const handoff = await buildHandoffProjection(meta.outputDir, normResult.normalizedPath, normResult.quarantinePath, reconciliation, totalInputRowCount(normResult.sourceRecordFlows, totalRecords));
  emitProgress(runId, 'detect-duplicates', '重複検出実行中...', 55);
  const dupResult = await detectDuplicates(normResult.normalizedPath, config);
  emitProgress(runId, 'classify', '分類実行中...', 80);
  const classResult = await classifyFile(normResult.normalizedPath, config);

  meta.summary = {
    generatedAt: new Date().toISOString(),
    inputFile: meta.inputFiles.join(', '),
    recordCount: totalInputRowCount(normResult.sourceRecordFlows, totalRecords),
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
    sourceRoutingDecisions: meta.sourceRouting,
    sourceRecordFlows: normResult.sourceRecordFlows,
    parentExtractionSummaries: normResult.parentExtractionSummaries,
    countReconciliation: reconciliation,
    handoffBundle: handoff.handoffBundle,
    nextActionView: handoff.nextActionView,
  };
  meta.nextActionView = handoff.nextActionView;
  meta.summary.identityWarningCount = (meta.summary.identityWarningCount ?? 0) + collisionCount;
  writeSummaryJson(config.outputDir, meta.summary);
  writeSummaryMarkdown(config.outputDir, meta.summary, profiles[0]);
  emitProgress(runId, 'complete', '完了', 100);
}

function annotateDeterministicCollisions(normalizedPath: string, runOutputDir: string): number {
  if (!existsSync(normalizedPath)) return 0;
  const rows = readCsvRows(normalizedPath);
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
    row._final_disposition = 'review';
    row._final_disposition_reason = 'deterministic_collision';
  }
  writeCsvRows(normalizedPath, rows);
  return collisions.length;
}

export function buildCountReconciliation(
  normalizedPath: string,
  quarantinePath: string,
  runOutputDir?: string,
): CountReconciliationSummary {
  const parentKeys: ParentExtractionClassification[] = ['not_applicable', 'parent_candidate', 'ambiguous_parent', 'child_continuation'];
  const eligibilityKeys: EligibilityStage[] = ['mainline_ready', 'review', 'archive_only', 'quarantine'];
  const dispositionKeys: FinalDisposition[] = ['mainline_ready', 'review', 'archive_only', 'quarantine', 'inserted', 'updated', 'unchanged', 'duplicate'];
  const normalizedRows = readCsvRows(normalizedPath);
  const quarantineRows = readCsvRows(quarantinePath);
  const summary: CountReconciliationSummary = {
    inputRowCount: normalizedRows.length + quarantineRows.length,
    normalizedRowCount: normalizedRows.length,
    quarantineRowCount: quarantineRows.length,
    accountedRowCount: 0,
    unaccountedRowCount: 0,
    parentExtractionBreakdown: initBreakdown(parentKeys),
    eligibilityBreakdown: initBreakdown(eligibilityKeys),
    finalDispositionBreakdown: initBreakdown(dispositionKeys),
    extractionToEligibility: Object.fromEntries(parentKeys.map((key) => [key, initBreakdown(eligibilityKeys)])) as Record<ParentExtractionClassification, Record<EligibilityStage, number>>,
    extractionToDisposition: Object.fromEntries(parentKeys.map((key) => [key, initBreakdown(dispositionKeys)])) as Record<ParentExtractionClassification, Record<FinalDisposition, number>>,
    eligibilityToDisposition: Object.fromEntries(eligibilityKeys.map((key) => [key, initBreakdown(dispositionKeys)])) as Record<EligibilityStage, Record<FinalDisposition, number>>,
    dispositionReasonBreakdown: {},
    dispositionReasonByFinalDisposition: Object.fromEntries(dispositionKeys.map((key) => [key, {}])) as Record<FinalDisposition, Record<string, number>>,
  };

  const accumulate = (row: Record<string, string>, isQuarantine: boolean): void => {
    const classification = normalizeParentExtractionClassification(row._parent_extraction_classification);
    const eligibility = normalizeEligibilityStage(row, isQuarantine);
    const disposition = normalizeFinalDisposition(row, isQuarantine);
    const reason = (isQuarantine ? row._quarantine_reason : row._final_disposition_reason) || row._review_reason || disposition;

    summary.parentExtractionBreakdown[classification]++;
    summary.eligibilityBreakdown[eligibility]++;
    summary.finalDispositionBreakdown[disposition]++;
    summary.extractionToEligibility[classification][eligibility]++;
    summary.extractionToDisposition[classification][disposition]++;
    summary.eligibilityToDisposition[eligibility][disposition]++;
    summary.dispositionReasonBreakdown[reason] = (summary.dispositionReasonBreakdown[reason] ?? 0) + 1;
    summary.dispositionReasonByFinalDisposition[disposition][reason] = (summary.dispositionReasonByFinalDisposition[disposition][reason] ?? 0) + 1;
    summary.accountedRowCount++;
  };

  normalizedRows.forEach((row) => accumulate(row, false));
  quarantineRows.forEach((row) => accumulate(row, true));
  summary.unaccountedRowCount = summary.inputRowCount - summary.accountedRowCount;

  if (runOutputDir) {
    writeFileSync(join(runOutputDir, 'count-reconciliation.json'), JSON.stringify(summary, null, 2), 'utf-8');
  }

  return summary;
}

async function buildHandoffProjection(
  outputDir: string,
  normalizedPath: string,
  quarantinePath: string,
  reconciliation: CountReconciliationSummary,
  recordCount: number,
): Promise<{ handoffBundle: ReportSummary['handoffBundle']; nextActionView: NextActionView }> {
  const handoff = await generateHandoffBundle({
    outputDir,
    normalizedPath,
    quarantinePath,
    reconciliation,
    recordCount,
  });
  return {
    handoffBundle: handoff.summary,
    nextActionView: handoff.nextActionView,
  };
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
    'mixed_parent_child_export',
    'mixed_parent_child_ambiguous',
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
    if (reason === 'mixed_parent_child_export') {
      likely_tuning_targets.add('mixed_parent_child_export_handling');
      likely_next_checks.add('extract parent candidate rows or separate child history columns before mainline merge');
    } else if (reason === 'mixed_parent_child_ambiguous') {
      likely_tuning_targets.add('mixed_parent_child_parent_rules');
      likely_next_checks.add('tighten parent extraction signals for ambiguous mixed-export rows');
    } else if (reason === 'fallback_key') {
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
  const summary: MergeSummary = { inserted: 0, updated: 0, unchanged: 0, duplicate: 0, skipped_archive: 0, skipped_review: 0, warnings: [] };
  const rows = readCsvRows(normalizedPath);
  const warnings = new Set<string>();

  for (const record of rows) {
    const sourceKey = (record._source_key ?? '').trim();
    const sourceFile = (record._source_file ?? '').trim();
    const mode = modeBySourceKey[sourceKey] ?? 'archive';

    if (mode !== 'mainline') {
      summary.skipped_archive++;
      record._final_disposition = 'archive_only';
      record._final_disposition_reason = 'archive_mode';
      continue;
    }

    if ((record._merge_eligibility ?? '').trim() && (record._merge_eligibility ?? '').trim() !== 'mainline_ready') {
      summary.skipped_review = (summary.skipped_review ?? 0) + 1;
      record._final_disposition = 'review';
      record._final_disposition_reason = (record._review_reason ?? '').trim() || 'review_hold';
      warnings.add(`${basename(sourceFile)}: merge eligibility=${record._merge_eligibility} reason=${record._review_reason ?? ''}`);
      continue;
    }

    const matchedRule = firstRule(config, sourceFile);
    const identity = buildDiffIdentity(record, matchedRule?.[1] ?? null);
    if (identity.warning) {
      warnings.add(`${basename(sourceFile)}: ${identity.warning}`);
    }

    const rowFingerprint = (record._structural_fingerprint_mainline ?? '').trim()
      || (record._structural_fingerprint ?? '').trim()
      || (record._row_fingerprint ?? '').trim()
      || buildContentFingerprint(record);
    const sourceRecordKey = (record._source_record_key ?? '').trim();
    const ledgerIdentity = sourceRecordKey || identity.identityKey;
    const ledgerKey = createHash('sha256').update(`${sourceKey}\0${ledgerIdentity}`).digest('hex');
    const existing = state.merge_ledger[ledgerKey];

    if (!existing) {
      state.merge_ledger[ledgerKey] = {
        ledger_key: ledgerKey,
        diff_key: identity.diffKey,
        row_fingerprint: rowFingerprint,
        source_key: sourceKey,
        source_file: sourceFile,
        source_batch_id: sourceBatchBySourceKey[sourceKey] ?? '',
        updated_at: identity.updatedAt,
        last_import_run_id: runId,
        last_seen_at: new Date().toISOString(),
      };
      summary.inserted++;
      record._final_disposition = 'inserted';
      record._final_disposition_reason = 'new_identity';
      continue;
    }

    if (existing.row_fingerprint === rowFingerprint) {
      if (existing.source_batch_id === (sourceBatchBySourceKey[sourceKey] ?? '')) {
        summary.duplicate++;
        record._final_disposition = 'duplicate';
        record._final_disposition_reason = 'same_batch_same_fingerprint';
      } else {
        summary.unchanged++;
        record._final_disposition = 'unchanged';
        record._final_disposition_reason = 'existing_same_fingerprint';
      }
      existing.last_import_run_id = runId;
      existing.last_seen_at = new Date().toISOString();
      continue;
    }

    existing.row_fingerprint = rowFingerprint;
    existing.source_file = sourceFile;
    existing.source_batch_id = sourceBatchBySourceKey[sourceKey] ?? existing.source_batch_id;
    existing.updated_at = identity.updatedAt;
    existing.last_import_run_id = runId;
    existing.last_seen_at = new Date().toISOString();
    summary.updated++;
    record._final_disposition = 'updated';
    record._final_disposition_reason = 'existing_changed_fingerprint';
  }

  summary.warnings = Array.from(warnings);
  writeState(statePath, state);
  writeCsvRows(normalizedPath, rows);
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
    sourceRoutingDecisions: meta.sourceRouting,
  };
}

function totalInputRowCount(flows: Record<string, SourceRecordFlow> | undefined, fallback: number): number {
  if (!flows || Object.keys(flows).length === 0) return fallback;
  return Object.values(flows).reduce((sum, flow) => sum + flow.inputRowCount, 0);
}
