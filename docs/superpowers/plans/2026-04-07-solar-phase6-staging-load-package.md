# Solar 260312 Phase 6 — Staging Load Package 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 5 の人手レビュー結果を反映し、status dict v3・merge policy v1・staging DDL v1・load package v1 を確定した成果物を生成する（DB 接続・SQL 実行なし）

**Architecture:** Phase 1〜5 と同じパターンの単一 TypeScript スクリプト (`scripts/audit-solar-260312-phase6.ts`) を実行すると `artifacts/filemaker-audit/solar/260312/phase6/` に 13 ファイルを生成する。人手入力済み CSV が未記入・欠損でも止まらず、読み取れた範囲で反映可否をレポートする。

**Tech Stack:** Node.js + tsx, csv-parse/sync, csv-stringify/sync（全て既存依存。追加インストール不要）

---

## 前提確認

### 入力ファイル (既存・読み取り専用)

| ファイル | パス | 説明 |
|---------|------|------|
| high-priority-review-packet.csv | phase5/ | 人手記入テンプレート（decision_status 等が空のまま） |
| manual-resolution-template.csv | phase5/ | manual resolution テンプレート（空のまま） |
| status-hearing-sheet.csv | phase5/ | ヒアリング回答シート（空のまま） |
| status-dictionary-candidate-v2.csv | phase4/ | Phase 4 生成の status dict |
| activity-call-union-candidate.csv | phase3/ | 97,722 件の union |
| customer-staging-v0.csv | phase3/ | 5,357 件の customer |
| deal-staging-v0.csv | phase3/ | 5,357 件の deal |
| staging-ddl-draft-v1.sql | phase4/ | Phase 4 の DDL 草案 |

### 出力ファイル (新規生成)

全て `artifacts/filemaker-audit/solar/260312/phase6/` に出力する。

| # | ファイル |
|---|---------|
| 1 | resolution-validation-report.md |
| 2 | status-dictionary-v3.csv |
| 3 | status-normalization-decision-log.md |
| 4 | activity-call-merge-policy-v1.md |
| 5 | staging-ddl-v1.sql |
| 6 | staging-load-runbook-v1.md |
| 7 | staging-load-order-v1.md |
| 8 | staging-precheck-v1.sql |
| 9 | staging-insert-draft-v1.sql |
| 10 | staging-postcheck-v1.sql |
| 11 | rollback-draft-v1.sql |
| 12 | phase6-go-no-go.md |
| 13 | phase6-summary.md |

---

## File Structure

```
scripts/audit-solar-260312-phase6.ts   # 新規作成 (主成果物)
package.json                            # 変更: audit:solar:phase6 スクリプト追加
artifacts/filemaker-audit/solar/260312/phase6/   # 新規ディレクトリ (スクリプト実行で生成)
```

---

## Task 1: `scripts/audit-solar-260312-phase6.ts` を作成する

**Files:**
- Create: `scripts/audit-solar-260312-phase6.ts`

- [ ] **Step 1: ファイルを書く (Write ツールで一括作成)**

```typescript
#!/usr/bin/env npx tsx
/**
 * Solar 監査 Phase 6 — 260312 batch
 *
 * 人手レビュー結果を反映し、status dictionary v3・merge policy v1・
 * staging DDL v1・load package v1 を確定する。
 * DB接続・SQL実行・raw編集はしない。
 *
 * 入力 (phase5/ の人手入力済みファイル):
 *   - high-priority-review-packet.csv
 *   - manual-resolution-template.csv
 *   - status-hearing-sheet.csv
 *
 * 生成物 (phase6/):
 *   1. resolution-validation-report.md
 *   2. status-dictionary-v3.csv
 *   3. status-normalization-decision-log.md
 *   4. activity-call-merge-policy-v1.md
 *   5. staging-ddl-v1.sql
 *   6. staging-load-runbook-v1.md
 *   7. staging-load-order-v1.md
 *   8. staging-precheck-v1.sql
 *   9. staging-insert-draft-v1.sql
 *   10. staging-postcheck-v1.sql
 *   11. rollback-draft-v1.sql
 *   12. phase6-go-no-go.md
 *   13. phase6-summary.md
 *
 * 実行: npm run audit:solar:phase6
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

// ─── paths ───────────────────────────────────────────────────────────
const PHASE3_DIR = resolve('artifacts/filemaker-audit/solar/260312/phase3');
const PHASE4_DIR = resolve('artifacts/filemaker-audit/solar/260312/phase4');
const PHASE5_DIR = resolve('artifacts/filemaker-audit/solar/260312/phase5');
const OUT_DIR    = resolve('artifacts/filemaker-audit/solar/260312/phase6');

const TODAY = new Date().toISOString().split('T')[0];

// ─── types ───────────────────────────────────────────────────────────
type Row = Record<string, string>;

interface HumanInputResult {
  rows: Row[];
  missing: boolean;
  filePath: string;
}

interface ValidationIssue {
  file: string;
  row_id: string;
  column: string;
  issue: string;
  severity: 'error' | 'warning' | 'info';
}

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

function readCsvSafe(filePath: string): HumanInputResult {
  if (!existsSync(filePath)) {
    return { rows: [], missing: true, filePath };
  }
  const buf = readFileSync(filePath, 'utf-8');
  const rows = parse(buf, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  }) as Row[];
  return { rows, missing: false, filePath };
}

function writeCsvFile(filePath: string, rows: Record<string, unknown>[]): void {
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

function writeSql(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf-8');
  console.log(`  -> ${basename(filePath)}`);
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Human Input Validation
// ═══════════════════════════════════════════════════════════════════════

function validateHumanInputs(
  highPriority: HumanInputResult,
  manualResolution: HumanInputResult,
  statusHearing: HumanInputResult,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const VALID_DECISION = new Set(['resolved', 'skip', 'unclear', 'defer', '']);
  const VALID_STRATEGY = new Set(['assign_all', 'assign_by_date', 'split', '']);

  // ─ high-priority-review-packet.csv ─
  if (highPriority.missing) {
    issues.push({ file: 'high-priority-review-packet.csv', row_id: '-', column: '-',
      issue: 'ファイルが見つかりません。phase5/ ディレクトリを確認してください。', severity: 'error' });
  } else {
    for (const row of highPriority.rows) {
      const id = row.review_id || '?';
      if (row.decision_status && !VALID_DECISION.has(row.decision_status)) {
        issues.push({ file: 'high-priority-review-packet.csv', row_id: id, column: 'decision_status',
          issue: `不正な値: "${row.decision_status}". 有効値: resolved/skip/unclear/defer`, severity: 'error' });
      }
      if (row.decision_status === 'resolved' && !row.chosen_customer_id) {
        issues.push({ file: 'high-priority-review-packet.csv', row_id: id, column: 'chosen_customer_id',
          issue: 'decision_status=resolved なのに chosen_customer_id が空です。', severity: 'error' });
      }
      if (row.decision_status === 'resolved' && row.chosen_customer_id) {
        const candidates = (row.candidate_customer_ids || '').split(';').map((s: string) => s.trim()).filter(Boolean);
        if (candidates.length > 0 && !candidates.includes(row.chosen_customer_id.trim())) {
          issues.push({ file: 'high-priority-review-packet.csv', row_id: id, column: 'chosen_customer_id',
            issue: `chosen_customer_id "${row.chosen_customer_id}" が candidate_customer_ids に含まれていません。`, severity: 'warning' });
        }
      }
      if (!row.decision_status) {
        issues.push({ file: 'high-priority-review-packet.csv', row_id: id, column: 'decision_status',
          issue: '未記入です。', severity: 'info' });
      }
    }
  }

  // ─ manual-resolution-template.csv ─
  if (manualResolution.missing) {
    issues.push({ file: 'manual-resolution-template.csv', row_id: '-', column: '-',
      issue: 'ファイルが見つかりません。phase5/ ディレクトリを確認してください。', severity: 'error' });
  } else {
    for (const row of manualResolution.rows) {
      const id = row.review_id || '?';
      if (row.decision_status && !VALID_DECISION.has(row.decision_status)) {
        issues.push({ file: 'manual-resolution-template.csv', row_id: id, column: 'decision_status',
          issue: `不正な値: "${row.decision_status}"`, severity: 'error' });
      }
      if (row.chosen_strategy && !VALID_STRATEGY.has(row.chosen_strategy)) {
        issues.push({ file: 'manual-resolution-template.csv', row_id: id, column: 'chosen_strategy',
          issue: `不正な値: "${row.chosen_strategy}". 有効値: assign_all/assign_by_date/split`, severity: 'error' });
      }
      if (row.decision_status === 'resolved' && !row.chosen_strategy) {
        issues.push({ file: 'manual-resolution-template.csv', row_id: id, column: 'chosen_strategy',
          issue: 'decision_status=resolved なのに chosen_strategy が空です。', severity: 'warning' });
      }
      if (row.chosen_strategy === 'assign_by_date' && !row.note) {
        issues.push({ file: 'manual-resolution-template.csv', row_id: id, column: 'note',
          issue: 'chosen_strategy=assign_by_date の場合、note に日付範囲と顧客 ID を記載してください。', severity: 'warning' });
      }
    }
  }

  // ─ status-hearing-sheet.csv ─
  if (statusHearing.missing) {
    issues.push({ file: 'status-hearing-sheet.csv', row_id: '-', column: '-',
      issue: 'ファイルが見つかりません。phase5/ ディレクトリを確認してください。', severity: 'error' });
  } else {
    for (const row of statusHearing.rows) {
      const id = row.status_value || '?';
      if (row.answer && !row.confirmed_stage) {
        issues.push({ file: 'status-hearing-sheet.csv', row_id: id, column: 'confirmed_stage',
          issue: 'answer が記入されていますが confirmed_stage が空です。', severity: 'warning' });
      }
      if (row.confirmed_stage && !row.confirmed_by) {
        issues.push({ file: 'status-hearing-sheet.csv', row_id: id, column: 'confirmed_by',
          issue: 'confirmed_stage が記入されていますが confirmed_by (確認者) が空です。', severity: 'warning' });
      }
    }
  }

  return issues;
}

function generateValidationReport(
  highPriority: HumanInputResult,
  manualResolution: HumanInputResult,
  statusHearing: HumanInputResult,
  issues: ValidationIssue[],
): void {
  const errors   = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const infos    = issues.filter((i) => i.severity === 'info');

  const resolvedCount = manualResolution.rows.filter((r) => r.decision_status === 'resolved').length;
  const skipCount     = manualResolution.rows.filter((r) => r.decision_status === 'skip').length;
  const unclearCount  = manualResolution.rows.filter((r) => r.decision_status === 'unclear').length;
  const deferCount    = manualResolution.rows.filter((r) => r.decision_status === 'defer').length;
  const emptyCount    = manualResolution.rows.filter((r) => !r.decision_status).length;
  const confirmedStatusCount = statusHearing.rows.filter((r) => r.confirmed_stage).length;

  let md = `# Resolution Validation Report — Solar 260312 Phase 6\n\n生成日: ${TODAY}\n\n---\n\n`;
  md += `## ファイル状態\n\n| ファイル | 存在 | 行数 |\n|---------|------|------|\n`;
  md += `| high-priority-review-packet.csv | ${highPriority.missing ? '❌ なし' : '✅ あり'} | ${highPriority.rows.length} |\n`;
  md += `| manual-resolution-template.csv | ${manualResolution.missing ? '❌ なし' : '✅ あり'} | ${manualResolution.rows.length} |\n`;
  md += `| status-hearing-sheet.csv | ${statusHearing.missing ? '❌ なし' : '✅ あり'} | ${statusHearing.rows.length} |\n\n`;

  md += `---\n\n## バリデーション結果\n\n| 重要度 | 件数 |\n|--------|------|\n`;
  md += `| ERROR | ${errors.length} |\n| WARNING | ${warnings.length} |\n| INFO (未記入) | ${infos.length} |\n\n`;

  if (errors.length > 0) {
    md += `### ERROR 一覧\n\n| ファイル | 行 | 列 | 内容 |\n|---------|-----|-----|------|\n`;
    for (const e of errors) md += `| ${e.file} | ${e.row_id} | ${e.column} | ${e.issue} |\n`;
    md += '\n';
  }
  if (warnings.length > 0) {
    md += `### WARNING 一覧\n\n| ファイル | 行 | 列 | 内容 |\n|---------|-----|-----|------|\n`;
    for (const w of warnings) md += `| ${w.file} | ${w.row_id} | ${w.column} | ${w.issue} |\n`;
    md += '\n';
  }
  if (infos.length > 0) {
    md += `### INFO 一覧 (未記入)\n\n| ファイル | 行 | 列 | 内容 |\n|---------|-----|-----|------|\n`;
    for (const info of infos) md += `| ${info.file} | ${info.row_id} | ${info.column} | ${info.issue} |\n`;
    md += '\n';
  }

  md += `---\n\n## Manual Resolution サマリ\n\n| decision_status | 件数 |\n|----------------|------|\n`;
  md += `| resolved | ${resolvedCount} |\n| skip | ${skipCount} |\n| unclear | ${unclearCount} |\n`;
  md += `| defer | ${deferCount} |\n| 未記入 | ${emptyCount} |\n| **合計** | **${manualResolution.rows.length}** |\n\n`;

  md += `---\n\n## Status Hearing サマリ\n\n| 項目 | 値 |\n|------|-----|\n`;
  md += `| ヒアリング対象ステータス | ${statusHearing.rows.length} 件 |\n`;
  md += `| 回答済み (confirmed_stage あり) | ${confirmedStatusCount} 件 |\n`;
  md += `| 未回答 | ${statusHearing.rows.length - confirmedStatusCount} 件 |\n\n`;

  md += `---\n\n## 反映可否判断\n\n| 項目 | 状態 | 判断 |\n|------|------|------|\n`;
  md += `| manual resolution 反映 | resolved: ${resolvedCount} 件 | ${resolvedCount > 0 ? '反映可能' : '反映対象なし'} |\n`;
  md += `| status dict v3 確定 | confirmed: ${confirmedStatusCount}/${statusHearing.rows.length} 件 | ${confirmedStatusCount > 0 ? '部分確定可能' : '全件未回答 — provisional のまま継続'} |\n`;
  md += `| ERROR 件数 | ${errors.length} 件 | ${errors.length > 0 ? '⚠️ ERROR あり。確認後に再実行可能' : '✅ ERROR なし'} |\n\n`;
  md += `> **注**: ERROR があっても Phase 6 スクリプトの実行は止まりません。\n`;
  md += `> 読み取れた範囲で反映可否をレポートし、残件は unresolved として記録します。\n`;

  writeMd(resolve(OUT_DIR, 'resolution-validation-report.md'), md);
}

