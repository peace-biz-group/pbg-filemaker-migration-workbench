/**
 * Candidate Profile — 列レビューから自動生成した「仮のファイル設定」。
 *
 * - seed profile を直接上書きしない
 * - dataDir/candidate-profiles/{id}.json に保存
 * - provisional: true, candidate: true で明示
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { FileProfile, ColumnDef, CandidateProfile } from './types.js';
import type { EffectiveMappingResult } from '../core/effective-mapping.js';

// --- Type Guard ---

export function isCandidateProfile(profile: FileProfile): profile is CandidateProfile {
  return (profile as CandidateProfile).candidate === true;
}

// --- Build ---

/**
 * 列レビュー結果（effective mapping）から candidate profile を生成する。
 *
 * @param runId - 生成元 run ID
 * @param sourceFilename - アップロード元のファイル名（basename のみ）
 * @param em - 保存済み effective mapping
 * @param overrides - UI から渡す上書き値（label, defaultEncoding, defaultHasHeader, headerlessSuitable）
 */
export function buildCandidateProfile(
  runId: string,
  sourceFilename: string,
  em: EffectiveMappingResult,
  overrides: {
    label?: string;
    defaultEncoding?: 'cp932' | 'utf8' | 'auto';
    defaultHasHeader?: boolean;
    headerlessSuitable?: boolean;
  },
): CandidateProfile {
  const stem = basename(sourceFilename, extname(sourceFilename));

  // ID は runId + profileId から決定論的に生成（重複保存を防ぐ）
  const id = `candidate-${runId}-${em.profileId}`;

  // ファイル名ヒント: stem ベースの glob パターン
  const filenameHints = [`${stem}*`, `*${stem}*`];

  // 全列を ColumnDef に変換（active/unused/pending すべて含める）
  // ヘッダーヒントに sourceHeader を登録することでマッチング精度を上げる
  const columns: ColumnDef[] = em.columns.map(col => ({
    position: col.position,
    label: col.label,
    key: col.canonicalKey,
    required: col.required === 'yes',
    headerHints: [col.sourceHeader],
  }));

  // previewColumns: active 列の position 先頭4件
  const previewColumns = em.columns
    .filter(c => c.status === 'active')
    .slice(0, 4)
    .map(c => c.position);

  const label = overrides.label || stem;
  const resolvedDefaultHasHeader = overrides.defaultHasHeader ?? true;

  // defaultHasHeader: false の場合は headerlessSuitable を自動で true にする
  // 明示的に指定されている場合はそちらを優先する
  const resolvedHeaderlessSuitable =
    overrides.headerlessSuitable !== undefined
      ? overrides.headerlessSuitable
      : resolvedDefaultHasHeader === false
        ? true
        : undefined;

  return {
    id,
    label,
    filenameHints,
    defaultEncoding: overrides.defaultEncoding ?? 'auto',
    defaultHasHeader: resolvedDefaultHasHeader,
    columns,
    previewColumns,
    category: '生成された設定',
    provisional: true,
    candidate: true,
    generatedFromRunId: runId,
    generatedAt: new Date().toISOString(),
    sourceFilename,
    // ヘッダーなし CSV とのマッチング精度向上のため列数を記録
    columnCount: em.columns.length,
    // ヘッダーなし適合フラグ（undefined の場合は省略）
    ...(resolvedHeaderlessSuitable !== undefined && { headerlessSuitable: resolvedHeaderlessSuitable }),
  };
}

// --- Persistence ---

function getCandidateDir(dataDir: string): string {
  return join(dataDir, 'candidate-profiles');
}

/** candidate profile を JSON ファイルとして保存する */
export function saveCandidateProfile(dataDir: string, profile: CandidateProfile): void {
  const dir = getCandidateDir(dataDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${profile.id}.json`),
    JSON.stringify(profile, null, 2),
    'utf-8',
  );
}

/** dataDir/candidate-profiles/ から全 candidate profile を読み込む */
export function loadAllCandidateProfiles(dataDir: string): CandidateProfile[] {
  const dir = getCandidateDir(dataDir);
  if (!existsSync(dir)) return [];

  const results: CandidateProfile[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      if (data.candidate === true) {
        results.push(data as CandidateProfile);
      }
    } catch {
      // 壊れたファイルはスキップ
    }
  }
  return results;
}
