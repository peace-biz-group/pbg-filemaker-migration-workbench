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
 * ファイル名と列名からプロファイル候補をマッチングする。
 *
 * マッチング優先度:
 * 1. ファイル名ヒント一致（高信頼）
 * 2. 列ヘッダーヒント一致（中信頼、補助）
 * 3. マッチなし → 新規ファイル
 */
export function matchProfile(
  filename: string,
  columns: string[],
): ProfileMatchResult {
  const name = basename(filename);
  const scored: Array<{ profile: FileProfile; score: number; reason: string }> = [];

  for (const profile of registry) {
    let score = 0;
    const reasons: string[] = [];

    // Filename hint match
    for (const hint of profile.filenameHints) {
      if (globMatch(hint, name)) {
        score += 100;
        reasons.push('ファイル名が一致');
        break;
      }
    }

    // Header hint match (supplementary)
    if (columns.length > 0) {
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

    if (score > 0) {
      scored.push({ profile, score, reason: reasons.join('、') });
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