// ═══════════════════════════════════════════════════════════════════════
// 2. Status Dictionary v3
// ═══════════════════════════════════════════════════════════════════════

function generateStatusDictV3(
  statusDictV2Rows: Row[],
  statusHearing: HumanInputResult,
): { resolvedCount: number; provisionalCount: number } {
  const hearingMap = new Map<string, { confirmed_stage: string; confirmed_by: string; confirmed_at: string }>();
  for (const row of statusHearing.rows) {
    if (row.status_value && row.confirmed_stage) {
      hearingMap.set(row.status_value, {
        confirmed_stage: row.confirmed_stage,
        confirmed_by: row.confirmed_by || '',
        confirmed_at: row.confirmed_at || TODAY,
      });
    }
  }

  const v3Rows: Record<string, unknown>[] = [];
  const logLines: string[] = [
    `# Status Normalization Decision Log — Solar 260312 Phase 6\n\n生成日: ${TODAY}\n\n---\n`,
    `## 変更一覧\n`,
  ];

  let resolvedCount = 0;
  let provisionalCount = 0;

  for (const row of statusDictV2Rows) {
    const hearing = hearingMap.get(row.status_value);
    let normalizedStageV3 = row.normalized_stage;
    let confidenceV3 = row.stage_confidence;
    let revisedInV3 = 'no';
    let revisionSource = '';

    if (hearing) {
      if (hearing.confirmed_stage !== row.normalized_stage) {
        normalizedStageV3 = hearing.confirmed_stage;
        logLines.push(`\n### ${row.status_value}\n- **変更**: \`${row.normalized_stage}\` → \`${hearing.confirmed_stage}\`\n- **理由**: ヒアリング確定 (確認者: ${hearing.confirmed_by})\n`);
      } else {
        logLines.push(`\n### ${row.status_value}\n- **変更なし**: \`${row.normalized_stage}\` をヒアリングで確認済み (確認者: ${hearing.confirmed_by})\n`);
      }
      confidenceV3 = 'high';
      revisedInV3 = 'yes';
      revisionSource = `ヒアリング確定 (${hearing.confirmed_by}, ${hearing.confirmed_at})`;
      resolvedCount++;
    } else if (row.stage_confidence !== 'high') {
      provisionalCount++;
      if (row.normalized_stage_v0 === 'unresolved') normalizedStageV3 = 'unresolved';
      logLines.push(`\n### ${row.status_value}\n- **未解決**: ヒアリング回答なし。provisional のまま継続。\n`);
    }

    v3Rows.push({
      status_value: row.status_value,
      count: row.count,
      percentage: row.percentage,
      sample_customer_ids: row.sample_customer_ids,
      normalized_stage_v2: row.normalized_stage,
      normalized_stage_v3: normalizedStageV3,
      stage_confidence: confidenceV3,
      revised_in_v3: revisedInV3,
      revision_source: revisionSource,
      requires_hearing: row.requires_hearing,
      impact_score: row.impact_score,
      priority_rank: row.priority_rank,
    });
  }

  logLines.push(`\n---\n\n## 件数サマリ\n\n| 区分 | 件数 |\n|------|------|\n`);
  logLines.push(`| ヒアリング確定 | ${resolvedCount} |\n| provisional (未回答) | ${provisionalCount} |\n| 変更なし (high confidence) | ${statusDictV2Rows.length - resolvedCount - provisionalCount} |\n| **合計** | **${statusDictV2Rows.length}** |\n`);

  writeCsvFile(resolve(OUT_DIR, 'status-dictionary-v3.csv'), v3Rows);
  writeMd(resolve(OUT_DIR, 'status-normalization-decision-log.md'), logLines.join('\n'));

  return { resolvedCount, provisionalCount };
}

