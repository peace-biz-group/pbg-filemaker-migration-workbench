/**
 * Fast path — 列レビューをスキップして known file を素早く進める。
 *
 * - canUseFastPath: strong match の場合のみ fast path を許可（confidence=high のみ）
 * - buildAutoReviews: profile の列定義から自動レビューを生成（全て inUse=yes）
 *
 * unsafe な自動確定はしない。fast path は confidence=high のときのみ有効。
 */

import type { FileProfile, ColumnDef, ColumnReviewEntry } from './types.js';

export interface FastPathEligibility {
  eligible: boolean;
}

/**
 * fast path を使えるかを判定する。
 *
 * 条件:
 * - confidence === 'high'
 * - profile !== null
 */
export function canUseFastPath(
  confidence: 'high' | 'medium' | 'low' | 'none',
  profile: FileProfile | null,
): FastPathEligibility {
  if (!profile || confidence !== 'high') {
    return { eligible: false };
  }
  return { eligible: true };
}

/**
 * profile の列定義と実際の CSV 列名から、列レビュー回答を自動生成する。
 *
 * - label: 実際の CSV 列名（ヘッダーなし CSV では positional 名）
 * - key: profile の canonical key
 * - inUse: 常に 'yes'（fast path は全列使用とみなす）
 * - required: profile の required フラグから変換
 *
 * ヘッダーなし CSV では actualColumns が ['col_1', 'col_2', ...] になる。
 * actualColumns が足りない場合は profile.label にフォールバック。
 */
export function buildAutoReviews(
  profileColumns: ColumnDef[],
  actualColumns: string[],
): ColumnReviewEntry[] {
  return profileColumns.map((col) => {
    const sourceHeader = actualColumns[col.position] ?? col.label;
    return {
      position: col.position,
      label: sourceHeader,
      key: col.key,
      meaning: col.label,
      inUse: 'yes',
      required: col.required ? 'yes' : 'no',
      rule: col.rule ?? '',
    };
  });
}
