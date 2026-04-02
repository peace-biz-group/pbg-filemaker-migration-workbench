import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export type SourceMode = 'mainline' | 'archive';

export interface SourceBatchRecord {
  source_batch_id: string;
  file_path: string;
  file_name: string;
  file_label: string;
  file_size: number;
  file_sha256: string;
  imported_at: string;
  mode: SourceMode;
  config_hash: string;
  source_type?: string;
  notes?: string;
}

export interface MergeSummary {
  inserted: number;
  updated: number;
  unchanged: number;
  duplicate: number;
  skipped_archive: number;
  warnings: string[];
}

export interface ImportRunRecord {
  import_run_id: string;
  started_at: string;
  finished_at?: string;
  command: string;
  source_batch_ids: string[];
  output_dir: string;
  status: 'running' | 'completed' | 'failed';
  summary: MergeSummary;
  error_message?: string;
}

export interface MergeLedgerEntry {
  ledger_key: string;
  row_fingerprint: string;
  diff_key: string;
  source_key: string;
  source_file: string;
  source_batch_id: string;
  updated_at?: string;
  last_import_run_id: string;
  last_seen_at: string;
}

interface PersistentState {
  version: 1;
  source_batches: SourceBatchRecord[];
  import_runs: ImportRunRecord[];
  merge_ledger: Record<string, MergeLedgerEntry>;
}

const DEFAULT_STATE: PersistentState = {
  version: 1,
  source_batches: [],
  import_runs: [],
  merge_ledger: {},
};

export function defaultStatePath(outputDir: string): string {
  return join(outputDir, '.state', 'workbench-state.json');
}

export function readState(statePath: string): PersistentState {
  if (!existsSync(statePath)) return { ...DEFAULT_STATE };
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as Partial<PersistentState>;
    return {
      version: 1,
      source_batches: parsed.source_batches ?? [],
      import_runs: parsed.import_runs ?? [],
      merge_ledger: parsed.merge_ledger ?? {},
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeState(statePath: string, state: PersistentState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function computeConfigHash(config: unknown): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

export function makeSourceBatchId(args: {
  filePath: string;
  sha256: string;
  mode: SourceMode;
  configHash: string;
}): string {
  const seed = `${resolve(args.filePath)}\0${args.sha256}\0${args.mode}\0${args.configHash}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

export function resolveSourceBatch(
  state: PersistentState,
  args: {
    filePath: string;
    fileLabel?: string;
    fileSize: number;
    sha256: string;
    mode: SourceMode;
    configHash: string;
    sourceType?: string;
    notes?: string;
    importedAt: string;
  },
): SourceBatchRecord {
  const filePath = resolve(args.filePath);
  const source_batch_id = makeSourceBatchId({ filePath, sha256: args.sha256, mode: args.mode, configHash: args.configHash });
  const existing = state.source_batches.find((b) => b.source_batch_id === source_batch_id);
  if (existing) return existing;

  const created: SourceBatchRecord = {
    source_batch_id,
    file_path: filePath,
    file_name: basename(filePath),
    file_label: args.fileLabel ?? basename(filePath),
    file_size: args.fileSize,
    file_sha256: args.sha256,
    imported_at: args.importedAt,
    mode: args.mode,
    config_hash: args.configHash,
    ...(args.sourceType ? { source_type: args.sourceType } : {}),
    ...(args.notes ? { notes: args.notes } : {}),
  };
  state.source_batches.push(created);
  return created;
}

export function startImportRun(
  state: PersistentState,
  args: { runId: string; command: string; sourceBatchIds: string[]; outputDir: string; startedAt: string },
): ImportRunRecord {
  const run: ImportRunRecord = {
    import_run_id: args.runId,
    started_at: args.startedAt,
    command: args.command,
    source_batch_ids: args.sourceBatchIds,
    output_dir: resolve(args.outputDir),
    status: 'running',
    summary: { inserted: 0, updated: 0, unchanged: 0, duplicate: 0, skipped_archive: 0, warnings: [] },
  };
  state.import_runs = state.import_runs.filter((r) => r.import_run_id !== run.import_run_id);
  state.import_runs.push(run);
  return run;
}

export function finishImportRun(
  state: PersistentState,
  runId: string,
  args: { finishedAt: string; status: 'completed' | 'failed'; summary: MergeSummary; errorMessage?: string },
): ImportRunRecord | null {
  const run = state.import_runs.find((r) => r.import_run_id === runId);
  if (!run) return null;
  run.finished_at = args.finishedAt;
  run.status = args.status;
  run.summary = args.summary;
  run.error_message = args.errorMessage;
  return run;
}

export function stateForRun(statePath: string, runId: string): { sourceBatches: SourceBatchRecord[]; importRun: ImportRunRecord | null } {
  const state = readState(statePath);
  const importRun = state.import_runs.find((r) => r.import_run_id === runId) ?? null;
  const ids = new Set(importRun?.source_batch_ids ?? []);
  return {
    sourceBatches: state.source_batches.filter((b) => ids.has(b.source_batch_id)),
    importRun,
  };
}