// ═══════════════════════════════════════════════════════════════════════
// 3. Merge Policy v1
// ═══════════════════════════════════════════════════════════════════════

function generateMergePolicyV1(): void {
  const md = `# Activity Call Merge Policy v1 — Solar 260312

> **ステータス**: 確定版 (v1)
> Phase 4 草案 → Phase 5 merge simulation 比較 → Phase 6 で確定

生成日: ${TODAY}

---

## 背景と経緯

| フェーズ | 内容 |
|---------|------|
| Phase 4 草案 | 並存保持 (Keep All) を推奨方針として提示 |
| Phase 5 simulation | 3 パターンの数値比較を実施 |
| Phase 6 確定 | Pattern 2 (soft_dedupe_by_cross_source_fp) を採用 |

---

## Source 構成

| Source | File | Rows | 特徴 |
|--------|------|------|------|
| **A** | 260312_コール履歴_太陽光.xlsx | 46,572 | 独立テーブル。電話番号【検索】あり。担当者25名 |
| **B** | 260312_顧客_太陽光.csv (ポータル展開) | 51,150 | 顧客レコードに紐づく。fill-forward customer_id あり |

---

## Merge Simulation 結果

| Pattern | staging 行数 | A 保持 | B 保持 | 重複処理 | レビュー依存 |
|---------|-------------|--------|--------|---------|------------|
| keep_all | 97,722 | 46,572 | 51,150 | 0 | 0 |
| **soft_dedupe** | **93,442** | **46,572** | **46,870** | **4,280** | **3,285** |
| A_primary_B_ref | 81,261 | 46,572 | 34,689 | 16,461 | 0 |

---

## 確定方針: Pattern 2 — soft_dedupe_by_cross_source_fp

### 採用理由

1. **データ完全性を最大化** — keep_all との差は 4,280 件 (厳密重複のみ)
2. **CLAUDE.md 安全原則に準拠** — 確実な重複のみ inactive 化。不確定分は残す
3. **Ops Core 接続の柔軟性** — source_kind で A/B を区別したまま Ops Core が選択可能
4. **可逆性** — is_duplicate フラグで B 側を休眠。物理削除しない

### 重複処理方針

| 重複種別 | 件数 | 処理 |
|---------|------|------|
| 厳密一致 (date + staff + content80) | ~4,280 件 | B 側を \`is_duplicate = true\` でマーク |
| ルーズ一致 (date + staff のみ) | ~3,285 件 | staging には残す。\`review_status = 'needs_review'\` でマーク |
| A のみ | ~35,372 件 | そのまま active |
| B のみ (厳密重複除く) | ~46,870 件 | そのまま active |

### staging_activity_call への追加列 (Phase 4 草案からの変更点)

| 列名 | 型 | 説明 |
|------|-----|------|
| cross_source_fp | TEXT | date + staff + content80 の結合 fingerprint |
| is_duplicate | BOOLEAN | 厳密重複 (B 側のみ true) |
| review_status | TEXT | 'active' / 'needs_review' / 'duplicate' |

---

## 実装手順

\`\`\`
1. staging_activity_call に A + B を全件 INSERT (97,722 行)
2. cross_source_fp = date|staff|content80 を UPDATE で計算
3. 厳密一致 (A/B 双方に cross_source_fp が存在) → B 側の is_duplicate = true, review_status = 'duplicate'
4. ルーズ一致 (date + staff 一致, cross_fp 不一致) → review_status = 'needs_review'
5. それ以外 → review_status = 'active' (DEFAULT)
6. Postcheck で distribution を確認
\`\`\`

---

## 制約と注意事項

- **物理削除禁止** — B 側の厳密重複は is_duplicate フラグで管理。DELETE しない
- **manual_resolved 行は変更しない** — match_type = 'manual_resolved' の行は重複処理の対象外
- **raw 情報は変更禁止** — source_fingerprint, raw_source_file, raw_row_origin は変更しない
- **可逆性の確保** — is_duplicate = false に戻せば完全復元可能

---

## Unresolved 事項

| # | 事項 | 影響 |
|---|------|------|
| 1 | Source A/B が同一 DB の別エクスポートであることの最終確認 | ルーズ一致の解釈 |
| 2 | ルーズ一致 ~3,285 件の最終処置 (needs_review のまま or inactive 化) | staging 行数 |
`;

  writeMd(resolve(OUT_DIR, 'activity-call-merge-policy-v1.md'), md);
}

// ═══════════════════════════════════════════════════════════════════════
// 4. Staging DDL v1 (確定版)
// ═══════════════════════════════════════════════════════════════════════

function generateDdlV1(): void {
  const sql = `-- staging-ddl-v1.sql — Solar 260312
-- ステータス: 確定版 (v1)
-- Phase 4 草案 → Phase 6 で確定 (PK/UNIQUE/index/CHECK 制約を確定)
-- NOTE: 実行禁止。Supabase 接続禁止。
-- NOTE: このファイルは dry-run 相当の SQL です。

-- ═══════════════════════════════════════════════════════════════
-- staging_customer
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_customer (
  customer_id               TEXT NOT NULL PRIMARY KEY,
  furigana                  TEXT,
  address                   TEXT,
  postal_code               TEXT,
  phone                     TEXT,
  phone_search              TEXT,
  fax                       TEXT,
  email                     TEXT,
  representative_furigana   TEXT,
  representative_mobile     TEXT,
  representative_birthday   DATE,
  contact_furigana          TEXT,
  contact_mobile            TEXT,
  emergency_contact         TEXT,
  occupation                TEXT,
  industry_subclass         TEXT,
  fm_password               TEXT,
  fm_username               TEXT,
  invoice_registration      TEXT,
  application_id            TEXT,
  contact_info              TEXT,
  preferred_contact_time    TEXT,
  raw_source_file           TEXT NOT NULL,
  raw_row_origin            INTEGER NOT NULL,
  source_fingerprint        TEXT NOT NULL UNIQUE,
  _loaded_at                TIMESTAMPTZ DEFAULT now(),
  _batch_id                 TEXT DEFAULT '260312',
  _schema_version           TEXT DEFAULT 'v1'
);

CREATE INDEX IF NOT EXISTS idx_staging_customer_phone         ON staging_customer (phone);
CREATE INDEX IF NOT EXISTS idx_staging_customer_phone_search  ON staging_customer (phone_search);
CREATE INDEX IF NOT EXISTS idx_staging_customer_fingerprint   ON staging_customer (source_fingerprint);

-- ═══════════════════════════════════════════════════════════════
-- staging_deal
-- NOTE: customer/deal の 1:1 vs 1:N はヒアリング未確定のため FK は省略。
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_deal (
  deal_id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id                    TEXT NOT NULL,
  status                         TEXT,
  status_normalized              TEXT,
  cancel_flag                    TEXT,
  cancel_date                    DATE,
  cancel_reason                  TEXT,
  estimate_maker                 TEXT,
  estimate_request_date          DATE,
  estimate_arrival_date          DATE,
  estimate_note                  TEXT,
  fit_approval_date              DATE,
  fit_application_date           DATE,
  maker                          TEXT,
  module                         TEXT,
  installed_kw                   NUMERIC(10,3),
  installation_store             TEXT,
  installation_address           TEXT,
  installation_phone             TEXT,
  installation_fax               TEXT,
  building_age                   INTEGER,
  order_date                     DATE,
  estimate_request_date_2        DATE,
  estimate_arrival_date_2        DATE,
  site_survey_date               DATE,
  applicant                      TEXT,
  application_send_date          DATE,
  lease_certificate_send         DATE,
  consent_send                   DATE,
  contractor                     TEXT,
  contractor_relationship        TEXT,
  user_relationship              TEXT,
  monthly_amount                 NUMERIC(15,2),
  lease_fee                      NUMERIC(15,2),
  credit_company                 TEXT,
  credit_request_date            DATE,
  credit_result                  TEXT,
  credit_result_date             DATE,
  credit_company_2               TEXT,
  power_application_date         DATE,
  power_approval_date            DATE,
  drone_survey_date              DATE,
  construction_request           TEXT,
  construction_request_2         TEXT,
  construction_date              DATE,
  construction_complete_date     DATE,
  revisit_date                   DATE,
  completion_report              DATE,
  confirmation_complete_date     DATE,
  report_arrival_date            DATE,
  floor_plan_arrival             DATE,
  warranty_application           DATE,
  warranty_arrival               DATE,
  disaster_insurance_application DATE,
  disaster_insurance_arrival     DATE,
  invoice_date                   DATE,
  invoice_date_2                 DATE,
  payment_date                   DATE,
  payment_date_2                 DATE,
  delivery_date                  DATE,
  order_placement_date           DATE,
  accounting_month               TEXT,
  accounting_date                DATE,
  gross_profit                   NUMERIC(15,2),
  service_item_count             INTEGER,
  service_item_price             NUMERIC(15,2),
  service_item_cost              NUMERIC(15,2),
  service_item_delivery          DATE,
  material                       TEXT,
  material_count                 INTEGER,
  material_unit_price            NUMERIC(15,2),
  material_cost                  NUMERIC(15,2),
  material_name                  TEXT,
  construction_management        TEXT,
  sales_channel                  TEXT,
  sales_store                    TEXT,
  slip_number                    TEXT,
  additional_construction        TEXT,
  required_documents             TEXT,
  required_documents_date        DATE,
  note                           TEXT,
  caution                        TEXT,
  sheet_count                    INTEGER,
  mail_date                      DATE,
  grid_connection_date           DATE,
  appointment_staff              TEXT,
  sales_staff                    TEXT,
  sales_comment                  TEXT,
  visit_count                    INTEGER,
  visit_staff                    TEXT,
  raw_source_file                TEXT NOT NULL,
  raw_row_origin                 INTEGER NOT NULL,
  source_fingerprint             TEXT NOT NULL UNIQUE,
  _loaded_at                     TIMESTAMPTZ DEFAULT now(),
  _batch_id                      TEXT DEFAULT '260312',
  _schema_version                TEXT DEFAULT 'v1'
);

CREATE INDEX IF NOT EXISTS idx_staging_deal_customer_id  ON staging_deal (customer_id);
CREATE INDEX IF NOT EXISTS idx_staging_deal_status       ON staging_deal (status);
CREATE INDEX IF NOT EXISTS idx_staging_deal_fingerprint  ON staging_deal (source_fingerprint);

-- ═══════════════════════════════════════════════════════════════
-- staging_activity_call
-- merge policy v1: cross_source_fp / is_duplicate / review_status を追加
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_activity_call (
  activity_call_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_kind                   TEXT NOT NULL CHECK (source_kind IN ('source_a', 'source_b')),
  call_date                     DATE,
  call_time                     TIME,
  call_staff                    TEXT,
  content                       TEXT,
  customer_staff                TEXT,
  raw_phone                     TEXT,
  normalized_phone              TEXT,
  matched_customer_id           TEXT,
  matched_customer_candidate_count INTEGER,
  match_type                    TEXT,
  fill_forward_customer_id      TEXT,
  cross_source_fp               TEXT,
  is_duplicate                  BOOLEAN DEFAULT FALSE,
  review_status                 TEXT DEFAULT 'active'
                                  CHECK (review_status IN ('active', 'needs_review', 'duplicate')),
  raw_source_file               TEXT NOT NULL,
  raw_row_origin                INTEGER NOT NULL,
  source_fingerprint            TEXT NOT NULL,
  _loaded_at                    TIMESTAMPTZ DEFAULT now(),
  _batch_id                     TEXT DEFAULT '260312',
  _schema_version               TEXT DEFAULT 'v1'
);

CREATE INDEX IF NOT EXISTS idx_staging_activity_call_source      ON staging_activity_call (source_kind);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_date        ON staging_activity_call (call_date);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_phone       ON staging_activity_call (normalized_phone);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_matched     ON staging_activity_call (matched_customer_id);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_fingerprint ON staging_activity_call (source_fingerprint);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_cross_fp    ON staging_activity_call (cross_source_fp);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_review      ON staging_activity_call (review_status);

-- ═══════════════════════════════════════════════════════════════
-- staging_rejected_rows
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_rejected_rows (
  rejected_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity            TEXT NOT NULL,
  reject_reason     TEXT NOT NULL,
  raw_source_file   TEXT NOT NULL,
  raw_row_origin    INTEGER NOT NULL,
  source_fingerprint TEXT NOT NULL,
  raw_data_json     JSONB,
  _rejected_at      TIMESTAMPTZ DEFAULT now(),
  _batch_id         TEXT DEFAULT '260312'
);

-- ═══════════════════════════════════════════════════════════════
-- staging_load_log
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_load_log (
  log_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity        TEXT NOT NULL,
  action        TEXT NOT NULL,
  row_count     INTEGER,
  started_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ,
  status        TEXT NOT NULL CHECK (status IN ('success', 'error', 'rollback')),
  error_message TEXT,
  _batch_id     TEXT DEFAULT '260312'
);
`;

  writeSql(resolve(OUT_DIR, 'staging-ddl-v1.sql'), sql);
}

