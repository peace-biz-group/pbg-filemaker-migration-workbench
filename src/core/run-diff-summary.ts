/**
 * Run Diff Summary v1
 * 前回 run との軽量差分 summary を生成する。
 * 全件 row diff は行わない。metadata と保存済み artifact の比較のみ。
 */

import { join, basename } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { RunDiffSummaryV1, DiffClassification } from '../types/index.js';
import type { RunMeta } from './pipeline-runner.js';
import { listRuns, getRun } from './pipeline-runner.js';
import { findEffectiveMappings } from './effective-mapping.js';

export type { RunDiffSummaryV1, DiffClassification };

/**
 * 現在 run に対して比較可能な直近 run を 1 件返す。
 * 優先順位:
 *   1. logicalSourceKey 一致 AND profileId 一致
 *   2. logicalSourceKey 一致（fallback）
 * どちらも見つからなければ null。
 */
export function findComparableRun(outputDir: string, currentMeta: RunMeta): RunMeta | null {
  const lsk = currentMeta.logicalSourceKey;
  if (!lsk) return null;

  const allRuns = listRuns(outputDir).filter(
    r => r.id !== currentMeta.id && r.status === 'completed' && r.logicalSourceKey === lsk,
  );
  if (allRuns.length === 0) return null;

  // profileId 一致を優先（built-in / candidate どちらの profileId も考慮）
  const pid = currentMeta.profileId ?? currentMeta.fastPathProfileId;
  if (pid) {
    const withProfile = allRuns.find(
      r => (r.profileId ?? r.fastPathProfileId) === pid,
    );
    if (withProfile) return withProfile;
  }

  // fallback: logicalSourceKey が一致する最新の run
  return allRuns[0] ?? null;
}

function getSchemaFingerprintValues(meta: RunMeta): string[] {
  return Object.values(meta.schemaFingerprints ?? {}).sort();
}

function getRawFingerprintValues(meta: RunMeta): string[] {
  return Object.values(meta.sourceFileHashes ?? {}).sort();
}

function getAllColumns(meta: RunMeta): string[] {
  const cols = meta.inputColumns ?? {};
  const seen = new Set<string>();
  for (const colList of Object.values(cols)) {
    for (const c of colList) seen.add(c);
  }
  return [...seen].sort();
}

function getFirstHeaderApplied(meta: RunMeta): boolean | undefined {
  const diags = meta.ingestDiagnoses ?? {};
  const first = Object.values(diags)[0];
  if (!first) return undefined;
  return first.headerApplied;
}

function getSourceFilenames(meta: RunMeta): string[] {
  return meta.inputFiles.map(f => basename(f));
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function classificationLabel(c: DiffClassification): string {
  switch (c) {
    case 'same_content': return '前回と同じ内容';
    case 'row_count_changed': return '件数が変わった';
    case 'schema_changed': return '列の構成が変わった';
    case 'profile_changed': return '設定が変わった';
    case 'no_comparable': return '比較対象なし';
  }
}

function classify(
  sameRaw: boolean,
  sameSchema: boolean,
  sameProfile: boolean,
  sameMapping: boolean,
  rowDelta: number,
): DiffClassification {
  if (sameRaw) return 'same_content';
  if (!sameSchema) return 'schema_changed';
  if (!sameProfile || !sameMapping) return 'profile_changed';
  if (rowDelta !== 0) return 'row_count_changed';
  return 'same_content';
}

/**
 * 現在 run に対して RunDiffSummaryV1 を生成する。
 * comparable run が見つからない場合は null を返す。
 */
export function buildRunDiffSummaryV1(
  outputDir: string,
  currentMeta: RunMeta,
): RunDiffSummaryV1 | null {
  const prevMeta = currentMeta.previousRunId
    ? getRun(outputDir, currentMeta.previousRunId)
    : findComparableRun(outputDir, currentMeta);

  if (!prevMeta) return null;

  const currS = currentMeta.summary;
  const prevS = prevMeta.summary;

  const rowCountCurr = currS?.recordCount ?? 0;
  const rowCountPrev = prevS?.recordCount ?? 0;
  const columnCountCurr = currS?.columnCount ?? 0;
  const columnCountPrev = prevS?.columnCount ?? 0;

  const sameRawFingerprint = arraysEqual(
    getRawFingerprintValues(prevMeta),
    getRawFingerprintValues(currentMeta),
  );
  const sameSchemaFingerprint = arraysEqual(
    getSchemaFingerprintValues(prevMeta),
    getSchemaFingerprintValues(currentMeta),
  );

  const currPid = currentMeta.profileId ?? currentMeta.fastPathProfileId;
  const prevPid = prevMeta.profileId ?? prevMeta.fastPathProfileId;
  const sameProfile =
    currPid !== undefined && prevPid !== undefined && currPid === prevPid;

  // effective mapping 比較（best-effort: どちらかがなければ false）
  let sameEffectiveMapping = false;
  if (currPid && prevPid && currPid === prevPid) {
    const currMappings = findEffectiveMappings(outputDir, currentMeta.id);
    const prevMappings = findEffectiveMappings(outputDir, prevMeta.id);
    const currM = currMappings.find(m => m.profileId === currPid);
    const prevM = prevMappings.find(m => m.profileId === prevPid);
    if (currM && prevM) {
      sameEffectiveMapping =
        JSON.stringify(currM.mapping) === JSON.stringify(prevM.mapping);
    }
  }

  // columns diff（inputColumns が両方にある場合のみ）
  const currCols = getAllColumns(currentMeta);
  const prevCols = getAllColumns(prevMeta);
  const addedColumns = currCols.filter(c => !prevCols.includes(c));
  const removedColumns = prevCols.filter(c => !currCols.includes(c));

  const rowDelta = rowCountCurr - rowCountPrev;

  const classification = classify(
    sameRawFingerprint,
    sameSchemaFingerprint,
    sameProfile,
    sameEffectiveMapping,
    rowDelta,
  );

  return {
    version: 1,
    previousRunId: prevMeta.id,
    currentRunId: currentMeta.id,
    logicalSourceKey: currentMeta.logicalSourceKey ?? '',
    totals: {
      recordCountDelta: rowDelta,
      normalizedCountDelta: (currS?.normalizedCount ?? 0) - (prevS?.normalizedCount ?? 0),
      quarantineCountDelta: (currS?.quarantineCount ?? 0) - (prevS?.quarantineCount ?? 0),
      parseFailDelta: (currS?.parseFailCount ?? 0) - (prevS?.parseFailCount ?? 0),
    },
    profileId: currPid,
    sameProfile,
    sameSchemaFingerprint,
    sameRawFingerprint,
    sameEffectiveMapping,
    rowCountPrev,
    rowCountCurr,
    columnCountPrev,
    columnCountCurr,
    hasHeaderPrev: getFirstHeaderApplied(prevMeta),
    hasHeaderCurr: getFirstHeaderApplied(currentMeta),
    sourceFilenamesPrev: getSourceFilenames(prevMeta),
    sourceFilenamesCurr: getSourceFilenames(currentMeta),
    addedColumns,
    removedColumns,
    classification,
    classificationLabel: classificationLabel(classification),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * run-diff.json に保存する。
 */
export function saveRunDiffSummary(runDir: string, summary: RunDiffSummaryV1): void {
  writeFileSync(
    join(runDir, 'run-diff.json'),
    JSON.stringify(summary, null, 2),
    'utf-8',
  );
}
