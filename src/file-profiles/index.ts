/**
 * File Profile — プロファイル管理とマッチングロジック
 *
 * 既知ファイルのプロファイルをロードし、ファイル名や列ヘッダーから候補をマッチングする。
 * 保存は JSON ファイルベース（既存の設定管理方式に合わせる）。
 */

export { SEED_PROFILES } from './seed-profiles.js';
export type {
  FileProfile,
  ColumnDef,
  ColumnReviewEntry,
  ProfileMatchResult,
  UploadConfirmation,
} from './types.js';
export { isCandidateProfile, buildCandidateProfile, saveCandidateProfile } from './candidate-profile.js';
export type { CandidateProfile } from './types.js';

import { basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_PROFILES } from './seed-profiles.js';
import type { FileProfile, ProfileMatchResult, ColumnReviewEntry } from './types.js';
import { loadAllCandidateProfiles } from './candidate-profile.js';

// ---- Profile Registry ----

/** All loaded profiles (seed + user-saved) */
let registry: FileProfile[] = [...SEED_PROFILES];

/** Load user-saved profiles from disk, merging with seeds */
export function loadProfiles(dataDir: string): FileProfile[] {
  // 1. seed をベースにする
  let base: FileProfile[] = [...SEED_PROFILES];

  // 2. user-saved profiles（file-profiles.json）でシードを上書き
  const filePath = join(dataDir, 'file-profiles.json');
  if (existsSync(filePath)) {
    try {
      const saved: FileProfile[] = JSON.parse(readFileSync(filePath, 'utf-8'));
      const savedIds = new Set(saved.map(p => p.id));
      base = [
        ...saved,
        ...SEED_PROFILES.filter(s => !savedIds.has(s.id)),
      ];
    } catch {
      base = [...SEED_PROFILES];
    }
  }

  // 3. candidate profiles（candidate-profiles/*.json）を追加
  // candidate の ID は "candidate-{runId}-{profileId}" なので seed と衝突しない
  const candidates = loadAllCandidateProfiles(dataDir);
  const baseIds = new Set(base.map(p => p.id));
  const newCandidates = candidates.filter(c => !baseIds.has(c.id));

  registry = [...base, ...newCandidates];
  return registry;
}

/** Save profiles to disk */
export function saveProfiles(dataDir: string, profiles: FileProfile[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'file-profiles.json'),
    JSON.stringify(profiles, null, 2),
    'utf-8',
  );
  registry = profiles;
}

/** Get all currently loaded profiles */
export function getProfiles(): FileProfile[] {
  return registry;
}

/** Get a profile by id */
export function getProfileById(id: string): FileProfile | undefined {
  return registry.find(p => p.id === id);
}

// ---- Matching ----

/**
 * Simple glob match — same as column-mapper's globMatch, duplicated here
 * to avoid circular dependency. Supports * as wildcard.
 */
function globMatch(pattern: string, text: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    'i',
  );
  return regex.test(text);
}

/**
 * ファイル名・列名・列数からプロファイル候補をマッチングする。
 *
 * マッチング優先度:
 * 1. ファイル名ヒント一致（高信頼、+100）
 * 2. 列ヘッダーヒント一致（中信頼、補助、max +50）— ヘッダーありファイル向け
 * 3. 列数近似（+25/+15/+8）— ヘッダーなしファイルでも有効
 * 4. ヘッダーなしファイル × headerlessSuitable プロファイル（+20）
 * 5. マッチなし → 新規ファイル
 */
/**
 * ファイル名・列名・列数からプロファイル候補をマッチングする。
 *
 * options.knownFamilyId を渡すと、FamilyRegistry 等で事前に解決した family_id と
 * profile.familyId が一致するプロファイルに +80 のスコアブーストを加える。
 * これにより、ファイル名揺れや列追加削除があっても既知 family は high confidence に寄りやすくなる。
 */