// ═══════════════════════════════════════════════════════════════════════
// 5. Precheck v1
// ═══════════════════════════════════════════════════════════════════════

function generatePrecheckV1(): void {
  const sql = `-- staging-precheck-v1.sql — Solar 260312
-- 実行前の事前チェック。
-- NOTE: 実行禁止。DB 接続禁止。dry-run 相当。

-- 1. staging テーブルの存在確認
SELECT table_name,
       (SELECT count(*) FROM information_schema.columns
        WHERE table_name = t.table_name AND table_schema = 'public') AS column_count
FROM information_schema.tables t
WHERE table_schema = 'public'
  AND table_name IN (
    'staging_customer', 'staging_deal', 'staging_activity_call',
    'staging_rejected_rows', 'staging_load_log'
  )
ORDER BY table_name;

-- 2. 既存データ確認 (re-run 判定用)
SELECT 'staging_customer'      AS tbl, count(*) AS row_count FROM staging_customer
UNION ALL
SELECT 'staging_deal',                  count(*) FROM staging_deal
UNION ALL
SELECT 'staging_activity_call',         count(*) FROM staging_activity_call
UNION ALL
SELECT 'staging_rejected_rows',         count(*) FROM staging_rejected_rows;

-- 3. 制約の確認
SELECT conname, conrelid::regclass, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid::regclass::text IN (
  'staging_customer', 'staging_deal', 'staging_activity_call'
)
ORDER BY conrelid::regclass, contype;

-- 4. disk space 概算
SELECT relname,
       pg_size_pretty(pg_total_relation_size(oid)) AS total_size
FROM pg_class
WHERE relname IN (
  'staging_customer', 'staging_deal', 'staging_activity_call',
  'staging_rejected_rows', 'staging_load_log'
)
ORDER BY pg_total_relation_size(oid) DESC;

-- 5. 事前確認事項 (手動確認):
--   customer-staging-v0.csv:         5,357 rows
--   deal-staging-v0.csv:             5,357 rows
--   activity-call-union-candidate.csv: 97,722 rows
`;

  writeSql(resolve(OUT_DIR, 'staging-precheck-v1.sql'), sql);
}

// ═══════════════════════════════════════════════════════════════════════
// 6. Insert Draft v1
// ═══════════════════════════════════════════════════════════════════════

