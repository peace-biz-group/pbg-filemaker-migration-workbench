/**
 * Pre-Run Diff Preview
 *
 * 実行前（confirm 段階）に取れる metadata だけで、
 * 直近の comparable run との軽量比較を行う。
 * 全件 row diff は行わない。
 */

import { basename } from 'node:path';
import { listRuns, getRun } from './pipeline-runner.js';
import { logicalSourceKey } from '../ingest/fingerprint.js';

export type PreRunClassification =
  | 'same_file'       // 前回とほぼ同じです
  | 'row_changed'     // 件数が変わっています
  | 'column_changed'  // 列の形が変わっています
  | 'first_import';   // 初めての取り込みです（comparable なしも含む）

export interface PreRunDiffPreview {
  version: 1;
  /** 比較対象 run の ID。比較対象なし / 初回の場合は null */
  previousRunId: string | null;
  /** 同じ raw ファイルか（sourceFileHash の一致）。不明なら null */
  sameRawFingerprint: boolean | null;
  /** 同じスキーマか（schemaFingerprint の一致）。不明なら null */
  sameSchemaFingerprint: boolean | null;
  /** 前回の列数。不明なら null */
  columnCountPrev: number | null;
  /** 今回の列数 */
  columnCountCurr: number;
  /** 列数の差。不明なら null */
  columnCountDelta: number | null;
  /** 前回の行数。不明なら null */
  rowCountPrev: number | null;
  /** 分類（内部用） */
  classification: PreRunClassification;
  /** 現場向け日本語ラベル */
  classificationLabel: string;
  /**
   * 重複再投入の可能性があるか。
   * sameRawFingerprint === true のときだけ true になる。
   * 自動ブロックには使わず、UI での確認促進に使う。
   */
  duplicateWarning: boolean;
  /**
   * 列の形が変わっている可能性があるか。
   * classification === 'column_changed' のときだけ true になる。
   * fast path 抑制・confirm 画面での列確認誘導に使う。
   * 自動ブロックには使わず、UI での確認促進に使う。
   */
  schemaDriftGuard: boolean;
}

export interface PreRunInput {
  /** アップロードされたファイルの名前（basename） */
  filename: string;
  /** raw ファイルハッシュ（任意） */
  sourceFileHash?: string;
  /** スキーマフィンガープリント（任意） */
  schemaFingerprint?: string;
  /** 検出された列数 */
  columnCount: number;
}

const CLASSIFICATION_LABELS: Record<PreRunClassification, string> = {
  same_file: '前回とほぼ同じです',
  row_changed: '件数が変わっています',
  column_changed: '列の形が変わっています',
  first_import: '初めての取り込みです',
};

function classifyPreRun(opts: {
  hasPrevRun: boolean;
  sameRawFingerprint: boolean | null;
  sameSchemaFingerprint: boolean | null;
  columnDelta: number | null;
}): PreRunClassification {
  if (!opts.hasPrevRun) return 'first_import';
  if (opts.sameRawFingerprint === true) return 'same_file';
  if (opts.columnDelta !== null && opts.columnDelta !== 0) return 'column_changed';
  if (opts.sameSchemaFingerprint === false) return 'column_changed';
  return 'row_changed';
}

/**
 * 実行前に comparable run を探し、PreRunDiffPreview を生成する。
 * comparable run が見つからない場合は first_import を返す。
 */
