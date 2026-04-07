import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { ingestFile } from '../io/file-reader.js';
import { executeRun, getRun, listRuns, type OriginalSourceContext, type RunMeta, type RunMode } from './pipeline-runner.js';
import {
  buildPartIngestOptionsFromManifest,
  saveSplitManifest,
  splitCsvFile,
  updateSplitManifestStage,
} from './huge-csv-split.js';
import type { WorkbenchConfig } from '../config/schema.js';
import type {
  CsvIngestDiagnosis,
  SourceRoutingDecision,
  SplitManifest,
  SplitRunPartResult,
  SplitRunSummary,
} from '../types/index.js';
import type { IngestOptions } from '../ingest/ingest-options.js';

interface StartSplitRunOptions {
  filePath: string;
  config: WorkbenchConfig;
  mode: 'normalize' | 'run-all';
  configPath?: string;
  rowsPerPart?: number;
  outputDir?: string;
  ingestOptions?: IngestOptions;
}

interface ResumeSplitRunOptions {
  manifestPath: string;
  config: WorkbenchConfig;
  configPath?: string;
  reuseRunId?: string;
}

interface ReusableContext {
  profileId?: string;
  effectiveMapping?: Record<string, string>;
  sourceRouting?: SourceRoutingDecision;
  ingestOptions: IngestOptions;
  reusedFromRunId: string;
}

function stemOf(filePath: string): string {
  return basename(filePath, extname(filePath));
}

function splitRunRootDir(baseOutputDir: string, filePath: string): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return join(baseOutputDir, 'split-runs', `${ts}_${stemOf(filePath)}`);
}

function summaryPathFor(rootDir: string): string {
  return join(rootDir, 'split-run-summary.json');
}

function summaryMarkdownPathFor(rootDir: string): string {
  return join(rootDir, 'split-run-summary.md');
}

function manifestPathFor(rootDir: string): string {
  return join(rootDir, 'split-manifest.json');
}

function saveSplitRunSummary(rootDir: string, summary: SplitRunSummary): void {
  writeFileSync(summaryPathFor(rootDir), JSON.stringify(summary, null, 2), 'utf8');
  const lines = [
    '# Split Run Summary',
    '',
    `- stage: ${summary.stage}`,
    `- mode: ${summary.mode}`,
    `- sourceFile: ${summary.sourceFile}`,
    `- totalParts: ${summary.totalParts}`,
    `- completedParts: ${summary.completedParts}`,
    `- failedParts: ${summary.failedParts}`,
    `- skippedParts: ${summary.skippedParts}`,
    `- stopReason: ${summary.stopReason ?? 'none'}`,
    `- reusedFromRunId: ${summary.reusedFromRunId ?? 'none'}`,
    `- reusedProfileId: ${summary.reusedProfileId ?? 'none'}`,
    `- reusedEffectiveMapping: ${summary.reusedEffectiveMapping}`,
    `- reusedSourceRouting: ${summary.reusedSourceRouting}`,
    `- schemaFingerprintMatchedAllParts: ${summary.schemaFingerprintMatchedAllParts}`,
    ...(summary.reusableRunCandidateIds && summary.reusableRunCandidateIds.length > 0
      ? [`- reusableRunCandidateIds: ${summary.reusableRunCandidateIds.join(', ')}`]
      : []),
  ];
  writeFileSync(summaryMarkdownPathFor(rootDir), lines.join('\n') + '\n', 'utf8');
}

function loadSplitManifest(manifestPath: string): SplitManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as SplitManifest;
}

function loadSplitRunSummary(rootDir: string): SplitRunSummary {
  return JSON.parse(readFileSync(summaryPathFor(rootDir), 'utf8')) as SplitRunSummary;
}

function recomputePartCounts(summary: SplitRunSummary): SplitRunSummary {
  const completedParts = summary.partResults.filter((part) => part.status === 'completed').length;
  const failedParts = summary.partResults.filter((part) => part.status === 'failed').length;
  const skippedParts = summary.partResults.filter((part) => part.status === 'skipped').length;
  return {
    ...summary,
    completedParts,
    failedParts,
    skippedParts,
  };
}

function firstRecordValue<T>(record: Record<string, T> | undefined): T | undefined {
  if (!record) return undefined;
  const firstKey = Object.keys(record)[0];
  return firstKey ? record[firstKey] : undefined;
}

