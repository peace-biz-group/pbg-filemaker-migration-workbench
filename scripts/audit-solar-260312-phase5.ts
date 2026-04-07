#!/usr/bin/env npx tsx
/**
 * Solar 監査 Phase 5 — 260312 batch
 *
 * Phase 4 の load spec / review queue / merge policy / status dict を前提に、
 * 現場レビュー運用パック・merge simulation・manual resolution 設計を行う。
 * DDL 実行・Supabase 接続・staging insert はしない。
 *
 * 生成物:
 *   1. high-priority-review-packet.csv / .md
 *   2. medium-priority-review-summary.csv / .md
 *   3. merge-simulation.md / .csv
 *   4. manual-resolution-template.csv / manual-resolution-apply-spec.md
 *   5. status-hearing-pack.md / status-hearing-sheet.csv
 *   6. db-go-live-readiness-checklist.md
 *   7. phase5-summary.md
 *
 * 実行: npm run audit:solar:phase5
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

// ─── paths ───────────────────────────────────────────────────────────
const PHASE3_DIR = resolve('artifacts/filemaker-audit/solar/260312/phase3');
const PHASE4_DIR = resolve('artifacts/filemaker-audit/solar/260312/phase4');
const OUT_DIR = resolve('artifacts/filemaker-audit/solar/260312/phase5');

const INPUTS = {
  prioritizedQueue: resolve(
    PHASE4_DIR,
    'activity-call-match-review-queue-prioritized.csv',
  ),
  customerStaging: resolve(PHASE3_DIR, 'customer-staging-v0.csv'),
  statusDictV2: resolve(PHASE4_DIR, 'status-dictionary-candidate-v2.csv'),
  unionCandidate: resolve(PHASE3_DIR, 'activity-call-union-candidate.csv'),
  sourceAStaging: resolve(
    PHASE3_DIR,
    'activity-call-source-a-staging-v0.csv',
  ),
  sourceBStaging: resolve(
    PHASE3_DIR,
    'activity-call-source-b-staging-v0.csv',
  ),
  dealStaging: resolve(PHASE3_DIR, 'deal-staging-v0.csv'),
} as const;

type Row = Record<string, string>;

// ─── helpers ─────────────────────────────────────────────────────────
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function readCsv(filePath: string): Row[] {
  const buf = readFileSync(filePath, 'utf-8');
  return parse(buf, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  }) as Row[];
}

function writeCsvFile(
  filePath: string,
  rows: Record<string, unknown>[],
): void {
  if (rows.length === 0) {
    writeFileSync(filePath, '', 'utf-8');
  } else {
    writeFileSync(filePath, stringify(rows, { header: true }), 'utf-8');
  }
  console.log(`  -> ${basename(filePath)} (${rows.length} rows)`);
}

function writeMd(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf-8');
  console.log(`  -> ${basename(filePath)}`);
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

// ─── main ────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Solar 260312 Phase 5: Review Ops Pack ===\n');
  ensureDir(OUT_DIR);

  // ── read inputs ──
  console.log('[1/8] Reading inputs...');
  const queue = readCsv(INPUTS.prioritizedQueue);
  const customers = readCsv(INPUTS.customerStaging);
  const statusDictV2 = readCsv(INPUTS.statusDictV2);
  const deals = readCsv(INPUTS.dealStaging);

  // Build customer lookup
  const customerMap = new Map<string, Row>();
  for (const c of customers) {
    if (c.customer_id) customerMap.set(c.customer_id, c);
  }

  // Build deal lookup for status enrichment
  const dealMap = new Map<string, Row>();
  for (const d of deals) {
    if (d.customer_id) dealMap.set(d.customer_id, d);
  }

  // Filter by priority
  const highQueue = queue.filter((r) => r.priority === 'high');
  const mediumQueue = queue.filter((r) => r.priority === 'medium');
  const lowQueue = queue.filter((r) => r.priority === 'low');

  console.log(`  queue total: ${queue.length}`);
  console.log(`  high: ${highQueue.length}, medium: ${mediumQueue.length}, low: ${lowQueue.length}`);
  console.log(`  customers: ${customers.length}, deals: ${deals.length}`);

  // ── 1. high priority review packet ──
  console.log('\n[2/8] Generating high priority review packet...');
  generateHighPriorityReviewPacket(highQueue, customerMap);

  // ── 2. medium priority review summary ──
  console.log('\n[3/8] Generating medium priority review summary...');
  generateMediumPriorityReviewSummary(mediumQueue, customerMap);

  // ── 3. merge simulation ──
  console.log('\n[4/8] Generating merge simulation...');
  generateMergeSimulation();

  // ── 4. manual resolution template + apply spec ──
  console.log('\n[5/8] Generating manual resolution template and apply spec...');
  generateManualResolutionTemplate(highQueue);
  generateManualResolutionApplySpec();

  // ── 5. status hearing pack ──
  console.log('\n[6/8] Generating status hearing pack...');
  generateStatusHearingPack(statusDictV2, dealMap, customerMap);

  // ── 6. db go-live readiness checklist ──
  console.log('\n[7/8] Generating DB go-live readiness checklist...');
  generateGoLiveChecklist(highQueue, mediumQueue, lowQueue, statusDictV2);

  // ── 7. phase5 summary ──
  console.log('\n[8/8] Generating phase5-summary...');
  generatePhase5Summary(highQueue, mediumQueue, lowQueue, statusDictV2);

  console.log(
    '\n=== Phase 5 complete. All artifacts in:',
    OUT_DIR,
    '===',
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 1. High Priority Review Packet
// ═══════════════════════════════════════════════════════════════════════

function generateHighPriorityReviewPacket(
  highQueue: Row[],
  customerMap: Map<string, Row>,
) {
  // Group by phone number to create one review item per unique phone
  const phoneGroups = new Map<
    string,
    { rows: Row[]; candidateIds: string[] }
  >();

  for (const row of highQueue) {
    const phone = row.normalized_phone || row.raw_phone || 'UNKNOWN';
    if (!phoneGroups.has(phone)) {
      const candidateIds = (row.candidate_customer_ids || '')
        .split(';')
        .filter(Boolean);
      phoneGroups.set(phone, { rows: [], candidateIds });
    }
    phoneGroups.get(phone)!.rows.push(row);
  }

  const packet: Record<string, unknown>[] = [];
  let reviewId = 1;

  for (const [phone, group] of phoneGroups) {
    const firstRow = group.rows[0];

    // Enrich with customer names and addresses
    const candidateNames: string[] = [];
    const candidateAddresses: string[] = [];
    for (const cid of group.candidateIds) {
      const c = customerMap.get(cid);
      if (c) {
        candidateNames.push(`${cid}: ${c.furigana || '(名前なし)'}`);
        candidateAddresses.push(
          `${cid}: ${c.address || '(住所なし)'}`,
        );
      } else {
        candidateNames.push(`${cid}: (マスタ不在)`);
        candidateAddresses.push(`${cid}: (マスタ不在)`);
      }
    }

    // Collect call date range and sample content
    const dates = group.rows
      .map((r) => r.call_date)
      .filter(Boolean)
      .sort();
    const dateRange =
      dates.length > 0
        ? `${dates[0]} ~ ${dates[dates.length - 1]}`
        : '';

    const sampleContents = group.rows
      .map((r) => r.content_preview)
      .filter(Boolean)
      .slice(0, 3)
      .join(' / ');

    packet.push({
      review_id: `HR-${String(reviewId).padStart(4, '0')}`,
      priority: 'high',
      review_bucket: firstRow.review_bucket,
      review_reason: firstRow.review_reason,
      call_count: group.rows.length,
      source_kind: firstRow.source_kind,
      raw_source_file: firstRow.source_file,
      normalized_phone: phone,
      raw_phone: firstRow.raw_phone,
      candidate_customer_ids: group.candidateIds.join('; '),
      candidate_count: firstRow.candidate_count,
      candidate_names: candidateNames.join(' | '),
      candidate_addresses: candidateAddresses.join(' | '),
      call_date_range: dateRange,
      call_owner_sample: firstRow.call_owner,
      content_preview: sampleContents.substring(0, 200),
      suggested_action: firstRow.suggested_action,
      human_decision: '',
      chosen_customer_id: '',
      reviewer_note: '',
    });
    reviewId++;
  }

  writeCsvFile(
    resolve(OUT_DIR, 'high-priority-review-packet.csv'),
    packet,
  );

  // Generate markdown
  const bucketCounts: Record<string, number> = {};
  for (const p of packet) {
    const b = p.review_bucket as string;
    bucketCounts[b] = (bucketCounts[b] || 0) + 1;
  }

  let md = `# High Priority Review Packet — Solar 260312

> このパケットは、activity_call の電話番号マッチで high priority と判定された
> レビュー項目をまとめたものです。現場で1件ずつ確認してください。

生成日: ${new Date().toISOString().split('T')[0]}

---

## 概要

| 項目 | 値 |
|------|-----|
| 対象コール行数 | ${highQueue.length} 件 |
| レビュー項目数（電話番号別） | ${packet.length} 件 |
| review_bucket 内訳 | ${Object.entries(bucketCounts).map(([k, v]) => `${k}: ${v}`).join(', ')} |

## レビューの進め方

1. **CSV を開く**: \`high-priority-review-packet.csv\` を Excel / Google Sheets で開く
2. **1行ずつ確認**: candidate_names と candidate_addresses を見て、content_preview と照合
3. **判断を記入**: 以下の3列を埋める
   - \`human_decision\`: \`resolved\` / \`skip\` / \`unclear\`
   - \`chosen_customer_id\`: 正しい顧客 ID (例: RC0L001)
   - \`reviewer_note\`: 判断理由のメモ
4. **保存して返送**: 記入済み CSV を保存

## review_bucket の説明

| Bucket | 件数 | 意味 | 対処のヒント |
|--------|------|------|-------------|
| unclear | ${bucketCounts['unclear'] || 0} | 候補顧客の住所・名前からパターンが読み取れない | content_preview を読んで判断 |
| same_name_same_phone | ${bucketCounts['same_name_same_phone'] || 0} | 同じ名前・同じ電話番号で複数 ID がある | 重複登録の可能性。住所を比較して同一か判断 |
| same_phone_different_name | ${bucketCounts['same_phone_different_name'] || 0} | 同じ電話番号だが名前が違う | 家族・同僚の可能性。コール内容から対象者を特定 |

## 判断に迷ったら

- \`human_decision\` に \`unclear\` と書いて飛ばしてください
- 後でまとめて確認します
- 無理に決めないでください

---

## レビュー項目一覧 (先頭 20 件)

| # | review_id | 電話番号 | 候補数 | コール数 | bucket | 候補顧客 |
|---|-----------|---------|--------|---------|--------|---------|
`;

  for (let i = 0; i < Math.min(20, packet.length); i++) {
    const p = packet[i];
    md += `| ${i + 1} | ${p.review_id} | ${p.normalized_phone} | ${p.candidate_count} | ${p.call_count} | ${p.review_bucket} | ${(p.candidate_names as string).substring(0, 60)} |\n`;
  }

  if (packet.length > 20) {
    md += `\n> 残り ${packet.length - 20} 件は CSV ファイルを参照してください。\n`;
  }

  writeMd(resolve(OUT_DIR, 'high-priority-review-packet.md'), md);
}

// ═══════════════════════════════════════════════════════════════════════
// 2. Medium Priority Review Summary
// ═══════════════════════════════════════════════════════════════════════

function generateMediumPriorityReviewSummary(
  mediumQueue: Row[],
  customerMap: Map<string, Row>,
) {
  // Group by bucket
  const buckets = new Map<string, Row[]>();
  for (const row of mediumQueue) {
    const bucket = row.review_bucket || 'unknown';
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket)!.push(row);
  }

  // Create summary rows per bucket with phone grouping
  const summaryRows: Record<string, unknown>[] = [];

  for (const [bucket, rows] of buckets) {
    // Group by phone within bucket
    const phoneGroups = new Map<string, Row[]>();
    for (const row of rows) {
      const phone = row.normalized_phone || row.raw_phone || 'NONE';
      if (!phoneGroups.has(phone)) phoneGroups.set(phone, []);
      phoneGroups.get(phone)!.push(row);
    }

    // Count unique phones
    const uniquePhones = phoneGroups.size;

    // Get top 5 phones by frequency
    const topPhones = [...phoneGroups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 5);

    // Collect date range
    const allDates = rows
      .map((r) => r.call_date)
      .filter(Boolean)
      .sort();
    const dateRange =
      allDates.length > 0
        ? `${allDates[0]} ~ ${allDates[allDates.length - 1]}`
        : '';

    // Suggested batch action
    let batchAction: string;
    let batchNote: string;
    if (bucket === 'family_shared_phone') {
      batchAction = 'content_based_batch_match';
      batchNote =
        '同一住所の家族。コール内容に名前が出ていれば自動紐付け可能な場合あり。出ていなければ fill-forward ID を採用';
    } else if (bucket === 'no_match') {
      batchAction = 'investigate_or_defer';
      batchNote =
        '顧客マスタに電話番号が未登録。新規顧客か番号変更か判断が必要。staging 投入時は matched_customer_id=NULL のまま保持';
    } else {
      batchAction = 'individual_review';
      batchNote = 'パターンが不明。個別に確認が必要';
    }

    summaryRows.push({
      review_bucket: bucket,
      total_call_rows: rows.length,
      unique_phone_numbers: uniquePhones,
      date_range: dateRange,
      top_phone_1: topPhones[0]
        ? `${topPhones[0][0]} (${topPhones[0][1].length}件)`
        : '',
      top_phone_2: topPhones[1]
        ? `${topPhones[1][0]} (${topPhones[1][1].length}件)`
        : '',
      top_phone_3: topPhones[2]
        ? `${topPhones[2][0]} (${topPhones[2][1].length}件)`
        : '',
      suggested_batch_action: batchAction,
      batch_note: batchNote,
    });
  }

  writeCsvFile(
    resolve(OUT_DIR, 'medium-priority-review-summary.csv'),
    summaryRows,
  );

  // Markdown
  let md = `# Medium Priority Review Summary — Solar 260312

> medium priority のレビュー項目を bucket 単位でまとめたものです。
> 全件の個別レビューではなく、bucket ごとの一括処理方針を示します。

生成日: ${new Date().toISOString().split('T')[0]}

---

## 概要

| 項目 | 値 |
|------|-----|
| 対象コール行数 | ${mediumQueue.length} 件 |
| bucket 数 | ${buckets.size} |

## bucket 別内訳

| Bucket | コール行数 | ユニーク電話番号数 | 推奨処理 |
|--------|----------|-----------------|---------|
`;

  for (const row of summaryRows) {
    md += `| ${row.review_bucket} | ${row.total_call_rows} | ${row.unique_phone_numbers} | ${row.suggested_batch_action} |\n`;
  }

  md += `
---

## bucket 別の処理方針

### family_shared_phone (${summaryRows.find((r) => r.review_bucket === 'family_shared_phone')?.total_call_rows || 0} 件)

同一住所の家族が電話番号を共有しているケース。

**処理方針**:
1. コール内容に個人名が出ている場合 → その顧客 ID に紐付け
2. 個人名が出ていない場合 → Source B の fill_forward_customer_id を採用
3. どちらも判断できない場合 → 世帯主（customer_id が若い方）に仮紐付け + \`match_confidence=low\` フラグ

**一括処理の可否**: 部分的に可能。名前が出ているケースは grep で抽出できる。

### no_match (${summaryRows.find((r) => r.review_bucket === 'no_match')?.total_call_rows || 0} 件)

有効な電話番号だが顧客マスタに該当なし。

**処理方針**:
1. staging 投入時は \`matched_customer_id = NULL\` のまま保持
2. 電話番号が複数回出現 → 新規顧客の可能性。現場に確認
3. 1回のみ出現 → 番号変更 or 誤入力の可能性。低優先

**一括処理の可否**: 一括で \`matched_customer_id = NULL\` 処理可能。個別確認は後回し。

### unclear (${summaryRows.find((r) => r.review_bucket === 'unclear')?.total_call_rows || 0} 件)

パターンが読み取れないケース。

**処理方針**:
1. high priority の unclear は個別レビュー済み（別パケット）
2. medium の unclear は件数を見て判断
3. 件数が少なければ個別確認、多ければ deferred_review として staging 投入

**一括処理の可否**: 不可。個別確認が必要。

---

## 優先順位

1. **no_match** → 一括 NULL 処理で即完了可能。レビュー不要
2. **family_shared_phone** → コール内容の名前 grep で半自動処理
3. **unclear** → 個別確認。Phase 6 以降に持ち越し可
`;

  writeMd(resolve(OUT_DIR, 'medium-priority-review-summary.md'), md);
}

// ═══════════════════════════════════════════════════════════════════════
// 3. Merge Simulation
// ═══════════════════════════════════════════════════════════════════════

function generateMergeSimulation() {
  // Phase 2/4 の数値を使用（CSV は multi-line で直接パースが重いため）
  const SOURCE_A_ROWS = 46572;
  const SOURCE_B_ROWS = 51150;
  const UNION_ROWS = 97722;
  const STRICT_OVERLAP = 4280;
  const LOOSE_OVERLAP = 3285;
  const A_UNIQUE_FP = 35372; // A only (unique fingerprint)
  const B_UNIQUE_FP = 34689; // B only (unique fingerprint)

  // Pattern 1: keep_all
  const keepAll = {
    pattern: 'keep_all',
    description: 'A/B 全件を staging に投入。重複もそのまま保持',
    total_rows: UNION_ROWS,
    source_a_retained: SOURCE_A_ROWS,
    source_b_retained: SOURCE_B_ROWS,
    overlap_handled: 0,
    overlap_description: '重複は検出するが行削除しない',
    review_dependent_rows: 0,
    traceability: 'source_kind + source_fingerprint で完全追跡可能',
    downstream_simplicity: '低 — downstream で重複除去ロジックが必要',
  };

  // Pattern 2: soft_dedupe_by_cross_source_fp
  const softDedupe = {
    pattern: 'soft_dedupe_by_cross_source_fp',
    description:
      '厳密一致 (date+staff+content80) の重複を Source B 側で inactive 化',
    total_rows: UNION_ROWS - STRICT_OVERLAP,
    source_a_retained: SOURCE_A_ROWS,
    source_b_retained: SOURCE_B_ROWS - STRICT_OVERLAP,
    overlap_handled: STRICT_OVERLAP,
    overlap_description: `厳密一致 ${STRICT_OVERLAP} 件は B 側を _dedupe_status=inactive に。ルーズ一致 ${LOOSE_OVERLAP} 件は要レビュー`,
    review_dependent_rows: LOOSE_OVERLAP,
    traceability:
      'inactive 行も staging に残るため完全追跡可能。_dedupe_status で区別',
    downstream_simplicity:
      '中 — active 行のみ使えば良い。ルーズ一致分はレビュー待ち',
  };

  // Pattern 3: keep_A_primary_and_attach_B_reference
  const aPrimaryBRef = {
    pattern: 'keep_A_primary_and_attach_B_reference',
    description:
      'Source A を primary。B のうち A に厳密一致しない行のみ追加',
    total_rows: SOURCE_A_ROWS + B_UNIQUE_FP,
    source_a_retained: SOURCE_A_ROWS,
    source_b_retained: B_UNIQUE_FP,
    overlap_handled: SOURCE_B_ROWS - B_UNIQUE_FP,
    overlap_description: `B のうち A と厳密一致する ${SOURCE_B_ROWS - B_UNIQUE_FP} 件を除外。B 固有の ${B_UNIQUE_FP} 件のみ追加`,
    review_dependent_rows: 0,
    traceability:
      '除外された B 行は staging 外。原本参照は raw ファイルのみ',
    downstream_simplicity:
      '高 — A が primary で統一。B は補完のみ。Ops Core 接続がシンプル',
  };

  const simulations = [keepAll, softDedupe, aPrimaryBRef];

  writeCsvFile(
    resolve(OUT_DIR, 'merge-simulation.csv'),
    simulations.map((s) => ({
      pattern: s.pattern,
      total_rows: s.total_rows,
      source_a_retained: s.source_a_retained,
      source_b_retained: s.source_b_retained,
      overlap_handled: s.overlap_handled,
      review_dependent_rows: s.review_dependent_rows,
      downstream_simplicity: s.downstream_simplicity,
    })),
  );

  let md = `# Merge Simulation — Solar 260312

> Phase 4 で推奨した「A/B 並存保持 + Downstream Review」を前提に、
> 3 パターンの merge 結果をシミュレーションする。

生成日: ${new Date().toISOString().split('T')[0]}

---

## 前提数値 (Phase 2/3 で確認済み)

| 指標 | 値 |
|------|-----|
| Source A (コール履歴 XLSX) | ${SOURCE_A_ROWS.toLocaleString()} 行 |
| Source B (ポータル展開) | ${SOURCE_B_ROWS.toLocaleString()} 行 |
| Union (A + B) | ${UNION_ROWS.toLocaleString()} 行 |
| 厳密一致 (date+staff+content80) | ${STRICT_OVERLAP.toLocaleString()} 件 (11.0%) |
| ルーズ一致 (date+staff) | ${LOOSE_OVERLAP.toLocaleString()} 件 (8.4%) |
| A 固有 FP | ${A_UNIQUE_FP.toLocaleString()} 件 |
| B 固有 FP | ${B_UNIQUE_FP.toLocaleString()} 件 |

---

## 3 パターン比較

### Pattern 1: keep_all — 全件保持

${s(keepAll)}

### Pattern 2: soft_dedupe_by_cross_source_fp — FP 一致分を inactive 化

${s(softDedupe)}

### Pattern 3: keep_A_primary_and_attach_B_reference — A を正に B を補完

${s(aPrimaryBRef)}

---

## 比較マトリクス

| 評価軸 | keep_all | soft_dedupe | A_primary_B_ref |
|--------|----------|-------------|-----------------|
| 合計行数 | ${keepAll.total_rows.toLocaleString()} | ${softDedupe.total_rows.toLocaleString()} | ${aPrimaryBRef.total_rows.toLocaleString()} |
| A 保持 | ${keepAll.source_a_retained.toLocaleString()} | ${softDedupe.source_a_retained.toLocaleString()} | ${aPrimaryBRef.source_a_retained.toLocaleString()} |
| B 保持 | ${keepAll.source_b_retained.toLocaleString()} | ${softDedupe.source_b_retained.toLocaleString()} | ${aPrimaryBRef.source_b_retained.toLocaleString()} |
| 重複処理 | ${keepAll.overlap_handled.toLocaleString()} | ${softDedupe.overlap_handled.toLocaleString()} | ${aPrimaryBRef.overlap_handled.toLocaleString()} |
| レビュー依存 | ${keepAll.review_dependent_rows.toLocaleString()} | ${softDedupe.review_dependent_rows.toLocaleString()} | ${aPrimaryBRef.review_dependent_rows.toLocaleString()} |
| 追跡可能性 | ◎ | ◎ | △ |
| downstream 簡潔さ | × | ○ | ◎ |
| データ完全性 | ◎ | ◎ | △ |
| 安全性 | ◎ | ○ | ○ |

---

## 推奨

**Phase 5 時点の推奨: Pattern 2 (soft_dedupe_by_cross_source_fp)**

Phase 4 では「並存保持」を推奨したが、staging に入れるタイミングでは Pattern 2 が最もバランスが良い。

**理由**:
1. 厳密一致 4,280 件は同一レコードと判断して安全 → B 側を inactive 化
2. inactive にするだけで行を削除しないため、可逆性を維持
3. ルーズ一致 3,285 件はレビュー待ちとして保持
4. downstream では \`_dedupe_status = 'active'\` のみを使えば良い
5. Phase 4 の「並存保持」方針とも矛盾しない (全行は staging に存在する)

**ヒアリング確認事項**:
- Source A/B が同一 FileMaker DB の別エクスポートであることの確認
- 厳密一致 = 同一レコードと判断してよいか

---

## 次のステップ

1. ヒアリングで Source A/B の出元を確認
2. 確認が取れたら Pattern 2 を適用
3. ルーズ一致 3,285 件を review queue に追加
4. staging INSERT 時に \`_dedupe_status\` 列を付与
`;

  writeMd(resolve(OUT_DIR, 'merge-simulation.md'), md);
}

function s(sim: {
  pattern: string;
  description: string;
  total_rows: number;
  source_a_retained: number;
  source_b_retained: number;
  overlap_handled: number;
  overlap_description: string;
  review_dependent_rows: number;
  traceability: string;
  downstream_simplicity: string;
}): string {
  return `| 項目 | 内容 |
|------|------|
| 概要 | ${sim.description} |
| 合計行数 | ${sim.total_rows.toLocaleString()} |
| Source A 保持 | ${sim.source_a_retained.toLocaleString()} |
| Source B 保持 | ${sim.source_b_retained.toLocaleString()} |
| 重複処理 | ${sim.overlap_handled.toLocaleString()} 件 — ${sim.overlap_description} |
| レビュー依存行 | ${sim.review_dependent_rows.toLocaleString()} 件 |
| 追跡可能性 | ${sim.traceability} |
| downstream 簡潔さ | ${sim.downstream_simplicity} |`;
}

// ═══════════════════════════════════════════════════════════════════════
// 4. Manual Resolution Template + Apply Spec
// ═══════════════════════════════════════════════════════════════════════

function generateManualResolutionTemplate(highQueue: Row[]) {
  // Group by phone for unique review items
  const phoneGroups = new Map<string, Row[]>();
  for (const row of highQueue) {
    const phone = row.normalized_phone || row.raw_phone || 'UNKNOWN';
    if (!phoneGroups.has(phone)) phoneGroups.set(phone, []);
    phoneGroups.get(phone)!.push(row);
  }

  const template: Record<string, unknown>[] = [];
  let reviewId = 1;

  for (const [phone, rows] of phoneGroups) {
    const firstRow = rows[0];
    template.push({
      review_id: `HR-${String(reviewId).padStart(4, '0')}`,
      review_bucket: firstRow.review_bucket,
      normalized_phone: phone,
      candidate_customer_ids: firstRow.candidate_customer_ids,
      candidate_count: firstRow.candidate_count,
      call_count: rows.length,
      decision_status: '',
      chosen_customer_id: '',
      chosen_strategy: '',
      note: '',
      reviewer: '',
      reviewed_at: '',
    });
    reviewId++;
  }

  writeCsvFile(
    resolve(OUT_DIR, 'manual-resolution-template.csv'),
    template,
  );
}

function generateManualResolutionApplySpec() {
  const md = `# Manual Resolution Apply Spec — Solar 260312

> このドキュメントは、manual-resolution-template.csv に記入された人手判断を
> staging データに反映する方法を定義します。

生成日: ${new Date().toISOString().split('T')[0]}

---

## Template の列定義

| 列名 | 型 | 説明 | 記入例 |
|------|-----|------|--------|
| review_id | TEXT | レビュー項目 ID (自動生成) | HR-0001 |
| review_bucket | TEXT | 分類 (自動生成) | unclear / same_name_same_phone |
| normalized_phone | TEXT | 対象電話番号 (自動生成) | 0929802702 |
| candidate_customer_ids | TEXT | 候補顧客 ID (自動生成) | RC0L001; RC2K057 |
| candidate_count | INTEGER | 候補数 (自動生成) | 2 |
| call_count | INTEGER | 対象コール行数 (自動生成) | 6 |
| **decision_status** | TEXT | **人手記入**: 判断結果 | resolved / skip / unclear / defer |
| **chosen_customer_id** | TEXT | **人手記入**: 選んだ顧客 ID | RC0L001 |
| **chosen_strategy** | TEXT | **人手記入**: 紐付け方法 | assign_all / assign_by_date / split |
| **note** | TEXT | **人手記入**: 判断理由メモ | 磯貝さん宅への電話 |
| **reviewer** | TEXT | **人手記入**: レビュー担当者名 | 田中 |
| **reviewed_at** | TEXT | **人手記入**: レビュー日 | 2026-04-10 |

---

## decision_status の選択肢

| 値 | 意味 | 次のアクション |
|-----|------|--------------|
| \`resolved\` | 正しい顧客を特定できた | chosen_customer_id を staging に反映 |
| \`skip\` | 今回はスキップ（後で対応） | staging は変更しない |
| \`unclear\` | 判断できない | エスカレーション対象 |
| \`defer\` | 追加情報が必要 | 保留。Phase 6 以降で再検討 |

## chosen_strategy の選択肢

| 値 | 意味 | 適用方法 |
|-----|------|---------|
| \`assign_all\` | この電話番号の全コールを chosen_customer_id に紐付け | staging_activity_call の matched_customer_id を更新 |
| \`assign_by_date\` | 日付範囲ごとに異なる顧客に紐付け | note に日付範囲と顧客 ID を記載。手動で分割 |
| \`split\` | コールごとに個別判断が必要 | 個別レビュー用の詳細テンプレートを別途生成 |

---

## 反映ルール

### どの列を見るか

1. \`review_id\` → high-priority-review-packet.csv と紐付け
2. \`decision_status\` → \`resolved\` のみ反映
3. \`chosen_customer_id\` → 反映先の顧客 ID
4. \`chosen_strategy\` → 反映方法

### どの staging row に反映するか

\`\`\`
対象: staging_activity_call
条件:
  - normalized_phone = template.normalized_phone
  - source_kind = 'source_a'  (Source A のみ。Source B は fill_forward_customer_id で紐付け済み)
  - match_type IN ('multi_match')
\`\`\`

### 何を更新するか

| staging 列 | 更新内容 |
|-----------|---------|
| matched_customer_id | chosen_customer_id の値 |
| matched_customer_candidate_count | 1 (確定) |
| match_type | 'manual_resolved' |

### 何を更新しないか

| staging 列 | 理由 |
|-----------|------|
| raw_phone | 原本情報。変更禁止 |
| normalized_phone | 原本情報。変更禁止 |
| source_fingerprint | 追跡情報。変更禁止 |
| raw_source_file | 追跡情報。変更禁止 |
| raw_row_origin | 追跡情報。変更禁止 |
| content | 原本情報。変更禁止 |
| call_date / call_time / call_staff | 原本情報。変更禁止 |

---

## 反映の SQL (草案・未実行)

\`\`\`sql
-- decision_status = 'resolved' AND chosen_strategy = 'assign_all' の場合
-- NOTE: 実行禁止。Phase 6 で確認後に実行。

UPDATE staging_activity_call
SET matched_customer_id = :chosen_customer_id,
    matched_customer_candidate_count = 1,
    match_type = 'manual_resolved'
WHERE normalized_phone = :normalized_phone
  AND source_kind = 'source_a'
  AND match_type = 'multi_match';
\`\`\`

---

## 反映フロー

\`\`\`
1. 現場が manual-resolution-template.csv を記入
2. 記入済み CSV を Phase 6 スクリプトに渡す
3. スクリプトが decision_status = 'resolved' の行を抽出
4. staging_activity_call を UPDATE
5. 更新件数と match_type 分布を postcheck で確認
6. 変更ログを staging_load_log に記録
\`\`\`

---

## 安全策

1. **dry-run モード**: 反映前に UPDATE 対象行数を表示。実行は手動確認後
2. **バックアップ**: UPDATE 前に staging_activity_call の snapshot を保存
3. **ロールバック**: match_type = 'manual_resolved' の行を元の 'multi_match' に戻す逆 UPDATE を用意
4. **監査**: 変更日時・変更者・review_id を staging_load_log に記録
`;

  writeMd(resolve(OUT_DIR, 'manual-resolution-apply-spec.md'), md);
}

// ═══════════════════════════════════════════════════════════════════════
// 5. Status Hearing Pack
// ═══════════════════════════════════════════════════════════════════════

function generateStatusHearingPack(
  statusDictV2: Row[],
  dealMap: Map<string, Row>,
  customerMap: Map<string, Row>,
) {
  // Filter to items that need hearing
  const needsHearing = statusDictV2.filter(
    (r) =>
      r.stage_confidence === 'low' || r.stage_confidence === 'medium',
  );

  // Build hearing sheet
  const hearingSheet: Record<string, unknown>[] = [];

  for (const row of needsHearing) {
    const sampleIds = (row.sample_customer_ids || '').split(';').filter(Boolean);
    const sampleDetails: string[] = [];

    for (const cid of sampleIds.slice(0, 3)) {
      const trimmed = cid.trim();
      const customer = customerMap.get(trimmed);
      const deal = dealMap.get(trimmed);
      if (customer && deal) {
        sampleDetails.push(
          `${trimmed}: ${customer.furigana || '?'} / ${customer.address?.substring(0, 20) || '?'} / 受注日=${deal.order_date || '?'}`,
        );
      } else if (customer) {
        sampleDetails.push(
          `${trimmed}: ${customer.furigana || '?'} / ${customer.address?.substring(0, 20) || '?'}`,
        );
      } else {
        sampleDetails.push(`${trimmed}: (データなし)`);
      }
    }

    // Determine workflow position hypothesis
    let workflowHypothesis: string;
    const normalized = row.normalized_stage || '';
    if (
      normalized.includes('scheduling') ||
      normalized.includes('waiting')
    ) {
      workflowHypothesis = '契約後・工事前のプロセス待ち';
    } else if (normalized.includes('hold') || normalized.includes('on_hold')) {
      workflowHypothesis = '何らかの理由で停止中';
    } else if (normalized === 'in_progress') {
      workflowHypothesis = '進行中（段階不明）';
    } else {
      workflowHypothesis = '不明 — ヒアリングで確認';
    }

    // Generate simple Japanese question
    const simpleQuestion = generateSimpleQuestion(
      row.status_value,
      row.hearing_question || row.requires_hearing || '',
    );

    hearingSheet.push({
      status_value: row.status_value,
      count: row.count,
      percentage: row.percentage,
      current_stage: row.normalized_stage,
      confidence: row.stage_confidence,
      workflow_hypothesis: workflowHypothesis,
      simple_question: simpleQuestion,
      sample_customers: sampleDetails.join(' | '),
      answer: '',
      confirmed_stage: '',
      confirmed_by: '',
      confirmed_at: '',
    });
  }

  writeCsvFile(resolve(OUT_DIR, 'status-hearing-sheet.csv'), hearingSheet);

  // Markdown
  let md = `# ステータスヒアリングパック — Solar 260312

> 現場のかたに見せて確認するためのドキュメントです。
> 専門用語を使わず、簡単な日本語で書いています。

作成日: ${new Date().toISOString().split('T')[0]}

---

## これは何ですか？

太陽光のお客様データを整理しています。
お客様の「状態」（今どうなっているか）を表す言葉がいくつかあるのですが、
意味がはっきりしないものがあります。

**以下の質問に答えていただけると、データの整理が正しくできます。**

---

## 確認したいこと

`;

  for (let i = 0; i < hearingSheet.length; i++) {
    const item = hearingSheet[i];
    md += `### ${i + 1}. 「${item.status_value}」（${item.count}件）

`;
    md += `${item.simple_question}\n\n`;
    md += `> 例: ${str(item.sample_customers).split(' | ')[0] || '(サンプルなし)'}\n\n`;
    md += `回答欄: ＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿\n\n`;
    md += `---\n\n`;
  }

  md += `## 追加で教えてほしいこと

### 審査結果について

太陽光の審査（信販会社の審査）で、以下の言葉が使われています:

1. **「連変」** — これは何ですか？
   - 連絡先の変更？
   - 連系（電力会社への接続）の変更？
   - それとも別の意味？

   回答欄: ＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿

2. **「取り直し」** — 何を取り直すのですか？
   - 審査のやり直し？
   - 書類の再提出？

   回答欄: ＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿

### お客様の情報について

3. **「契約者」** と **「お客様」** は同じ人ですか？
   - 家族の名前で契約することはありますか？

   回答欄: ＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿

4. **「代表者」** とは？
   - 会社の代表（社長）のことですか？
   - 個人のお客様の場合は誰ですか？

   回答欄: ＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿

5. **「見積依頼日」** と **「【見積】依頼日」** は同じですか？
   - 違う場合、何が違いますか？

   回答欄: ＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿

---

## 回答の仕方

- 分かるものだけ答えてください
- 分からない場合は「わからない」と書いてください
- 「たぶんこうだと思う」でも大丈夫です

**ありがとうございます！**
`;

  writeMd(resolve(OUT_DIR, 'status-hearing-pack.md'), md);
}

function generateSimpleQuestion(
  statusValue: string,
  rawQuestion: string,
): string {
  const questions: Record<string, string> = {
    再訪問調整中:
      '「再訪問調整中」とは、お客様のところにもう一度行く日を決めている状態ですか？ どういうときにこの状態にしますか？',
    回収保留:
      '「回収保留」とは、お金をもらうのを一時的に止めている状態ですか？ なぜ止めることがありますか？',
    現調待ち:
      '「現調待ち」とは、「現地調査をする予定だけど、まだ日が決まっていない」状態ですか？',
    対応中:
      '「対応中」とは、具体的に何をしている段階ですか？ 見積もりの段階？ 工事の段階？ それとも色々な段階で使いますか？',
    書類待ち:
      '「書類待ち」とは、どの書類が届くのを待っていますか？ 契約書？ お役所の書類？ お客様からの書類？',
    工事日調整中:
      '「工事日調整中」とは、契約は済んでいて、工事の日を決めている段階ですか？',
    現調申込:
      '「現調申込」とは、現地調査を業者さんにお願いした段階ですか？ 「現調待ち」とはどう違いますか？',
    発注待ち:
      '「発注待ち」とは、材料の注文を出す前の段階ですか？ 何を待っていますか？',
    現調日調整中:
      '「現調日調整中」とは、現地調査の日を決めている段階ですか？ 「現調待ち」や「現調申込」とどう違いますか？',
    電力申請依頼要:
      '「電力申請依頼要」とは、電力会社への申請をまだ出していない状態ですか？ 誰が申請を出しますか？',
  };
  return questions[statusValue] || rawQuestion || `「${statusValue}」の意味を教えてください`;
}

// ═══════════════════════════════════════════════════════════════════════
// 6. DB Go-Live Readiness Checklist
// ═══════════════════════════════════════════════════════════════════════

function generateGoLiveChecklist(
  highQueue: Row[],
  mediumQueue: Row[],
  lowQueue: Row[],
  statusDictV2: Row[],
) {
  const lowConfCount = statusDictV2.filter(
    (r) => r.stage_confidence === 'low',
  ).length;
  const medConfCount = statusDictV2.filter(
    (r) => r.stage_confidence === 'medium',
  ).length;

  const md = `# DB Go-Live Readiness Checklist — Solar 260312

> Phase 6 で DDL 実行・staging INSERT に進む前に、
> このチェックリストの全項目が完了していることを確認してください。

生成日: ${new Date().toISOString().split('T')[0]}

---

## 1. Review 完了チェック

### High Priority Review

- [ ] high-priority-review-packet.csv の全 ${highQueue.length} 件（電話番号ベースでグループ化済み）にレビュー結果を記入した
- [ ] decision_status が \`resolved\` または \`skip\` / \`defer\` で埋まっている
- [ ] \`unclear\` が残っている場合、エスカレーション先を決めた
- [ ] manual-resolution-template.csv を記入済み

### Medium Priority Review

- [ ] no_match ${mediumQueue.filter((r) => r.review_bucket === 'no_match').length} 件: staging では matched_customer_id=NULL で投入する方針を合意
- [ ] family_shared_phone ${mediumQueue.filter((r) => r.review_bucket === 'family_shared_phone').length} 件: fill-forward ID 採用の方針を合意
- [ ] unclear ${mediumQueue.filter((r) => r.review_bucket === 'unclear').length} 件: Phase 6 以降に持ち越す方針を合意

### Low Priority Review

- [ ] invalid ${lowQueue.filter((r) => r.review_bucket === 'invalid_phone').length} 件: データ品質問題として記録。staging では matched_customer_id=NULL で投入
- [ ] bulk_pattern_review ${lowQueue.filter((r) => r.suggested_action === 'bulk_pattern_review').length} 件: 営業担当携帯番号の特定を現場に依頼済み

---

## 2. Status Dictionary 確認

- [ ] low confidence ステータス ${lowConfCount} 件のヒアリングが完了
- [ ] medium confidence ステータス ${medConfCount} 件のヒアリングが完了
- [ ] status-hearing-sheet.csv に回答が記入されている
- [ ] 審査結果の「連変」「取り直し」の意味が確認済み
- [ ] normalized_stage が確定版に更新されている

---

## 3. Merge Policy 確定

- [ ] Source A/B が同一 FileMaker DB の別エクスポートであることを確認
- [ ] merge simulation の推奨 (Pattern 2: soft_dedupe) を合意
- [ ] 厳密一致 4,280 件は同一レコードとして B 側 inactive 化する方針を合意
- [ ] ルーズ一致 3,285 件の扱いを決めた（review or inactive）

---

## 4. DDL 確定

- [ ] staging-ddl-draft-v1.sql をレビュー済み
- [ ] customer/deal の 1:1 vs 1:N を確認した結果を反映
- [ ] provisional な unique/index 制約を確定版に昇格
- [ ] _loaded_at, _batch_id, _schema_version 列の自動付与を確認
- [ ] staging_rejected_rows テーブルの構造を合意
- [ ] staging_load_log テーブルの構造を合意

---

## 5. Precheck / Postcheck 合意

- [ ] staging-precheck.sql の項目をレビュー済み
- [ ] staging-postcheck.sql の期待値を確定
  - [ ] customer: 5,357 行
  - [ ] deal: 5,357 行
  - [ ] activity_call: 行数は merge pattern により変動（合意値を記入: ＿＿＿＿ 行）
- [ ] NOT NULL violation のしきい値を合意（0 件であるべき）
- [ ] FK orphan のしきい値を合意（warning のみ or reject）

---

## 6. Rollback 計画

- [ ] staging テーブルの TRUNCATE で全件クリアできることを確認
- [ ] re-run 手順: \`TRUNCATE → COPY\` で idempotent に再投入できることを確認
- [ ] 破壊的変更のないことを確認（raw ファイルは read-only、production テーブルは非対象）
- [ ] manual resolution の反映は match_type = 'manual_resolved' で逆引き可能

---

## 7. 運用準備

- [ ] Supabase プロジェクトの接続情報を確保
- [ ] staging 用のスキーマ（schema）を決定（public / staging / solar_260312 等）
- [ ] COPY 実行権限の確認
- [ ] CSV ファイルの Supabase サーバーへの転送方法を決定
- [ ] Phase 6 スクリプトの作成方針を合意

---

## 判定

| 区分 | 必須 | 完了 |
|------|------|------|
| Review 完了 | high priority のみ必須。medium/low は方針合意で可 | [ ] |
| Status 確認 | low confidence のみ必須 | [ ] |
| Merge 確定 | 必須 | [ ] |
| DDL 確定 | 必須 | [ ] |
| Check 合意 | 必須 | [ ] |
| Rollback | 必須 | [ ] |
| 運用準備 | 必須 | [ ] |

**全項目が完了するまで Phase 6 (DDL 実行・staging INSERT) に進まないこと。**
`;

  writeMd(resolve(OUT_DIR, 'db-go-live-readiness-checklist.md'), md);
}

// ═══════════════════════════════════════════════════════════════════════
// 7. Phase 5 Summary
// ═══════════════════════════════════════════════════════════════════════

function generatePhase5Summary(
  highQueue: Row[],
  mediumQueue: Row[],
  lowQueue: Row[],
  statusDictV2: Row[],
) {
  // Count high priority phone groups
  const highPhones = new Set(
    highQueue.map((r) => r.normalized_phone || r.raw_phone),
  );

  // Count medium buckets
  const medBuckets: Record<string, number> = {};
  for (const r of mediumQueue) {
    const b = r.review_bucket || 'unknown';
    medBuckets[b] = (medBuckets[b] || 0) + 1;
  }

  const lowConfStatus = statusDictV2.filter(
    (r) => r.stage_confidence === 'low' || r.stage_confidence === 'medium',
  );

  const md = `# Phase 5 Summary — Solar 260312

生成日: ${new Date().toISOString().split('T')[0]}

## 概要

Phase 5 は DB 実行前の最終レビュー運用パックの作成を目的とする。
high priority review packet、merge simulation、manual resolution 設計、
status hearing pack、go-live readiness checklist を生成した。

---

## 生成した成果物

| # | ファイル | 説明 |
|---|---------|------|
| 1 | high-priority-review-packet.csv | high priority レビュー項目（電話番号別） |
| 2 | high-priority-review-packet.md | レビューパケット説明書 |
| 3 | medium-priority-review-summary.csv | medium priority bucket 別集計 |
| 4 | medium-priority-review-summary.md | medium priority 処理方針 |
| 5 | merge-simulation.csv | 3 パターンの merge simulation 数値 |
| 6 | merge-simulation.md | merge simulation 比較と推奨 |
| 7 | manual-resolution-template.csv | 人手判断入力テンプレート |
| 8 | manual-resolution-apply-spec.md | 判断結果の staging 反映仕様 |
| 9 | status-hearing-pack.md | 現場向けステータスヒアリング資料 |
| 10 | status-hearing-sheet.csv | ヒアリング回答シート |
| 11 | db-go-live-readiness-checklist.md | Phase 6 進行前チェックリスト |
| 12 | phase5-summary.md | このファイル |

---

## High Priority Review Packet サマリ

| 項目 | 値 |
|------|-----|
| 対象コール行数 | ${highQueue.length} 件 |
| レビュー項目数（電話番号別） | ${highPhones.size} 件 |
| review_bucket: unclear | ${highQueue.filter((r) => r.review_bucket === 'unclear').length} 件 |
| review_bucket: same_name_same_phone | ${highQueue.filter((r) => r.review_bucket === 'same_name_same_phone').length} 件 |
| review_bucket: same_phone_different_name | ${highQueue.filter((r) => r.review_bucket === 'same_phone_different_name').length} 件 |

review packet は CSV に候補顧客の名前・住所を付加し、
現場が content_preview を読んで \`chosen_customer_id\` を記入できる形式。

---

## Merge Simulation サマリ

| Pattern | 合計行数 | A 保持 | B 保持 | 重複処理 | レビュー依存 |
|---------|---------|--------|--------|---------|------------|
| keep_all | 97,722 | 46,572 | 51,150 | 0 | 0 |
| soft_dedupe | 93,442 | 46,572 | 46,870 | 4,280 | 3,285 |
| A_primary_B_ref | 81,944 | 46,572 | 34,689 | 16,461 | 0 |

**推奨**: Pattern 2 (soft_dedupe_by_cross_source_fp)
- 厳密一致 4,280 件は B 側を inactive 化
- ルーズ一致 3,285 件はレビュー待ち
- Phase 4 の「並存保持」方針と矛盾しない（全行は staging に残る）

---

## Manual Resolution 設計サマリ

| 項目 | 内容 |
|------|------|
| テンプレート列数 | 12 列（うち人手記入 6 列） |
| 記入する列 | decision_status, chosen_customer_id, chosen_strategy, note, reviewer, reviewed_at |
| 反映対象 | staging_activity_call の matched_customer_id, match_type |
| 更新禁止列 | raw_phone, normalized_phone, source_fingerprint, content 等の原本情報 |
| 安全策 | dry-run モード、バックアップ、ロールバック用逆 UPDATE |

---

## Status Hearing Pack サマリ

| 項目 | 値 |
|------|-----|
| ヒアリング対象ステータス | ${lowConfStatus.length} 件 |
| 対象 deal 行数 | ${lowConfStatus.reduce((sum, r) => sum + parseInt(r.count || '0', 10), 0)} 件 |
| 追加確認事項 | 審査結果 (連変/取り直し)、契約者/代表者の関係、見積依頼日の重複 |

hearing pack は現場向けに簡単な日本語で記述。
回答欄付きの markdown と CSV の両方を用意。

---

## Unresolved / 要ヒアリング事項

### Phase 5 で新たに追加

| # | 項目 | 影響範囲 | 確認先 |
|---|------|---------|--------|
| 1 | merge simulation Pattern 2 の合意 | activity_call 97,722 件 | プロジェクトオーナー |
| 2 | manual resolution の dry-run 実行環境 | Phase 6 の実行方法 | 開発チーム |
| 3 | family_shared_phone の fill-forward ID 採用可否 | medium priority 1,851 件 | 現場担当者 |

### Phase 4 から引き続き

| # | 項目 | 影響範囲 | 確認先 |
|---|------|---------|--------|
| 4 | Source A/B が同一 DB の別エクスポートか | merge pattern 選択 | FileMaker 管理者 |
| 5 | customer / deal の 1:1 vs 1:N | DDL 確定 | 業務担当者 |
| 6 | 「連変」「取り直し」の業務的意味 | 審査結果正規化 | 業務担当者 |
| 7 | 電話番号 09094847774 の持ち主 | 337 コール行 | 営業担当者 |
| 8 | low confidence ステータス 8 件の意味 | ${lowConfStatus.filter((r) => r.stage_confidence === 'low').reduce((sum, r) => sum + parseInt(r.count || '0', 10), 0)} deal 行 | 業務担当者 |

---

## 次にやるべきこと

### 現場作業

1. **high-priority-review-packet.csv** を記入する
2. **status-hearing-pack.md** に回答する
3. **manual-resolution-template.csv** を記入する

### 技術作業 (Phase 6)

1. 記入済み CSV を受領・検証
2. manual resolution を staging に反映（dry-run → 本番）
3. merge simulation Pattern 2 を適用
4. DDL を確定版に昇格
5. Supabase に staging テーブルを作成
6. staging INSERT + postcheck

---

## 変更ファイル一覧

### 新規作成

| ファイル | パス |
|---------|------|
| Phase 5 スクリプト | scripts/audit-solar-260312-phase5.ts |
| high-priority-review-packet.csv | artifacts/.../phase5/high-priority-review-packet.csv |
| high-priority-review-packet.md | artifacts/.../phase5/high-priority-review-packet.md |
| medium-priority-review-summary.csv | artifacts/.../phase5/medium-priority-review-summary.csv |
| medium-priority-review-summary.md | artifacts/.../phase5/medium-priority-review-summary.md |
| merge-simulation.csv | artifacts/.../phase5/merge-simulation.csv |
| merge-simulation.md | artifacts/.../phase5/merge-simulation.md |
| manual-resolution-template.csv | artifacts/.../phase5/manual-resolution-template.csv |
| manual-resolution-apply-spec.md | artifacts/.../phase5/manual-resolution-apply-spec.md |
| status-hearing-pack.md | artifacts/.../phase5/status-hearing-pack.md |
| status-hearing-sheet.csv | artifacts/.../phase5/status-hearing-sheet.csv |
| db-go-live-readiness-checklist.md | artifacts/.../phase5/db-go-live-readiness-checklist.md |
| phase5-summary.md | artifacts/.../phase5/phase5-summary.md |

### 変更

| ファイル | 変更内容 |
|---------|---------|
| package.json | \`audit:solar:phase5\` スクリプト追加 |

---

## 実行コマンド

\`\`\`bash
npm run audit:solar:phase5
\`\`\`
`;

  writeMd(resolve(OUT_DIR, 'phase5-summary.md'), md);
}

// ─── run ─────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error('Phase 5 failed:', err);
  process.exit(1);
});