function generateInsertDraft(manualResolution: HumanInputResult): void {
  const resolvedRows = manualResolution.rows.filter(
    (r) => r.decision_status === 'resolved' && r.chosen_customer_id && r.chosen_strategy === 'assign_all',
  );

  const updateStatements = resolvedRows.length > 0
    ? resolvedRows.map((r) =>
        `-- ${r.review_id}: ${r.normalized_phone} → ${r.chosen_customer_id}\n` +
        `UPDATE staging_activity_call\n` +
        `SET matched_customer_id = '${r.chosen_customer_id.replace(/'/g, "''")}',\n` +
        `    matched_customer_candidate_count = 1,\n` +
        `    match_type = 'manual_resolved'\n` +
        `WHERE normalized_phone = '${r.normalized_phone.replace(/'/g, "''")}'\n` +
        `  AND source_kind = 'source_a'\n` +
        `  AND match_type = 'multi_match';\n`
      ).join('\n')
    : '-- resolved な manual resolution がありません。\n-- manual-resolution-template.csv を記入後に再実行してください。\n';

  const sql = `-- staging-insert-draft-v1.sql — Solar 260312
-- ステータス: dry-run 相当 (実行禁止)
-- NOTE: Supabase 接続禁止。SQL 実行禁止。
-- NOTE: このファイルは draft です。実際の DB 実行は次フェーズ以降。

-- ═══════════════════════════════════════════════════════════════
-- Step 0: BEGIN TRANSACTION
-- ═══════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════
-- Step 1: TRUNCATE (idempotent re-run)
-- ═══════════════════════════════════════════════════════════════

TRUNCATE staging_activity_call;
TRUNCATE staging_deal;
TRUNCATE staging_customer;

INSERT INTO staging_load_log (entity, action, row_count, started_at, status, _batch_id)
VALUES ('all', 'truncate', NULL, now(), 'success', '260312');

-- ═══════════════════════════════════════════════════════════════
-- Step 2: LOAD staging_customer (5,357 rows)
-- ═══════════════════════════════════════════════════════════════

\\COPY staging_customer (
  customer_id, furigana, address, postal_code, phone, phone_search,
  fax, email, representative_furigana, representative_mobile,
  representative_birthday, contact_furigana, contact_mobile,
  emergency_contact, occupation, industry_subclass,
  fm_password, fm_username, invoice_registration, application_id,
  contact_info, preferred_contact_time,
  raw_source_file, raw_row_origin, source_fingerprint
) FROM 'artifacts/filemaker-audit/solar/260312/phase3/customer-staging-v0.csv'
WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

INSERT INTO staging_load_log (entity, action, row_count, started_at, status, _batch_id)
SELECT 'staging_customer', 'copy', count(*), now(), 'success', '260312' FROM staging_customer;

-- ═══════════════════════════════════════════════════════════════
-- Step 3: LOAD staging_deal (5,357 rows)
-- ═══════════════════════════════════════════════════════════════

\\COPY staging_deal (
  customer_id, status, cancel_flag, cancel_date, cancel_reason,
  estimate_maker, estimate_request_date, estimate_arrival_date, estimate_note,
  fit_approval_date, fit_application_date, maker, module, installed_kw,
  installation_store, installation_address, installation_phone, installation_fax,
  building_age, order_date, estimate_request_date_2, estimate_arrival_date_2,
  site_survey_date, applicant, application_send_date, lease_certificate_send,
  consent_send, contractor, contractor_relationship, user_relationship,
  monthly_amount, lease_fee, credit_company, credit_request_date, credit_result,
  credit_result_date, credit_company_2, power_application_date, power_approval_date,
  drone_survey_date, construction_request, construction_request_2, construction_date,
  construction_complete_date, revisit_date, completion_report,
  confirmation_complete_date, report_arrival_date, floor_plan_arrival,
  warranty_application, warranty_arrival, disaster_insurance_application,
  disaster_insurance_arrival, invoice_date, invoice_date_2, payment_date,
  payment_date_2, delivery_date, order_placement_date, accounting_month,
  accounting_date, gross_profit, service_item_count, service_item_price,
  service_item_cost, service_item_delivery, material, material_count,
  material_unit_price, material_cost, material_name, construction_management,
  sales_channel, sales_store, slip_number, additional_construction,
  required_documents, required_documents_date, note, caution, sheet_count,
  mail_date, grid_connection_date, appointment_staff, sales_staff, sales_comment,
  visit_count, visit_staff, raw_source_file, raw_row_origin, source_fingerprint
) FROM 'artifacts/filemaker-audit/solar/260312/phase3/deal-staging-v0.csv'
WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

INSERT INTO staging_load_log (entity, action, row_count, started_at, status, _batch_id)
SELECT 'staging_deal', 'copy', count(*), now(), 'success', '260312' FROM staging_deal;

-- ═══════════════════════════════════════════════════════════════
-- Step 4: LOAD staging_activity_call (97,722 rows)
-- ═══════════════════════════════════════════════════════════════

\\COPY staging_activity_call (
  source_kind, call_date, call_time, call_staff, content, customer_staff,
  raw_phone, normalized_phone,
  matched_customer_id, matched_customer_candidate_count, match_type,
  fill_forward_customer_id,
  raw_source_file, raw_row_origin, source_fingerprint
) FROM 'artifacts/filemaker-audit/solar/260312/phase3/activity-call-union-candidate.csv'
WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

INSERT INTO staging_load_log (entity, action, row_count, started_at, status, _batch_id)
SELECT 'staging_activity_call', 'copy', count(*), now(), 'success', '260312' FROM staging_activity_call;

-- ═══════════════════════════════════════════════════════════════
-- Step 5: soft_dedupe — cross_source_fp 計算 + is_duplicate / review_status 付与
-- ═══════════════════════════════════════════════════════════════

UPDATE staging_activity_call
SET cross_source_fp = concat_ws('|',
  to_char(call_date, 'YYYY-MM-DD'),
  call_staff,
  left(content, 80)
)
WHERE call_date IS NOT NULL;

-- 厳密重複: B 側で A 側と cross_source_fp が完全一致する行
UPDATE staging_activity_call AS b
SET is_duplicate  = TRUE,
    review_status = 'duplicate'
WHERE b.source_kind = 'source_b'
  AND b.cross_source_fp IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM staging_activity_call a
    WHERE a.source_kind = 'source_a'
      AND a.cross_source_fp = b.cross_source_fp
  );

-- ルーズ一致: date + staff が一致するが cross_source_fp が異なる B 行
UPDATE staging_activity_call AS b
SET review_status = 'needs_review'
WHERE b.source_kind = 'source_b'
  AND b.review_status = 'active'
  AND EXISTS (
    SELECT 1 FROM staging_activity_call a
    WHERE a.source_kind = 'source_a'
      AND a.call_date  = b.call_date
      AND a.call_staff = b.call_staff
      AND (a.cross_source_fp IS DISTINCT FROM b.cross_source_fp)
  );

INSERT INTO staging_load_log (entity, action, row_count, started_at, status, _batch_id)
SELECT 'staging_activity_call', 'soft_dedupe',
       count(*) FILTER (WHERE is_duplicate = TRUE), now(), 'success', '260312'
FROM staging_activity_call;

-- ═══════════════════════════════════════════════════════════════
-- Step 6: manual resolution 反映 (${resolvedRows.length} 件)
-- ═══════════════════════════════════════════════════════════════

${updateStatements}

-- ═══════════════════════════════════════════════════════════════
-- Step 7: status_normalized を deal に付与
-- (status-dictionary-v3.csv を一時テーブル経由で適用)
-- ═══════════════════════════════════════════════════════════════

CREATE TEMP TABLE IF NOT EXISTS _status_norm_v3 (status_value TEXT, normalized_stage_v3 TEXT);
-- \\COPY _status_norm_v3 (status_value, normalized_stage_v3)
--   FROM 'artifacts/filemaker-audit/solar/260312/phase6/status-dictionary-v3.csv'
--   WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

UPDATE staging_deal d
SET status_normalized = n.normalized_stage_v3
FROM _status_norm_v3 n
WHERE d.status = n.status_value;

DROP TABLE IF EXISTS _status_norm_v3;

-- ═══════════════════════════════════════════════════════════════
-- Step 8: COMMIT
-- ═══════════════════════════════════════════════════════════════

COMMIT;
`;

  writeSql(resolve(OUT_DIR, 'staging-insert-draft-v1.sql'), sql);
}

// ═══════════════════════════════════════════════════════════════════════
// 7. Postcheck v1
// ═══════════════════════════════════════════════════════════════════════

function generatePostcheckV1(): void {
  const sql = `-- staging-postcheck-v1.sql — Solar 260312
-- 投入後の整合性チェック。
-- NOTE: 実行禁止。DB 接続禁止。

-- 1. Row count validation
SELECT 'staging_customer' AS entity, count(*) AS actual_rows, 5357 AS expected_rows,
       CASE WHEN count(*) = 5357 THEN 'OK' ELSE 'MISMATCH' END AS status
FROM staging_customer
UNION ALL
SELECT 'staging_deal', count(*), 5357,
       CASE WHEN count(*) = 5357 THEN 'OK' ELSE 'MISMATCH' END
FROM staging_deal
UNION ALL
SELECT 'staging_activity_call', count(*), 97722,
       CASE WHEN count(*) = 97722 THEN 'OK' ELSE 'MISMATCH' END
FROM staging_activity_call;

-- 2. NOT NULL check
SELECT 'customer_null_id' AS check_name, count(*) AS violation_count
FROM staging_customer WHERE customer_id IS NULL OR customer_id = ''
UNION ALL
SELECT 'deal_null_customer_id', count(*)
FROM staging_deal WHERE customer_id IS NULL OR customer_id = ''
UNION ALL
SELECT 'activity_null_source_kind', count(*)
FROM staging_activity_call WHERE source_kind IS NULL OR source_kind = '';

-- 3. Uniqueness check
SELECT 'customer_id_duplicates' AS check_name, count(*) AS duplicate_count
FROM (
  SELECT customer_id FROM staging_customer GROUP BY customer_id HAVING count(*) > 1
) d
UNION ALL
SELECT 'fingerprint_duplicates_customer', count(*)
FROM (
  SELECT source_fingerprint FROM staging_customer GROUP BY source_fingerprint HAVING count(*) > 1
) d
UNION ALL
SELECT 'fingerprint_duplicates_deal', count(*)
FROM (
  SELECT source_fingerprint FROM staging_deal GROUP BY source_fingerprint HAVING count(*) > 1
) d;

-- 4. Referential integrity
SELECT 'deal_orphan_customer_id' AS check_name, count(*) AS orphan_count
FROM staging_deal d WHERE NOT EXISTS (
  SELECT 1 FROM staging_customer c WHERE c.customer_id = d.customer_id
)
UNION ALL
SELECT 'activity_orphan_matched_id', count(*)
FROM staging_activity_call a
WHERE a.matched_customer_id IS NOT NULL AND a.matched_customer_id != ''
  AND NOT EXISTS (
    SELECT 1 FROM staging_customer c WHERE c.customer_id = a.matched_customer_id
  );

-- 5. source_kind distribution
SELECT source_kind, count(*) AS row_count,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM staging_activity_call GROUP BY source_kind ORDER BY source_kind;

-- 6. match_type distribution
SELECT match_type, count(*) AS row_count,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM staging_activity_call GROUP BY match_type ORDER BY row_count DESC;

-- 7. review_status distribution (soft_dedupe 結果)
SELECT review_status, count(*) AS row_count,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM staging_activity_call GROUP BY review_status ORDER BY row_count DESC;

-- 8. Status distribution (deal)
SELECT status, status_normalized, count(*) AS row_count,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM staging_deal WHERE status IS NOT NULL AND status != ''
GROUP BY status, status_normalized ORDER BY row_count DESC;

-- 9. Load log summary
SELECT entity, action, row_count, started_at, status
FROM staging_load_log WHERE _batch_id = '260312' ORDER BY log_id;

-- 10. Complete
SELECT 'post_check_v1_complete' AS status, now() AS checked_at;
`;

  writeSql(resolve(OUT_DIR, 'staging-postcheck-v1.sql'), sql);
}