function readEffectiveMappingFromRun(runOutputDir: string): Record<string, string> | undefined {
  const path = join(runOutputDir, 'effective-mapping.json');
  if (!existsSync(path)) return undefined;
  const payload = JSON.parse(readFileSync(path, 'utf8')) as { mapping?: Record<string, string> };
  return payload.mapping && Object.keys(payload.mapping).length > 0 ? payload.mapping : undefined;
}

function ingestOptionsFromDiagnosis(diagnosis: CsvIngestDiagnosis | undefined): IngestOptions {
  if (!diagnosis) return {};
  return {
    encoding: diagnosis.appliedEncoding,
    delimiter: diagnosis.appliedDelimiter,
    csvQuoteMode: diagnosis.requestedQuoteMode,
    hasHeader: diagnosis.headerApplied,
  };
}

function splitPartIngestOptionsForReuse(
  manifest: SplitManifest,
  diagnosis: CsvIngestDiagnosis | undefined,
): IngestOptions {
  return {
    ...ingestOptionsFromDiagnosis(diagnosis),
    ...buildPartIngestOptionsFromManifest(manifest, {}),
  };
}

function originalSourceContextFromManifest(manifest: SplitManifest, sourceAbs: string): OriginalSourceContext {
  const seed = manifest.seed;
  const headerDecisionResolvedFrom: OriginalSourceContext['headerDecisionResolvedFrom'] =
    seed.headerDecisionResolvedFrom ?? 'unknown';
  return {
    filePath: sourceAbs,
    schemaFingerprint: manifest.schemaFingerprint,
    ...(seed.originalHeaderApplied !== undefined ? { originalHeaderApplied: seed.originalHeaderApplied } : {}),
    effectiveHasHeaderForPart: seed.partFilesIncludeHeaderRow ?? true,
    headerDecisionResolvedFrom,
    ...(seed.originalWeakHeaderDetected !== undefined
      ? { originalWeakHeaderDetected: seed.originalWeakHeaderDetected }
      : {}),
  };
}

function resolveReusableRun(
  rootDir: string,
  baseOutputDir: string,
  runId: string,
) {
  return getRun(rootDir, runId) ?? getRun(baseOutputDir, runId);
}

function readRunsForReusableSearch(rootDir: string, baseOutputDir: string) {
  const runs = [...listRuns(rootDir), ...listRuns(baseOutputDir)];
  const seen = new Set<string>();
  return runs.filter((run) => {
    if (seen.has(run.id)) return false;
    seen.add(run.id);
    return true;
  });
}

function isReusableCandidate(
  manifest: SplitManifest,
  run: RunMeta,
): boolean {
  if (run.status !== 'completed') return false;
  const firstPartPath = resolve(manifest.seed.firstPartPath);
  if (!run.inputFiles.map((file) => resolve(file)).includes(firstPartPath)) return false;
  const hasReusablePayload = Boolean(run.profileId) || Boolean(readEffectiveMappingFromRun(run.outputDir));
  if (!hasReusablePayload) return false;
  const schemaValues = Object.values(run.schemaFingerprints ?? {});
  if (schemaValues.length === 0) return false;
  return schemaValues.every((value) => value === manifest.seed.schemaFingerprint);
}

function findReusableRunCandidates(
  rootDir: string,
  baseOutputDir: string,
  manifest: SplitManifest,
): string[] {
  return readRunsForReusableSearch(rootDir, baseOutputDir)
    .filter((run) => isReusableCandidate(manifest, run))
    .map((run) => run.id)
    .sort();
}

function resolveReusableContext(
  rootDir: string,
  baseOutputDir: string,
  manifest: SplitManifest,
  explicitRunId?: string,
): { context: ReusableContext | null; candidateIds: string[] } {
  if (explicitRunId) {
    return {
      context: buildReusableContext(rootDir, baseOutputDir, explicitRunId, manifest),
      candidateIds: explicitRunId ? [explicitRunId] : [],
    };
  }

  if (manifest.seed.lastReusableRunId) {
    const remembered = buildReusableContext(rootDir, baseOutputDir, manifest.seed.lastReusableRunId, manifest);
    if (remembered) {
      return {
        context: remembered,
        candidateIds: [manifest.seed.lastReusableRunId],
      };
    }
  }

  const candidateIds = findReusableRunCandidates(rootDir, baseOutputDir, manifest);
  if (candidateIds.length !== 1) {
    return { context: null, candidateIds };
  }
  return {
    context: buildReusableContext(rootDir, baseOutputDir, candidateIds[0], manifest),
    candidateIds,
  };
}

