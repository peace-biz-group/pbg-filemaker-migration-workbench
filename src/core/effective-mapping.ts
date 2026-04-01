/**
 * Effective Mapping — 列レビュー回答から run 単位の実効 mapping を生成する。
 *
 * - profile の seed 定義は source of truth として残す
 * - 列レビュー結果で run ごとに補正できる構造
 * - profile 本体は変更しない（run-scoped only）
 * - fail-closed: unknown は canonical に昇格させない
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ColumnReviewEntry, ColumnDef } from '../file-profiles/types.js';

// --- Types ---

export interface EffectiveMappingColumn {
  position: number;
  /** 実際の CSV 列ヘッダー名 */
  sourceHeader: string;
  /** 正規化後の内部キー名 */
  canonicalKey: string;
  /** 表示用日本語ラベル */
  label: string;
  /**
   * active  = inUse=yes → mapping に含める
   * unused  = inUse=no  → mapping 対象外
   * pending = inUse=unknown → fail-closed、mapping 対象外
   */
  status: 'active' | 'unused' | 'pending';
  required: 'yes' | 'no' | 'unknown';
}

export interface EffectiveMappingResult {
  runId: string;
  profileId: string;
  generatedAt: string;
  /**
   * 実効 mapping: sourceHeader → canonicalKey
   * inUse=yes の列のみ含む
   */
  mapping: Record<string, string>;
  activeCount: number;
  unusedCount: number;
  pendingCount: number;
  columns: EffectiveMappingColumn[];
}

// --- Core logic ---

/**
 * 列レビュー回答から run 単位の実効 mapping を生成する。
 *
 * known file (profileDef あり):
 *   - profile の ColumnDef がベース (position → key)
 *   - review で意味・inUse・required を補正
 *
 * new file (profileDef なし):
 *   - review.label (CSVヘッダー) → review.key (ユーザー入力 or ヘッダーそのまま) で mapping
 *
 * ルール:
 *   - inUse=yes  → mapping[sourceHeader] = canonicalKey
 *   - inUse=no   → 除外 (status=unused)
 *   - inUse=unknown → 除外 (status=pending, fail-closed)
 */
export function buildEffectiveMapping(
  runId: string,
  profileId: string,
  reviews: ColumnReviewEntry[],
  profileDef?: ColumnDef[] | null,
): EffectiveMappingResult {
  const mapping: Record<string, string> = {};
  const columns: EffectiveMappingColumn[] = [];

  for (const review of reviews) {
    const profileCol = profileDef?.find(c => c.position === review.position) ?? null;

    // sourceHeader: 実際の CSV 列名（review.label に保存されている）
    const sourceHeader = review.label;

    // canonicalKey: profile の key または review.key（ユーザー上書き可）
    // review.key が空の場合は sourceHeader をそのまま使う（passthrough）
    const canonicalKey = review.key || profileCol?.key || sourceHeader;

    // label: ユーザーが入力した意味 > profile のラベル > ヘッダー名
    const label = review.meaning || profileCol?.label || sourceHeader;

    let status: 'active' | 'unused' | 'pending';
    if (review.inUse === 'yes') {
      status = 'active';
      mapping[sourceHeader] = canonicalKey;
    } else if (review.inUse === 'no') {
      status = 'unused';
      // mapping 対象外 — CSV には残るが rename しない
    } else {
      // unknown → fail-closed: pending のまま canonical に昇格させない
      status = 'pending';
    }

    columns.push({
      position: review.position,
      sourceHeader,
      canonicalKey,
      label,
      status,
      required: review.required,
    });
  }

  // position 順にソート
  columns.sort((a, b) => a.position - b.position);

  return {
    runId,
    profileId,
    generatedAt: new Date().toISOString(),
    mapping,
    activeCount: columns.filter(c => c.status === 'active').length,
    unusedCount: columns.filter(c => c.status === 'unused').length,
    pendingCount: columns.filter(c => c.status === 'pending').length,
    columns,
  };
}

// --- Persistence ---

function getEffectiveMappingDir(dataDir: string): string {
  return join(dataDir, 'column-reviews', 'effective');
}

function getEffectiveMappingPath(dataDir: string, runId: string, profileId: string): string {
  return join(getEffectiveMappingDir(dataDir), `${runId}_${profileId}.json`);
}

export function saveEffectiveMapping(dataDir: string, result: EffectiveMappingResult): void {
  const dir = getEffectiveMappingDir(dataDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    getEffectiveMappingPath(dataDir, result.runId, result.profileId),
    JSON.stringify(result, null, 2),
    'utf-8',
  );
}

export function loadEffectiveMapping(
  dataDir: string,
  runId: string,
  profileId: string,
): EffectiveMappingResult | null {
  const filePath = getEffectiveMappingPath(dataDir, runId, profileId);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as EffectiveMappingResult;
  } catch {
    return null;
  }
}

/**
 * 指定 runId に紐づく全 effective mapping を返す。
 * rerun-with-review 時に使用。
 */
export function findEffectiveMappings(dataDir: string, runId: string): EffectiveMappingResult[] {
  const dir = getEffectiveMappingDir(dataDir);
  if (!existsSync(dir)) return [];

  const prefix = `${runId}_`;
  const results: EffectiveMappingResult[] = [];

  for (const f of readdirSync(dir)) {
    if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
    try {
      results.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')) as EffectiveMappingResult);
    } catch {
      // skip corrupted
    }
  }

  return results;
}