// ═══════════════════════════════════════════════════════════════════════
// 8. Rollback Draft v1
// ═══════════════════════════════════════════════════════════════════════

function generateRollback(manualResolution: HumanInputResult): void {
  const resolvedRows = manualResolution.rows.filter(
    (r) => r.decision_status === 'resolved' && r.chosen_customer_id && r.chosen_strategy === 'assign_all',
  );

  const rollbackUpdates = resolvedRows.length > 0
    ? resolvedRows.map((r) =>
        `-- ${r.review_id}: ${r.normalized_phone} の manual_resolved を元に戻す\n` +
        `UPDATE staging_activity_call\n` +
        `SET match_type = 'multi_match',\n` +
        `    matched_customer_id = NULL,\n` +
        `    matched_customer_candidate_count = ${r.candidate_count || 2}\n` +
        `WHERE normalized_phone = '${r.normalized_phone.replace(/'/g, "''")}'\n` +
        `  AND source_kind = 'source_a'\n` +
        `  AND match_type = 'manual_resolved';\n`
      ).join('\n')
    : '-- resolved な manual resolution がないため、この Option は不要です。\n';

  const sql = `-- rollback-draft-v1.sql — Solar 260312
-- ステータス: dry-run 相当 (実行禁止)
-- NOTE: Supabase 接続禁止。SQL 実行禁止。
-- 3 つの Option から状況に応じて選択して実行する。

-- ═══════════════════════════════════════════════════════════════
-- Option A: 完全ロールバック (TRUNCATE で全件クリア)
-- ═══════════════════════════════════════════════════════════════

BEGIN;
TRUNCATE staging_activity_call;
TRUNCATE staging_deal;
TRUNCATE staging_customer;
TRUNCATE staging_rejected_rows;
INSERT INTO staging_load_log (entity, action, row_count, started_at, status, _batch_id)
VALUES ('all', 'rollback_truncate', 0, now(), 'rollback', '260312');
COMMIT;

-- ═══════════════════════════════════════════════════════════════
-- Option B: soft_dedupe のみ元に戻す
-- ═══════════════════════════════════════════════════════════════

BEGIN;
UPDATE staging_activity_call
SET is_duplicate  = FALSE,
    review_status = 'active',
    cross_source_fp = NULL
WHERE is_duplicate = TRUE OR review_status IN ('needs_review', 'duplicate');
INSERT INTO staging_load_log (entity, action, row_count, started_at, status, _batch_id)
VALUES ('staging_activity_call', 'rollback_soft_dedupe', NULL, now(), 'rollback', '260312');
COMMIT;

-- ═══════════════════════════════════════════════════════════════
-- Option C: manual resolution のみ元に戻す (${resolvedRows.length} 件)
-- ═══════════════════════════════════════════════════════════════

BEGIN;
${rollbackUpdates}
INSERT INTO staging_load_log (entity, action, row_count, started_at, status, _batch_id)
VALUES ('staging_activity_call', 'rollback_manual_resolution', NULL, now(), 'rollback', '260312');
COMMIT;
`;

  writeSql(resolve(OUT_DIR, 'rollback-draft-v1.sql'), sql);
}

// ═══════════════════════════════════════════════════════════════════════
// 9. Runbook + Load Order
// ═══════════════════════════════════════════════════════════════════════

function generateRunbook(resolvedCount: number): void {
  const md = `# Staging Load Runbook v1 — Solar 260312

> **ステータス**: dry-run 相当 (DB 実行禁止)
> **次フェーズで実行予定**: Phase 7 (Supabase 接続 → DDL → INSERT → postcheck)

生成日: ${TODAY}

---

## 前提条件

- [ ] Phase 6 の全成果物が生成済み
- [ ] phase6-go-no-go.md の判定を確認
- [ ] Supabase プロジェクトの接続情報 (\`DATABASE_URL\`) が確保されている
- [ ] staging 用 schema が決定済み (推奨: \`public\` または \`solar_260312\`)

---

## Load 手順

### Step 0: precheck

\`\`\`bash
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-precheck-v1.sql
\`\`\`

確認事項:
- テーブルが存在しない場合 → Step 1 へ
- 既存データがある場合 → re-run (TRUNCATE) 方針を確認

### Step 1: DDL 実行

\`\`\`bash
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-ddl-v1.sql
\`\`\`

確認事項: ERROR なしで 5 テーブルが作成されること

### Step 2: staging INSERT

\`\`\`bash
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-insert-draft-v1.sql
\`\`\`

確認事項:
- customer: 5,357 行
- deal: 5,357 行
- activity_call: 97,722 行 (soft_dedupe 後の is_duplicate / review_status 分布を確認)

### Step 3: postcheck

\`\`\`bash
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-postcheck-v1.sql
\`\`\`

確認事項:
- row count が期待値と一致
- NOT NULL violation: 0 件
- customer_id_duplicates: 0 件

### Step 4: ロールバック (必要な場合)

\`\`\`bash
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/rollback-draft-v1.sql
\`\`\`

Option A: 完全 TRUNCATE / Option B: soft_dedupe のみ / Option C: manual resolution のみ

---

## manual resolution 反映サマリ

| 区分 | 件数 |
|------|------|
| resolved (staging-insert-draft に反映済み) | ${resolvedCount} 件 |

${resolvedCount === 0 ? '> **注**: manual-resolution-template.csv が未記入です。記入後に `npm run audit:solar:phase6` を再実行してください。' : ''}

---

## 注意事項

1. **DB 実行禁止** — Phase 6 では Supabase 接続・SQL 実行をしない
2. **raw 編集禁止** — phase3/ の CSV は read-only
3. **pbg-operations-core 非対象** — production テーブルには触れない
4. **idempotent** — 同じ手順を何度実行しても安全 (TRUNCATE → INSERT)

---

## 再生成コマンド

\`\`\`bash
npm run audit:solar:phase6
\`\`\`
`;

  writeMd(resolve(OUT_DIR, 'staging-load-runbook-v1.md'), md);
}

function generateLoadOrder(resolvedCount: number): void {
  const md = `# Staging Load Order v1 — Solar 260312

> **ステータス**: 確定版 (v1)。DB 実行はしない。

生成日: ${TODAY}

---

## Load Sequence

\`\`\`
Step 0: Pre-check (staging-precheck-v1.sql)
  ↓
Step 1: CREATE TABLE (staging-ddl-v1.sql) — 5 テーブル
  ↓
Step 2: LOAD staging_customer (5,357 rows)
  ├─ Source: phase3/customer-staging-v0.csv
  ├─ Method: \\COPY FROM CSV
  └─ Validation: customer_id NOT NULL + UNIQUE
  ↓
Step 3: LOAD staging_deal (5,357 rows)
  ├─ Source: phase3/deal-staging-v0.csv
  ├─ Method: \\COPY FROM CSV
  └─ FK check: customer_id (warning only)
  ↓
Step 4: LOAD staging_activity_call (97,722 rows)
  ├─ Source: phase3/activity-call-union-candidate.csv
  └─ Validation: source_kind IN ('source_a', 'source_b')
  ↓
Step 5: soft_dedupe
  ├─ cross_source_fp = date|staff|content80 を UPDATE
  ├─ 厳密重複 (~4,280 件) → B 側 is_duplicate=true, review_status='duplicate'
  └─ ルーズ一致 (~3,285 件) → review_status='needs_review'
  ↓
Step 6: manual resolution 反映 (${resolvedCount} 件)
  └─ match_type='manual_resolved' で matched_customer_id を確定
  ↓
Step 7: status_normalized 付与 (staging_deal)
  └─ status-dictionary-v3.csv の normalized_stage_v3 を適用
  ↓
Step 8: Post-check (staging-postcheck-v1.sql)
\`\`\`

---

## 期待値

| Entity | 行数 | 確認列 |
|--------|------|--------|
| staging_customer | 5,357 | customer_id (PK, UNIQUE) |
| staging_deal | 5,357 | deal_id (PK), customer_id NOT NULL |
| staging_activity_call | 97,722 | source_kind, is_duplicate, review_status |

---

## Re-run 手順 (idempotent)

\`\`\`sql
BEGIN;
TRUNCATE staging_activity_call;
TRUNCATE staging_deal;
TRUNCATE staging_customer;
-- Step 2 以降を再実行
COMMIT;
\`\`\`
`;

  writeMd(resolve(OUT_DIR, 'staging-load-order-v1.md'), md);
}

// ═══════════════════════════════════════════════════════════════════════
// 10. Go/No-Go
// ═══════════════════════════════════════════════════════════════════════