function buildReusableContext(
  rootDir: string,
  baseOutputDir: string,
  runId: string,
  manifest: SplitManifest,
): ReusableContext | null {
  const run = resolveReusableRun(rootDir, baseOutputDir, runId);
  if (!run) return null;
  const profileId = run.profileId;
  const effectiveMapping = readEffectiveMappingFromRun(run.outputDir);
  const sourceRouting = firstRecordValue(run.sourceRouting);
  const diagnosis = firstRecordValue(run.ingestDiagnoses) as CsvIngestDiagnosis | undefined;
  const ingestOptions = splitPartIngestOptionsForReuse(manifest, diagnosis);

  if (!profileId && !effectiveMapping) {
    return null;
  }

  return {
    profileId,
    effectiveMapping,
    sourceRouting,
    ingestOptions,
    reusedFromRunId: runId,
  };
}

async function probeSchemaFingerprint(
  filePath: string,
  ingestOptions: IngestOptions,
): Promise<string> {
  const result = await ingestFile(filePath, {
    ...ingestOptions,
    debugContext: 'core:resumeSplitRun:probe',
  }, 1);
  return result.schemaFingerprint;
}

function initialPartResults(manifest: SplitManifest): SplitRunPartResult[] {
  return manifest.parts.map((part, index) => ({
    partIndex: part.partIndex,
    filePath: part.filePath,
    status: index === 0 ? 'skipped' : 'skipped',
    reason: 'awaiting_resume',
    schemaFingerprint: part.schemaFingerprint,
  }));
}

export async function startSplitRun(
  options: StartSplitRunOptions,
): Promise<SplitRunSummary> {
  const rootDir = resolve(options.outputDir ?? splitRunRootDir(options.config.outputDir, options.filePath));
  const partsDir = join(rootDir, 'parts');
  mkdirSync(partsDir, { recursive: true });

  const manifest = await splitCsvFile(options.filePath, {
    outputDir: partsDir,
    rowsPerPart: options.rowsPerPart,
    ingestOptions: options.ingestOptions,
  });
  const rootManifestPath = manifestPathFor(rootDir);
  const partIngestOptions = buildPartIngestOptionsFromManifest(manifest, options.ingestOptions);

  const partResults = initialPartResults(manifest);
  let stopReason: string | null = null;

  if (manifest.parts[0]) {
    const sourceAbs = resolve(options.filePath);
    const run = await executeRun(
      options.mode,
      [manifest.parts[0].filePath],
      { ...options.config, outputDir: rootDir },
      options.configPath,
      {
        ingestOptionsOverride: partIngestOptions,
        mappingLookupFilePathOverride: sourceAbs,
        originalSourceContext: originalSourceContextFromManifest(manifest, sourceAbs),
      },
    );
    partResults[0] = {
      partIndex: manifest.parts[0].partIndex,
      filePath: manifest.parts[0].filePath,
      runId: run.id,
      status: 'completed',
      schemaFingerprint: manifest.parts[0].schemaFingerprint,
      normalizedCount: run.summary?.normalizedCount,
      quarantineCount: run.summary?.quarantineCount,
      parseFailCount: run.summary?.parseFailCount,
    };
    stopReason = 'awaiting_resume';
    manifest.seed.initialPartRunId = run.id;
  }

  const updatedManifest = updateSplitManifestStage(manifest, 'part1_completed');
  saveSplitManifest(rootManifestPath, updatedManifest);

  const summary = recomputePartCounts({
    version: 1,
    mode: options.mode,
    sourceFile: resolve(options.filePath),
    splitManifestPath: rootManifestPath,
    generatedAt: new Date().toISOString(),
    stage: 'part1_completed',
    totalParts: manifest.totalParts,
    completedParts: 0,
    failedParts: 0,
    skippedParts: 0,
    stopReason,
    reusedEffectiveMapping: false,
    reusedSourceRouting: false,
    schemaFingerprintMatchedAllParts: true,
    schemaFingerprint: manifest.schemaFingerprint,
    partResults,
    totals: {
      normalizedCount: partResults[0]?.normalizedCount ?? 0,
      quarantineCount: partResults[0]?.quarantineCount ?? 0,
      parseFailCount: partResults[0]?.parseFailCount ?? 0,
    },
  });
  saveSplitRunSummary(rootDir, summary);
  return summary;
}