export function matchProfile(
  filename: string,
  columns: string[],
  options?: { isHeaderless?: boolean; columnCount?: number; knownFamilyId?: string | null },
): ProfileMatchResult {
  const name = basename(filename);
  const { isHeaderless = false, columnCount, knownFamilyId } = options ?? {};
  const scored: Array<{ profile: FileProfile; score: number; reason: string }> = [];

  for (const profile of registry) {
    let score = 0;
    const reasons: string[] = [];

    // 1. Filename hint match (+100)
    for (const hint of profile.filenameHints) {
      if (globMatch(hint, name)) {
        score += 100;
        reasons.push('ファイル名が近い');
        break;
      }
    }

    // 2. Header hint match (max +50) — ヘッダーありの場合のみ有効
    if (!isHeaderless && columns.length > 0) {
      let headerMatches = 0;
      for (const colDef of profile.columns) {
        if (!colDef.headerHints) continue;
        for (const hint of colDef.headerHints) {
          if (columns.some(c => c.trim() === hint)) {
            headerMatches++;
            break;
          }
        }
      }
      if (headerMatches > 0) {
        const matchRatio = headerMatches / profile.columns.length;
        score += Math.round(matchRatio * 50);
        reasons.push(`列名が ${headerMatches} 件一致`);
      }
    }

    // 3. Column count scoring (+25/+15/+8)
    // profile.columnCount があればそちらを使い、なければ profile.columns.length にフォールバック
    if (columnCount !== undefined && columnCount > 0) {
      const expected = profile.columnCount ?? profile.columns.length;
      const diff = Math.abs(expected - columnCount);
      if (diff === 0) {
        score += 25;
        reasons.push('列の数が一致');
      } else if (diff <= 1) {
        score += 15;
        reasons.push('列の数が近い');
      } else if (diff <= 2) {
        score += 8;
        reasons.push('列の数がほぼ近い');
      }
      // diff > 2 はスコアなし
    }

    // 4. Headerless bonus (+20) — ヘッダーなしファイル × headerlessSuitable
    if (isHeaderless) {
      if (profile.headerlessSuitable === true) {
        score += 20;
        reasons.push('前に保存した設定が使えそうです');
      } else if (profile.defaultHasHeader === false) {
        score += 10;
        reasons.push('ヘッダーなし向けの設定');
      }
    }

    // 5. Known family boost (+80) — FamilyRegistry で解決済みの family_id と一致
    if (knownFamilyId != null && profile.familyId === knownFamilyId) {
      score += 80;
      reasons.push('過去に同種ファイルとして整備済み');
    }

    if (score > 0) {
      scored.push({ profile, score, reason: reasons.join('・') });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      profile: null,
      confidence: 'none',
      reason: '一致するファイル種別が見つかりませんでした',
      alternatives: [],
    };
  }

  const best = scored[0];
  const confidence = best.score >= 100 ? 'high' : best.score >= 30 ? 'medium' : 'low';

  return {
    profile: best.profile,
    confidence,
    reason: best.reason,
    alternatives: scored.slice(1).map(s => ({
      profile: s.profile,
      confidence: s.score >= 100 ? 'high' as const : s.score >= 30 ? 'medium' as const : 'low' as const,
      reason: s.reason,
    })),
  };
}

// ---- Column Review Persistence ----

/** Save column review for a specific run + profile */
export function saveColumnReview(
  dataDir: string,
  runId: string,
  profileId: string,
  reviews: ColumnReviewEntry[],
): void {
  const dir = join(dataDir, 'column-reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${runId}_${profileId}.json`),
    JSON.stringify({ runId, profileId, reviews, savedAt: new Date().toISOString() }, null, 2),
    'utf-8',
  );
}

/** Load column review for a specific run + profile */
export function loadColumnReview(
  dataDir: string,
  runId: string,
  profileId: string,
): ColumnReviewEntry[] | null {
  const filePath = join(dataDir, 'column-reviews', `${runId}_${profileId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    return data.reviews ?? null;
  } catch {
    return null;
  }
}