function generateGoNoGo(
  issues: ValidationIssue[],
  resolvedCount: number,
  confirmedStatusCount: number,
  totalStatusCount: number,
  highPriority: HumanInputResult,
  manualResolution: HumanInputResult,
): void {
  const errors = issues.filter((i) => i.severity === 'error');
  const missingFiles = [highPriority, manualResolution]
    .filter((r) => r.missing)
    .map((r) => basename(r.filePath));

  const hasBlockers = missingFiles.length > 0;
  const goOrNoGo = hasBlockers ? 'NO-GO' : 'CONDITIONAL-GO';
  const verdict = hasBlockers
    ? `🔴 NO-GO — 必須ファイルが見つかりません: ${missingFiles.join(', ')}。人手レビューを完了してから再実行してください。`
    : resolvedCount === 0 && confirmedStatusCount === 0
    ? '🟡 CONDITIONAL-GO — 人手入力がまだありません。DDL / load package は生成済みです。DB 実行前に人手レビューを完了することを推奨します。'
    : '🟡 CONDITIONAL-GO — 一部の human input が反映されました。残ブロッカーを確認してから DB 実行に進んでください。';

  const highFilledCount = highPriority.rows.filter((r) => r.decision_status).length;

  const md = `# Phase 6 Go/No-Go 判定 — Solar 260312

生成日: ${TODAY}

---

## 総合判定: ${goOrNoGo}

${verdict}

---

## チェック項目

### 今回生成した成果物

| 成果物 | 状態 |
|--------|------|
| resolution-validation-report.md | ✅ 生成済み |
| status-dictionary-v3.csv | ✅ 生成済み |
| status-normalization-decision-log.md | ✅ 生成済み |
| activity-call-merge-policy-v1.md | ✅ 生成済み |
| staging-ddl-v1.sql | ✅ 生成済み |
| staging-load-runbook-v1.md | ✅ 生成済み |
| staging-load-order-v1.md | ✅ 生成済み |
| staging-precheck-v1.sql | ✅ 生成済み |
| staging-insert-draft-v1.sql | ✅ 生成済み |
| staging-postcheck-v1.sql | ✅ 生成済み |
| rollback-draft-v1.sql | ✅ 生成済み |

### 人手レビュー反映状況

| 区分 | 状態 |
|------|------|
| high-priority-review-packet 記入 | ${highPriority.missing ? '❌ ファイルなし' : `${highFilledCount}/${highPriority.rows.length} 件記入済み`} |
| manual resolution (resolved) | ${resolvedCount} 件 → staging-insert-draft に反映 |
| status hearing 確定 | ${confirmedStatusCount}/${totalStatusCount} 件 |

### Validation ERROR

| 件数 | 状態 |
|------|------|
| ${errors.length} 件 | ${errors.length === 0 ? '✅ なし' : '⚠️ あり (詳細は resolution-validation-report.md)'} |

---

## 今すぐ staging load してよいか？

**${hasBlockers ? 'NO — 残ブロッカーあり' : '推奨しない — 人手レビューを完了してから'}**

理由:
- DB 実行 (DDL / INSERT) は Phase 7 以降のタスク
- 今回は dry-run 相当の SQL / package 生成まで

---

## 残ブロッカー (Phase 7 進行前に必要なもの)

| # | ブロッカー | 重要度 | 確認先 |
|---|-----------|--------|--------|
| 1 | high-priority-review-packet.csv の全件記入 | 必須 | 現場担当者 |
| 2 | manual-resolution-template.csv の全件記入 | 必須 | 現場担当者 |
| 3 | status-hearing-sheet.csv の回答記入 | 推奨 | 業務担当者 |
| 4 | Supabase 接続情報 (DATABASE_URL) の確保 | 必須 | 開発チーム |
| 5 | staging schema の決定 | 必須 | 開発チーム |
| 6 | Source A/B 同一 DB 確認 | 推奨 | FileMaker 管理者 |
| 7 | customer/deal 1:1 vs 1:N の確認 | 推奨 | 業務担当者 |

---

## 次のステップ

1. 現場が human input CSV を記入する
2. \`npm run audit:solar:phase6\` を再実行する
3. go-no-go の判定が GREEN になる
4. Phase 7: Supabase 接続 → DDL → staging INSERT → postcheck
`;

  writeMd(resolve(OUT_DIR, 'phase6-go-no-go.md'), md);
}

// ═══════════════════════════════════════════════════════════════════════
// 11. Phase 6 Summary
// ═══════════════════════════════════════════════════════════════════════

function generatePhase6Summary(
  issues: ValidationIssue[],
  resolvedCount: number,
  confirmedStatusCount: number,
  totalStatusCount: number,
): void {
  const errors   = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  const md = `# Phase 6 Summary — Solar 260312

生成日: ${TODAY}

---

## 概要

Phase 6 は人手レビュー結果の反映・status dictionary v3 確定・merge policy v1 確定・
staging DDL v1 確定・load package v1 生成を行った。
DB 接続・SQL 実行はしていない。

---

## 変更概要

1. **人手入力 CSV を ingest し、validation report を生成**
2. **manual resolution を staging insert draft に反映** (resolved: ${resolvedCount} 件)
3. **status dictionary v3 を生成** (確定: ${confirmedStatusCount}/${totalStatusCount} 件)
4. **merge policy v1 を確定** (soft_dedupe_by_cross_source_fp 採用)
5. **staging DDL v1 を確定** (PK/UNIQUE/index/CHECK 制約を含む確定版)
6. **load package v1 を生成** (precheck/insert/postcheck/rollback)
7. **go/no-go 判定を生成**

---

## 生成した成果物一覧

| # | ファイル | パス |
|---|---------|------|
| 1 | resolution-validation-report.md | artifacts/.../phase6/ |
| 2 | status-dictionary-v3.csv | artifacts/.../phase6/ |
| 3 | status-normalization-decision-log.md | artifacts/.../phase6/ |
| 4 | activity-call-merge-policy-v1.md | artifacts/.../phase6/ |
| 5 | staging-ddl-v1.sql | artifacts/.../phase6/ |
| 6 | staging-load-runbook-v1.md | artifacts/.../phase6/ |
| 7 | staging-load-order-v1.md | artifacts/.../phase6/ |
| 8 | staging-precheck-v1.sql | artifacts/.../phase6/ |
| 9 | staging-insert-draft-v1.sql | artifacts/.../phase6/ |
| 10 | staging-postcheck-v1.sql | artifacts/.../phase6/ |
| 11 | rollback-draft-v1.sql | artifacts/.../phase6/ |
| 12 | phase6-go-no-go.md | artifacts/.../phase6/ |
| 13 | phase6-summary.md | artifacts/.../phase6/ |

---

## Resolution 反映サマリ

| 入力ファイル | 状態 | 反映件数 |
|------------|------|---------|
| high-priority-review-packet.csv | 読み取り済み | - |
| manual-resolution-template.csv | 読み取り済み | resolved: ${resolvedCount} 件 |
| status-hearing-sheet.csv | 読み取り済み | confirmed: ${confirmedStatusCount} 件 |

---

## Validation サマリ

| 重要度 | 件数 |
|--------|------|
| ERROR | ${errors.length} |
| WARNING | ${warnings.length} |

---

## Status Dictionary v3 サマリ

| 区分 | 件数 |
|------|------|
| ヒアリング確定 | ${confirmedStatusCount} |
| provisional (未回答) | ${totalStatusCount - confirmedStatusCount} |
| **合計** | **${totalStatusCount}** |

---

## Merge Policy v1 サマリ

| 項目 | 内容 |
|------|------|
| 採用パターン | soft_dedupe_by_cross_source_fp |
| staging 行数 (予定) | 97,722 (全件投入) |
| 厳密重複 inactive 化 | ~4,280 件 (B 側) |
| ルーズ一致 review 待ち | ~3,285 件 |

---

## DDL / Load Package サマリ

| 項目 | 内容 |
|------|------|
| DDL v1 | PK/UNIQUE/index/CHECK 制約を含む確定版 |
| テーブル数 | 5 (customer/deal/activity_call/rejected_rows/load_log) |
| 新規列 (activity_call) | cross_source_fp, is_duplicate, review_status |
| 新規列 (deal) | status_normalized |
| Insert draft | TRUNCATE → COPY → soft_dedupe → manual resolution → COMMIT |
| Rollback | 3 オプション (完全/soft_dedupe のみ/manual_resolved のみ) |

---

## Go/No-Go 判定

詳細は \`phase6-go-no-go.md\` を参照。

---

## 変更ファイル一覧

### 新規作成

| ファイル | パス |
|---------|------|
| Phase 6 スクリプト | scripts/audit-solar-260312-phase6.ts |
| (生成物 13 件) | artifacts/filemaker-audit/solar/260312/phase6/ |

### 変更

| ファイル | 変更内容 |
|---------|---------|
| package.json | \`audit:solar:phase6\` スクリプト追加 |

---

## 実行コマンド

\`\`\`bash
npm run audit:solar:phase6
\`\`\`
`;

  writeMd(resolve(OUT_DIR, 'phase6-summary.md'), md);
}

