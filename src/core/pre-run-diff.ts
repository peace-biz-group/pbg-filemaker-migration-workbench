/**
 * Pre-Run Diff Preview
 *
 * 実行前（confirm 段階）に取れる metadata だけで、
 * 直近の comparable run との軽量比較を行う。
 * 全件 row diff は行わない。
 */

import { basename } from 'node:path';
import type { RunMeta } from './pipeline-runner.js';
import { listRuns } from './pipeline-runner.js';
import { logicalSourceKey } from '../ingest/fingerprint.js';

export type PreRunClassification =
  | 'same_file'       // 前回とほぼ同じです
  | 'row_changed'     // 件数が変わっています
  | 'column_changed'  // 列の形が変わっています
  | 'first_import'    // 初めての取り込みです
  | 'no_comparable';  // 比較対象なし（ファイル名ヒントなし等）

export interface PreRunDiffPreview {
  version: 1;
  previousRunId: string | null;
  profileId: string | null;
  sameRawFingerprint: boolean | null;
  sameSchemaFingerprint: boolean | null;
  columnCountPrev: number | null;
  columnCountCurr: number;
  columnCountDelta: number | null;
  rowCountPrev: number | null;
  hasHeaderPrev: boolean | null;
  hasHeaderCurr: boolean | null;
  classification: PreRunClassification;
  classificationLabel: string;
  fastPathRecommended: boolean;
  columnReviewRecommended: boolean;
}

export interface PreRunInput {
  filename: string;
  sourceFileHash?: string;
  schemaFingerprint?: string;
  columnCount: number;
  hasHeader?: boolean;
  profileId?: string;
}

const CLASSIFICATION_LABELS: Record<PreRunClassification, string> = {
  same_file: '前回とほぼ同じです',
  row_changed: '件数が変わっています',
  column_changed: '列の形が変わっています',
  first_import: '初めての取り込みです',
  no_comparable: '比較対象なし',
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

export function buildPreRunDiffPreview(
  outputDir: string,
  input: PreRunInput,
): PreRunDiffPreview {
  const lsk = logicalSourceKey([basename(input.filename)]);
  const pid = input.profileId ?? null;

  const allCompleted = listRuns(outputDir).filter(
    r => r.status === 'completed' && r.logicalSourceKey === lsk,
  );

  let prevRun: RunMeta | null = null;
  if (pid && allCompleted.length > 0) {
    prevRun =
      allCompleted.find(r => (r.profileId ?? r.fastPathProfileId) === pid) ??
      allCompleted[0] ??
      null;
  } else {
    prevRun = allCompleted[0] ?? null;
  }

  if (!prevRun) {
    return {
      version: 1,
      previousRunId: null,
      profileId: pid,
      sameRawFingerprint: null,
      sameSchemaFingerprint: null,
      columnCountPrev: null,
      columnCountCurr: input.columnCount,
      columnCountDelta: null,
      rowCountPrev: null,
      hasHeaderPrev: null,
      hasHeaderCurr: input.hasHeader ?? null,
      classification: 'first_import',
      classificationLabel: CLASSIFICATION_LABELS['first_import'],
      fastPathRecommended: false,
      columnReviewRecommended: false,
    };
  }

  let sameRawFingerprint: boolean | null = null;
  if (input.sourceFileHash && prevRun.sourceFileHashes) {
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

  const prevDiags = prevRun.ingestDiagnoses ?? {};
  const firstPrevDiag = Object.values(prevDiags)[0];
  const hasHeaderPrev = firstPrevDiag?.headerApplied ?? null;

  const classification = classifyPreRun({
    hasPrevRun: true,
    sameRawFingerprint,
    sameSchemaFingerprint,
    columnDelta: columnCountDelta,
  });

  const fastPathRecommended = classification === 'same_file' && pid !== null;
  const columnReviewRecommended = classification === 'column_changed';

  return {
    version: 1,
    previousRunId: prevRun.id,
    profileId: pid,
    sameRawFingerprint,
    sameSchemaFingerprint,
    columnCountPrev,
    columnCountCurr: input.columnCount,
    columnCountDelta,
    rowCountPrev,
    hasHeaderPrev,
    hasHeaderCurr: input.hasHeader ?? null,
    classification,
    classificationLabel: CLASSIFICATION_LABELS[classification],
    fastPathRecommended,
    columnReviewRecommended,
  };
}