export async function resumeSplitRun(
  options: ResumeSplitRunOptions,
): Promise<SplitRunSummary> {
  const manifestPath = resolve(options.manifestPath);
  const rootDir = dirname(manifestPath);
  const manifest = loadSplitManifest(manifestPath);
  let summary = loadSplitRunSummary(rootDir);
  const reuseRunId = options.reuseRunId;
  const resolvedReusable = resolveReusableContext(rootDir, options.config.outputDir, manifest, reuseRunId);
  const reusableContext = resolvedReusable.context;

  if (!reusableContext) {
    const stopReason = resolvedReusable.candidateIds.length > 1
      ? 'ambiguous_reusable_context'
      : 'reusable_context_missing';
    summary = recomputePartCounts({
      ...summary,
      stage: 'stopped',
      stopReason,
      reusableRunCandidateIds: resolvedReusable.candidateIds,
      schemaFingerprintMatchedAllParts: false,
    });
    saveSplitRunSummary(rootDir, summary);
    return summary;
  }

  const runConfig = { ...options.config, outputDir: rootDir };
  let schemaFingerprintMatchedAllParts = true;

  for (let index = 1; index < manifest.parts.length; index++) {
    const part = manifest.parts[index]!;
    const currentFingerprint = await probeSchemaFingerprint(part.filePath, reusableContext.ingestOptions);
    if (currentFingerprint !== manifest.schemaFingerprint) {
      summary = recomputePartCounts({
        ...summary,
        stage: 'stopped',
        stopReason: 'schema_changed',
        stoppedAtPartIndex: part.partIndex,
        reusedProfileId: reusableContext.profileId,
        reusedEffectiveMapping: reusableContext.effectiveMapping !== undefined,
        reusedSourceRouting: reusableContext.sourceRouting !== undefined,
        reusedFromRunId: reusableContext.reusedFromRunId,
        schemaFingerprintMatchedAllParts: false,
      reusableRunCandidateIds: [reusableContext.reusedFromRunId],
      });
      schemaFingerprintMatchedAllParts = false;
      break;
    }

    const manifestSourceAbs = resolve(manifest.sourceFile);
    const run = await executeRun(
      summary.mode as RunMode,
      [part.filePath],
      runConfig,
      options.configPath,
      {
        profileId: reusableContext.profileId,
        effectiveMapping: reusableContext.effectiveMapping,
        sourceRoutingOverride: reusableContext.sourceRouting,
        ingestOptionsOverride: reusableContext.ingestOptions,
        mappingLookupFilePathOverride: manifestSourceAbs,
        originalSourceContext: originalSourceContextFromManifest(manifest, manifestSourceAbs),
      },
    );
    summary.partResults[index] = {
      partIndex: part.partIndex,
      filePath: part.filePath,
      runId: run.id,
      status: 'completed',
      schemaFingerprint: currentFingerprint,
      normalizedCount: run.summary?.normalizedCount,
      quarantineCount: run.summary?.quarantineCount,
      parseFailCount: run.summary?.parseFailCount,
    };
    summary.totals.normalizedCount += run.summary?.normalizedCount ?? 0;
    summary.totals.quarantineCount += run.summary?.quarantineCount ?? 0;
    summary.totals.parseFailCount += run.summary?.parseFailCount ?? 0;
  }

  if (schemaFingerprintMatchedAllParts) {
    summary = {
      ...summary,
      stage: 'resume_completed',
      stopReason: null,
      reusedProfileId: reusableContext.profileId,
      reusedEffectiveMapping: reusableContext.effectiveMapping !== undefined,
      reusedSourceRouting: reusableContext.sourceRouting !== undefined,
      reusedFromRunId: reusableContext.reusedFromRunId,
      reusableRunCandidateIds: [reusableContext.reusedFromRunId],
      schemaFingerprintMatchedAllParts: true,
    };
    manifest.seed.lastReusableRunId = reusableContext.reusedFromRunId;
    saveSplitManifest(manifestPath, updateSplitManifestStage(manifest, 'resume_completed'));
  }

  summary = recomputePartCounts(summary);
  saveSplitRunSummary(rootDir, summary);
  return summary;
}