// ═══════════════════════════════════════════════════════════════════════
// main
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  console.log('=== Solar 260312 Phase 6: Staging Load Package ===\n');
  ensureDir(OUT_DIR);

  // ─ 1. Read inputs ────────────────────────────────────────────────
  console.log('[1/9] Reading inputs...');
  const highPriority     = readCsvSafe(resolve(PHASE5_DIR, 'high-priority-review-packet.csv'));
  const manualResolution = readCsvSafe(resolve(PHASE5_DIR, 'manual-resolution-template.csv'));
  const statusHearing    = readCsvSafe(resolve(PHASE5_DIR, 'status-hearing-sheet.csv'));
  const statusDictV2     = readCsv(resolve(PHASE4_DIR, 'status-dictionary-candidate-v2.csv'));

  console.log(`  high-priority-review-packet: ${highPriority.missing ? 'MISSING' : highPriority.rows.length + ' rows'}`);
  console.log(`  manual-resolution-template:  ${manualResolution.missing ? 'MISSING' : manualResolution.rows.length + ' rows'}`);
  console.log(`  status-hearing-sheet:        ${statusHearing.missing ? 'MISSING' : statusHearing.rows.length + ' rows'}`);
  console.log(`  status-dict-v2:              ${statusDictV2.length} rows`);

  // ─ 2. Validation report ──────────────────────────────────────────
  console.log('\n[2/9] Validating human inputs...');
  const issues = validateHumanInputs(highPriority, manualResolution, statusHearing);
  generateValidationReport(highPriority, manualResolution, statusHearing, issues);
  console.log(`  errors: ${issues.filter((i) => i.severity === 'error').length}, warnings: ${issues.filter((i) => i.severity === 'warning').length}`);

  // ─ 3. Status dict v3 ─────────────────────────────────────────────
  console.log('\n[3/9] Generating status dictionary v3...');
  const { resolvedCount: dictResolvedCount, provisionalCount } = generateStatusDictV3(statusDictV2, statusHearing);
  console.log(`  confirmed: ${dictResolvedCount}, provisional: ${provisionalCount}`);

  // ─ 4. Merge policy v1 ────────────────────────────────────────────
  console.log('\n[4/9] Generating merge policy v1...');
  generateMergePolicyV1();

  // ─ 5. DDL v1 ─────────────────────────────────────────────────────
  console.log('\n[5/9] Generating staging DDL v1...');
  generateDdlV1();

  // ─ 6. Load package ───────────────────────────────────────────────
  console.log('\n[6/9] Generating load package...');
  generatePrecheckV1();
  generateInsertDraft(manualResolution);
  generatePostcheckV1();
  generateRollback(manualResolution);

  const resolvedRows = manualResolution.rows.filter(
    (r) => r.decision_status === 'resolved' && r.chosen_customer_id && r.chosen_strategy === 'assign_all',
  );

  // ─ 7. Runbook + Load order ────────────────────────────────────────
  console.log('\n[7/9] Generating runbook and load order...');
  generateRunbook(resolvedRows.length);
  generateLoadOrder(resolvedRows.length);

  // ─ 8. Go/No-Go ───────────────────────────────────────────────────
  console.log('\n[8/9] Generating go/no-go judgment...');
  const confirmedStatusCount = statusHearing.rows.filter((r) => r.confirmed_stage).length;
  generateGoNoGo(
    issues, resolvedRows.length, confirmedStatusCount, statusHearing.rows.length,
    highPriority, manualResolution,
  );

  // ─ 9. Phase 6 summary ────────────────────────────────────────────
  console.log('\n[9/9] Generating phase6-summary...');
  generatePhase6Summary(issues, resolvedRows.length, confirmedStatusCount, statusHearing.rows.length);

  console.log('\n=== Phase 6 complete. All artifacts in:', OUT_DIR, '===');
  console.log('実行コマンド: npm run audit:solar:phase6');
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: TypeScript の型チェックを実行する**

```bash
npx tsc --noEmit scripts/audit-solar-260312-phase6.ts --target es2022 --module nodenext --moduleResolution nodenext 2>&1 | head -30
```

Expected: エラーがないこと（または import の moduleResolution エラーのみ — tsx が解決するため無視してよい）

---

## Task 2: `package.json` に `audit:solar:phase6` を追加する

**Files:**
- Modify: `package.json`

- [ ] **Step 1: scripts セクションに 1 行追加する (Edit ツール)**

`"audit:solar:phase5": "tsx scripts/audit-solar-260312-phase5.ts"` の行の後に追加：

```json
    "audit:solar:phase6": "tsx scripts/audit-solar-260312-phase6.ts"
```

- [ ] **Step 2: 変更を確認する**

```bash
node -e "const p=require('./package.json'); console.log(p.scripts['audit:solar:phase6'])"
```

Expected: `tsx scripts/audit-solar-260312-phase6.ts`

---

## Task 3: スクリプトを実行して成果物を確認する

**Files:**
- 読み取り: `artifacts/filemaker-audit/solar/260312/phase6/` (実行後に生成)

- [ ] **Step 1: スクリプトを実行する**

```bash
cd /Users/evening/Developer/peace-biz-group/pbg-filemaker-migration-workbench && npm run audit:solar:phase6 2>&1
```

Expected output:
```
=== Solar 260312 Phase 6: Staging Load Package ===

[1/9] Reading inputs...
  high-priority-review-packet: 29 rows
  manual-resolution-template:  29 rows
  status-hearing-sheet:        10 rows
  status-dict-v2:              16 rows

[2/9] Validating human inputs...
  -> resolution-validation-report.md
  errors: 0, warnings: 0

[3/9] Generating status dictionary v3...
  -> status-dictionary-v3.csv (16 rows)
  -> status-normalization-decision-log.md

[4/9] Generating merge policy v1...
  -> activity-call-merge-policy-v1.md

[5/9] Generating staging DDL v1...
  -> staging-ddl-v1.sql

[6/9] Generating load package...
  -> staging-precheck-v1.sql
  -> staging-insert-draft-v1.sql
  -> staging-postcheck-v1.sql
  -> rollback-draft-v1.sql

[7/9] Generating runbook and load order...
  -> staging-load-runbook-v1.md
  -> staging-load-order-v1.md

[8/9] Generating go/no-go judgment...
  -> phase6-go-no-go.md

[9/9] Generating phase6-summary...
  -> phase6-summary.md

=== Phase 6 complete. All artifacts in: .../phase6 ===
```

- [ ] **Step 2: 全 13 ファイルの存在を確認する**

```bash
ls -la artifacts/filemaker-audit/solar/260312/phase6/
```

Expected: 以下の 13 ファイルが全て存在すること
```
resolution-validation-report.md
status-dictionary-v3.csv
status-normalization-decision-log.md
activity-call-merge-policy-v1.md
staging-ddl-v1.sql
staging-load-runbook-v1.md
staging-load-order-v1.md
staging-precheck-v1.sql
staging-insert-draft-v1.sql
staging-postcheck-v1.sql
rollback-draft-v1.sql
phase6-go-no-go.md
phase6-summary.md
```

- [ ] **Step 3: status-dictionary-v3.csv の列を確認する**

```bash
head -2 artifacts/filemaker-audit/solar/260312/phase6/status-dictionary-v3.csv
```

Expected: `status_value,count,percentage,...,normalized_stage_v2,normalized_stage_v3,stage_confidence,revised_in_v3,revision_source,...` が含まれること

- [ ] **Step 4: staging-ddl-v1.sql に merge policy v1 の新規列が含まれることを確認する**

```bash
grep -c "cross_source_fp\|is_duplicate\|review_status\|status_normalized" artifacts/filemaker-audit/solar/260312/phase6/staging-ddl-v1.sql
```

Expected: 4 以上（各列が 1 回以上言及されている）

- [ ] **Step 5: staging-insert-draft-v1.sql の構造を確認する**

```bash
grep "^-- Step" artifacts/filemaker-audit/solar/260312/phase6/staging-insert-draft-v1.sql
```

Expected:
```
-- Step 0: BEGIN TRANSACTION
-- Step 1: TRUNCATE (idempotent re-run)
-- Step 2: LOAD staging_customer (5,357 rows)
-- Step 3: LOAD staging_deal (5,357 rows)
-- Step 4: LOAD staging_activity_call (97,722 rows)
-- Step 5: soft_dedupe — cross_source_fp 計算 + is_duplicate / review_status 付与
-- Step 6: manual resolution 反映 (0 件)
-- Step 7: status_normalized を deal に付与
-- Step 8: COMMIT
```

---

## 受け入れ条件チェック

実行後に以下を確認する:

| 受け入れ条件 | 確認方法 |
|------------|---------|
| 人手レビュー結果の反映可否がレポートされている | resolution-validation-report.md を開く |
| status dictionary v3 が出ている | status-dictionary-v3.csv (16 rows) |
| merge policy v1 が出ている | activity-call-merge-policy-v1.md |
| staging DDL v1 がある | staging-ddl-v1.sql |
| load package v1 がある | staging-precheck-v1.sql / staging-insert-draft-v1.sql / staging-postcheck-v1.sql |
| rollback draft がある | rollback-draft-v1.sql |
| go/no-go 判定がある | phase6-go-no-go.md |
| 実行コマンド 1 本で再生成できる | `npm run audit:solar:phase6` |
| DB 実行はしていない | スクリプトは SQL ファイルを生成するのみ |
| 変更ファイルと生成ファイルが明示されている | phase6-summary.md |