export function buildPreRunDiffPreview(
  outputDir: string,
  input: PreRunInput,
): PreRunDiffPreview {
  const lsk = logicalSourceKey([basename(input.filename)]);

  const allCompleted = listRuns(outputDir)
    .filter(r => r.status === 'completed' && r.logicalSourceKey === lsk)
    .sort((a, b) => {
      const ta = a.completedAt ?? a.startedAt ?? '';
      const tb = b.completedAt ?? b.startedAt ?? '';
      return tb.localeCompare(ta);
    });

  const prevRun = allCompleted[0] ?? null;

  if (!prevRun) {
    return {
      version: 1,
      previousRunId: null,
      sameRawFingerprint: null,
      sameSchemaFingerprint: null,
      columnCountPrev: null,
      columnCountCurr: input.columnCount,
      columnCountDelta: null,
      rowCountPrev: null,
      classification: 'first_import',
      classificationLabel: CLASSIFICATION_LABELS['first_import'],
      duplicateWarning: false,
      schemaDriftGuard: false,
    };
  }

  let sameRawFingerprint: boolean | null = null;
  if (input.sourceFileHash && prevRun.sourceFileHashes) {
    // Note: multi-file runs で異なるファイルのハッシュと一致する可能性があるが、
    // 現在のワークフローは単一ファイル前提のため許容する
    const prevHashes = Object.values(prevRun.sourceFileHashes);
    sameRawFingerprint = prevHashes.includes(input.sourceFileHash);
  }

  let sameSchemaFingerprint: boolean | null = null;
  if (input.schemaFingerprint && prevRun.schemaFingerprints) {
    const prevSchemas = Object.values(prevRun.schemaFingerprints);
    sameSchemaFingerprint = prevSchemas.includes(input.schemaFingerprint);
  }

  const columnCountPrev = prevRun.summary?.columnCount ?? null;
  const columnCountDelta =
    columnCountPrev !== null ? input.columnCount - columnCountPrev : null;
  const rowCountPrev = prevRun.summary?.recordCount ?? null;

  const classification = classifyPreRun({
    hasPrevRun: true,
    sameRawFingerprint,
    sameSchemaFingerprint,
    columnDelta: columnCountDelta,
  });

  return {
    version: 1,
    previousRunId: prevRun.id,
    sameRawFingerprint,
    sameSchemaFingerprint,
    columnCountPrev,
    columnCountCurr: input.columnCount,
    columnCountDelta,
    rowCountPrev,
    classification,
    classificationLabel: CLASSIFICATION_LABELS[classification],
    duplicateWarning: sameRawFingerprint === true,
    schemaDriftGuard: classification === 'column_changed',
  };
}

/**
 * columns 画面向けの drift context。
 * comparable previous run がある場合だけ生成する。
 * previousRunId がない場合は null を返す。
 */
export interface ColumnsDriftContext {
  version: 1;
  /** 比較対象の前回 run ID */
  previousRunId: string;
  /** 前回の列名一覧。run-meta に columnNames がない場合は null */
  previousColumnNames: string[] | null;
  /** 今回の列名一覧 */
  currentColumnNames: string[];
  /** 今回増えた列（previous にはなく current にある） */
  addedColumns: string[];
  /** 前回あったが今回ない列 */
  removedColumns: string[];
  /** run meta に schemaDriftWarningShown=true が記録されているか */
  schemaDriftWarningShown: boolean;
}

/**
 * 指定 runId の columns 画面向け drift context を生成する。
 *
 * - previousRunId がない（初回 import） → null を返す
 * - previousRunId があるが columnNames が両方取れない → addedColumns / removedColumns は空
 * - 軽量判定のみ（row diff なし）
 */
export function buildColumnsDriftContext(
  outputDir: string,
  runId: string,
): ColumnsDriftContext | null {
  const meta = getRun(outputDir, runId);
  if (!meta || !meta.previousRunId) return null;

  const prevMeta = getRun(outputDir, meta.previousRunId);
  if (!prevMeta) return null;

  const currentColumnNames = meta.columnNames ?? [];
  const previousColumnNames = prevMeta.columnNames ?? null;

  let addedColumns: string[] = [];
  let removedColumns: string[] = [];

  if (previousColumnNames !== null && currentColumnNames.length > 0) {
    const prevSet = new Set(previousColumnNames);
    const currSet = new Set(currentColumnNames);
    addedColumns = currentColumnNames.filter(c => !prevSet.has(c));
    removedColumns = previousColumnNames.filter(c => !currSet.has(c));
  }

  return {
    version: 1,
    previousRunId: meta.previousRunId,
    previousColumnNames,
    currentColumnNames,
    addedColumns,
    removedColumns,
    schemaDriftWarningShown: meta.schemaDriftWarningShown ?? false,
  };
}
