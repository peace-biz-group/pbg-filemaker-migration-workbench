#!/usr/bin/env npx tsx
/**
 * Solar 監査 Phase 6 — 260312 batch
 *
 * Phase 5 で生成した人手レビューテンプレートに現場が回答を記入した前提で、
 * それを ingest・検証し、staging DDL / load package を確定版に昇格させる成果物を生成する。
 * DB接続・SQL実行・raw編集は一切しない。
 *
 * 生成物 (artifacts/filemaker-audit/solar/260312/phase6/):
 *   1.  resolution-validation-report.md
 *   2.  status-dictionary-v3.csv
 *   3.  status-normalization-decision-log.md
 *   4.  activity-call-merge-policy-v1.md
 *   5.  staging-ddl-v1.sql
 *   6.  staging-load-runbook-v1.md
 *   7.  staging-load-order-v1.md
 *   8.  staging-precheck-v1.sql
 *   9.  staging-insert-draft-v1.sql
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
const PHASE4_DIR = resolve('artifacts/filemaker-audit/solar/260312/phase4');
const PHASE5_DIR = resolve('artifacts/filemaker-audit/solar/260312/phase5');
const OUT_DIR    = resolve('artifacts/filemaker-audit/solar/260312/phase6');

const INPUTS = {
  highPriority:      resolve(PHASE5_DIR, 'high-priority-review-packet.csv'),
  manualResolution:  resolve(PHASE5_DIR, 'manual-resolution-template.csv'),
  statusHearing:     resolve(PHASE5_DIR, 'status-hearing-sheet.csv'),
  statusDictV2:      resolve(PHASE4_DIR, 'status-dictionary-candidate-v2.csv'),
  ddlDraftV1:        resolve(PHASE4_DIR, 'staging-ddl-draft-v1.sql'),
} as const;

type Row = Record<string, string>;

interface HumanInputResult {
  rows: Row[];
  missing: boolean;
  filePath: string;
}

interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  file: string;
  row_id: string;
  field: string;
  message: string;
}

// ─── helpers ─────────────────────────────────────────────────────────
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function readCsvSafe(filePath: string): HumanInputResult {
  if (!existsSync(filePath)) {
    return { rows: [], missing: true, filePath };
  }
  try {
    const buf = readFileSync(filePath, 'utf-8');
    const rows = parse(buf, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
    }) as Row[];
    return { rows, missing: false, filePath };
  } catch {
    return { rows: [], missing: true, filePath };
  }
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

function today(): string {
  return new Date().toISOString().split('T')[0];
}

// ─── main ────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Solar 260312 Phase 6: Resolution & Load Package ===\n');
  ensureDir(OUT_DIR);

  // ── read inputs ──
  console.log('[1/13] Reading inputs...');
  const highPriority     = readCsvSafe(INPUTS.highPriority);
  const manualResolution = readCsvSafe(INPUTS.manualResolution);
  const statusHearing    = readCsvSafe(INPUTS.statusHearing);
  const statusDictV2     = readCsvSafe(INPUTS.statusDictV2);

  console.log(`  high-priority-review-packet.csv : ${highPriority.missing ? 'MISSING' : `${highPriority.rows.length} rows`}`);
  console.log(`  manual-resolution-template.csv  : ${manualResolution.missing ? 'MISSING' : `${manualResolution.rows.length} rows`}`);
  console.log(`  status-hearing-sheet.csv        : ${statusHearing.missing ? 'MISSING' : `${statusHearing.rows.length} rows`}`);
  console.log(`  status-dictionary-candidate-v2  : ${statusDictV2.missing ? 'MISSING' : `${statusDictV2.rows.length} rows`}`);

  // ── 1. validate ──
  console.log('\n[2/13] Validating human inputs...');
  const issues = validateHumanInputs(highPriority, manualResolution, statusHearing);
  const errors   = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const infos    = issues.filter((i) => i.severity === 'info');
  console.log(`  errors: ${errors.length}, warnings: ${warnings.length}, info: ${infos.length}`);

  // ── 2. validation report ──
  console.log('\n[3/13] Generating resolution-validation-report.md...');
  generateValidationReport(highPriority, manualResolution, statusHearing, issues);

  // ── 3. status dict v3 ──
  console.log('\n[4/13] Generating status-dictionary-v3.csv + decision-log...');
  generateStatusDictV3(statusDictV2, statusHearing);

  // ── 4. merge policy ──
  console.log('\n[5/13] Generating activity-call-merge-policy-v1.md...');
  generateMergePolicyV1();

  // ── 5. DDL v1 ──
  console.log('\n[6/13] Generating staging-ddl-v1.sql...');
  generateDdlV1();

  // ── 6. precheck ──
  console.log('\n[7/13] Generating staging-precheck-v1.sql...');
  generatePrecheckV1();

  // ── 7. insert draft ──
  console.log('\n[8/13] Generating staging-insert-draft-v1.sql...');
  generateInsertDraft(manualResolution);

  // ── 8. postcheck ──
  console.log('\n[9/13] Generating staging-postcheck-v1.sql...');
  generatePostcheckV1();

  // ── 9. rollback ──
  console.log('\n[10/13] Generating rollback-draft-v1.sql...');
  generateRollback(manualResolution);

  // ── 10. runbook ──
  console.log('\n[11/13] Generating staging-load-runbook-v1.md...');
  generateRunbook(manualResolution);

  // ── 11. load order ──
  console.log('\n[12/13] Generating staging-load-order-v1.md...');
  generateLoadOrder();

  // ── 12. go/no-go ──
  console.log('\n[13/13] Generating phase6-go-no-go.md + phase6-summary.md...');
  generateGoNoGo(highPriority, manualResolution, statusHearing, issues);
  generatePhase6Summary(highPriority, manualResolution, statusHearing, issues, statusDictV2);

  console.log('\n=== Phase 6 complete. All artifacts in:', OUT_DIR, '===');
}

// ═══════════════════════════════════════════════════════════════════════
// 1. validateHumanInputs
// ═══════════════════════════════════════════════════════════════════════

function validateHumanInputs(
  highPriority: HumanInputResult,
  manualResolution: HumanInputResult,
  statusHearing: HumanInputResult,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const validDecisions = new Set(['resolved', 'skip', 'unclear', 'defer', '']);
  const validStrategies = new Set(['assign_all', 'assign_by_date', 'split', '']);

  // ── high-priority-review-packet.csv ──
  if (highPriority.missing) {
    issues.push({
      severity: 'error',
      file: 'high-priority-review-packet.csv',
      row_id: '-',
      field: 'file',
      message: 'ファイルが存在しません',
    });
  } else {
    for (const row of highPriority.rows) {
      const id = row.review_id || '(unknown)';
      const ds = row.decision_status ?? '';

      if (!validDecisions.has(ds)) {
        issues.push({
          severity: 'error',
          file: 'high-priority-review-packet.csv',
          row_id: id,
          field: 'decision_status',
          message: `無効な値: "${ds}" (valid: resolved/skip/unclear/defer/)`,
        });
      }

      if (ds === 'resolved') {
        if (!row.chosen_customer_id || row.chosen_customer_id.trim() === '') {
          issues.push({
            severity: 'error',
            file: 'high-priority-review-packet.csv',
            row_id: id,
            field: 'chosen_customer_id',
            message: 'decision_status=resolved なのに chosen_customer_id が空',
          });
        } else {
          const candidates = (row.candidate_customer_ids || '')
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean);
          if (candidates.length > 0 && !candidates.includes(row.chosen_customer_id.trim())) {
            issues.push({
              severity: 'warning',
              file: 'high-priority-review-packet.csv',
              row_id: id,
              field: 'chosen_customer_id',
              message: `chosen_customer_id "${row.chosen_customer_id}" が candidate_customer_ids に含まれていません`,
            });
          }
        }
      }

      if (ds === '') {
        issues.push({
          severity: 'info',
          file: 'high-priority-review-packet.csv',
          row_id: id,
          field: 'decision_status',
          message: 'decision_status が未記入 (レビュー待ち)',
        });
      }
    }
  }

  // ── manual-resolution-template.csv ──
  if (manualResolution.missing) {
    issues.push({
      severity: 'error',
      file: 'manual-resolution-template.csv',
      row_id: '-',
      field: 'file',
      message: 'ファイルが存在しません',
    });
  } else {
    for (const row of manualResolution.rows) {
      const id = row.review_id || '(unknown)';
      const ds = row.decision_status ?? '';
      const cs = row.chosen_strategy ?? '';

      if (!validDecisions.has(ds)) {
        issues.push({
          severity: 'error',
          file: 'manual-resolution-template.csv',
          row_id: id,
          field: 'decision_status',
          message: `無効な値: "${ds}" (valid: resolved/skip/unclear/defer/)`,
        });
      }

      if (!validStrategies.has(cs)) {
        issues.push({
          severity: 'error',
          file: 'manual-resolution-template.csv',
          row_id: id,
          field: 'chosen_strategy',
          message: `無効な値: "${cs}" (valid: assign_all/assign_by_date/split/)`,
        });
      }

      if (ds === 'resolved' && (!cs || cs.trim() === '')) {
        issues.push({
          severity: 'warning',
          file: 'manual-resolution-template.csv',
          row_id: id,
          field: 'chosen_strategy',
          message: 'decision_status=resolved なのに chosen_strategy が空',
        });
      }

      if (cs === 'assign_by_date' && (!row.note || row.note.trim() === '')) {
        issues.push({
          severity: 'warning',
          file: 'manual-resolution-template.csv',
          row_id: id,
          field: 'note',
          message: 'chosen_strategy=assign_by_date なのに note が空（日付範囲の記載が必要）',
        });
      }
    }
  }

  // ── status-hearing-sheet.csv ──
  if (statusHearing.missing) {
    issues.push({
      severity: 'error',
      file: 'status-hearing-sheet.csv',
      row_id: '-',
      field: 'file',
      message: 'ファイルが存在しません',
    });
  } else {
    for (const row of statusHearing.rows) {
      const id = row.status_value || '(unknown)';

      if (row.answer && row.answer.trim() !== '' && (!row.confirmed_stage || row.confirmed_stage.trim() === '')) {
        issues.push({
          severity: 'warning',
          file: 'status-hearing-sheet.csv',
          row_id: id,
          field: 'confirmed_stage',
          message: 'answer があるのに confirmed_stage が空',
        });
      }

      if (row.confirmed_stage && row.confirmed_stage.trim() !== '' && (!row.confirmed_by || row.confirmed_by.trim() === '')) {
        issues.push({
          severity: 'warning',
          file: 'status-hearing-sheet.csv',
          row_id: id,
          field: 'confirmed_by',
          message: 'confirmed_stage があるのに confirmed_by が空',
        });
      }
    }
  }

  return issues;
}

// ═══════════════════════════════════════════════════════════════════════
// 2. generateValidationReport
// ═══════════════════════════════════════════════════════════════════════

function generateValidationReport(
  highPriority: HumanInputResult,
  manualResolution: HumanInputResult,
  statusHearing: HumanInputResult,
  issues: ValidationIssue[],
): void {
  const errors   = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const infos    = issues.filter((i) => i.severity === 'info');

  // Decision status counts from manual-resolution-template
  const dsCount: Record<string, number> = {};
  for (const row of manualResolution.rows) {
    const ds = row.decision_status || '(未記入)';
    dsCount[ds] = (dsCount[ds] || 0) + 1;
  }
  const resolvedCount = dsCount['resolved'] || 0;

  // Status hearing confirmed count
  const confirmedStatusCount = statusHearing.rows.filter(
    (r) => r.confirmed_stage && r.confirmed_stage.trim() !== '',
  ).length;

  // Applicability table
  const canApplyManual = !manualResolution.missing && resolvedCount > 0 && errors.filter((e) => e.file === 'manual-resolution-template.csv').length === 0;
  const canApplyStatus = !statusHearing.missing && confirmedStatusCount > 0 && errors.filter((e) => e.file === 'status-hearing-sheet.csv').length === 0;

  function issueTable(list: ValidationIssue[]): string {
    if (list.length === 0) return '*(なし)*\n';
    let t = '| ファイル | row_id | フィールド | メッセージ |\n';
    t     += '|---------|--------|----------|----------|\n';
    for (const i of list) {
      t += `| ${i.file} | ${i.row_id} | ${i.field} | ${i.message} |\n`;
    }
    return t;
  }

  let md = `# Resolution Validation Report — Solar 260312 Phase 6

生成日: ${today()}

---

## ファイル状態

| ファイル | 状態 | 行数 |
|---------|------|------|
| high-priority-review-packet.csv | ${highPriority.missing ? '**MISSING**' : '存在'} | ${highPriority.rows.length} |
| manual-resolution-template.csv | ${manualResolution.missing ? '**MISSING**' : '存在'} | ${manualResolution.rows.length} |
| status-hearing-sheet.csv | ${statusHearing.missing ? '**MISSING**' : '存在'} | ${statusHearing.rows.length} |

---

## バリデーション結果

| 種別 | 件数 |
|------|------|
| ERROR | ${errors.length} |
| WARNING | ${warnings.length} |
| INFO | ${infos.length} |

### ERROR 一覧

${issueTable(errors)}
### WARNING 一覧

${issueTable(warnings)}
### INFO 一覧

${issueTable(infos)}

---

## Manual Resolution サマリ

| decision_status | 件数 |
|-----------------|------|
${Object.entries(dsCount).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

- resolved 件数: **${resolvedCount} 件**

---

## Status Hearing サマリ

- confirmed_stage 記入済み: **${confirmedStatusCount} 件** / ${statusHearing.rows.length} 件

---

## 反映可否判断

| 対象 | 反映可否 | 理由 |
|------|---------|------|
| manual-resolution-template.csv | ${canApplyManual ? '**反映可**' : '反映不可'} | ${canApplyManual ? `resolved: ${resolvedCount} 件` : manualResolution.missing ? 'ファイル欠損' : resolvedCount === 0 ? '反映対象なし' : 'ERROR あり'} |
| status-hearing-sheet.csv | ${canApplyStatus ? '**反映可**' : '反映不可'} | ${canApplyStatus ? `confirmed_stage: ${confirmedStatusCount} 件` : statusHearing.missing ? 'ファイル欠損' : confirmedStatusCount === 0 ? '反映対象なし' : 'ERROR あり'} |
`;

  writeMd(resolve(OUT_DIR, 'resolution-validation-report.md'), md);
}

// ═══════════════════════════════════════════════════════════════════════
// 3. generateStatusDictV3
// ═══════════════════════════════════════════════════════════════════════

function generateStatusDictV3(
  statusDictV2: HumanInputResult,
  statusHearing: HumanInputResult,
): void {
  // Build hearing lookup: status_value -> confirmed_stage, confirmed_by
  const hearingMap = new Map<string, Row>();
  for (const row of statusHearing.rows) {
    if (row.status_value) hearingMap.set(row.status_value, row);
  }

  const v3rows: Record<string, unknown>[] = [];
  const changed: { status: string; v2: string; v3: string; source: string }[] = [];
  const unresolved: { status: string; reason: string }[] = [];

  for (const row of statusDictV2.rows) {
    const sv = row.status_value || '';
    const hearing = hearingMap.get(sv);
    const confirmedStage = hearing?.confirmed_stage?.trim() ?? '';
    const confirmedBy    = hearing?.confirmed_by?.trim() ?? '';

    let normalizedV3: string;
    let stageConfidence: string;
    let revisedInV3: string;
    let revisionSource: string;

    if (confirmedStage !== '') {
      normalizedV3    = confirmedStage;
      stageConfidence = 'high';
      revisedInV3     = normalizedV3 !== row.normalized_stage ? 'yes' : 'no';
      revisionSource  = `hearing (confirmed_by: ${confirmedBy || '(未記入)'})`;
    } else {
      // フォールバック: v2 の値を引き継ぐ。confidence が high でなければ unresolved
      if (row.stage_confidence === 'high') {
        normalizedV3    = row.normalized_stage || row.normalized_stage_v0 || 'unresolved';
        stageConfidence = 'high';
        revisedInV3     = 'no';
        revisionSource  = 'inherited_from_v2';
      } else {
        normalizedV3    = 'unresolved';
        stageConfidence = row.stage_confidence || 'low';
        revisedInV3     = 'no';
        revisionSource  = 'provisional (hearing 未回答)';
        unresolved.push({ status: sv, reason: 'ヒアリング回答なし・confidence 非 high' });
      }
    }

    if (revisedInV3 === 'yes') {
      changed.push({
        status: sv,
        v2: row.normalized_stage || '',
        v3: normalizedV3,
        source: revisionSource,
      });
    }

    v3rows.push({
      status_value:        sv,
      count:               row.count,
      percentage:          row.percentage,
      sample_customer_ids: row.sample_customer_ids,
      normalized_stage_v2: row.normalized_stage || '',
      normalized_stage_v3: normalizedV3,
      stage_confidence:    stageConfidence,
      revised_in_v3:       revisedInV3,
      revision_source:     revisionSource,
      requires_hearing:    row.requires_hearing || '',
      impact_score:        row.impact_score || '',
      priority_rank:       row.priority_rank || '',
    });
  }

  writeCsvFile(resolve(OUT_DIR, 'status-dictionary-v3.csv'), v3rows);

  // decision log
  let log = `# Status Normalization Decision Log — Solar 260312 Phase 6

生成日: ${today()}

---

## 概要

| 項目 | 件数 |
|------|------|
| v2 → v3 で変更あり | ${changed.length} |
| 未解決 (unresolved) | ${unresolved.length} |
| 全 status 数 | ${v3rows.length} |

---

## v3 で変更した status 一覧

`;

  if (changed.length === 0) {
    log += '*(変更なし — ヒアリング回答が反映されなかった、または全件 v2 と同一)*\n\n';
  } else {
    log += '| status_value | normalized_stage_v2 | normalized_stage_v3 | revision_source |\n';
    log += '|-------------|---------------------|---------------------|-----------------|\n';
    for (const c of changed) {
      log += `| ${c.status} | ${c.v2} | ${c.v3} | ${c.source} |\n`;
    }
    log += '\n';
  }

  log += `---

## 未解決 status 一覧 (normalized_stage_v3 = 'unresolved')

`;

  if (unresolved.length === 0) {
    log += '*(なし — 全件解決済み)*\n\n';
  } else {
    log += '| status_value | 理由 |\n';
    log += '|-------------|------|\n';
    for (const u of unresolved) {
      log += `| ${u.status} | ${u.reason} |\n`;
    }
    log += '\n';
    log += `> **注意**: unresolved のままの status は staging_deal.status_normalized に反映されません。\n`;
    log += `> Phase 7 以降でヒアリングを追加してください。\n`;
  }

  writeMd(resolve(OUT_DIR, 'status-normalization-decision-log.md'), log);
}

// ═══════════════════════════════════════════════════════════════════════
// 4. generateMergePolicyV1
// ═══════════════════════════════════════════════════════════════════════

function generateMergePolicyV1(): void {
  const SOURCE_A_ROWS  = 46572;
  const SOURCE_B_ROWS  = 51150;
  const UNION_ROWS     = 97722;
  const STRICT_OVERLAP = 4280;
  const LOOSE_OVERLAP  = 3285;

  const md = `# Activity Call Merge Policy v1 — Solar 260312 Phase 6

生成日: ${today()}

---

## 採用方針

**Pattern 2: soft_dedupe_by_cross_source_fp を採用する。**

Phase 5 のシミュレーションで3パターンを比較し、Phase 6 時点でこの方針を確定する。

---

## 前提数値

| 指標 | 値 |
|------|-----|
| Source A（コール履歴 XLSX） | ${SOURCE_A_ROWS.toLocaleString()} 行 |
| Source B（ポータル展開） | ${SOURCE_B_ROWS.toLocaleString()} 行 |
| Union（A + B） | ${UNION_ROWS.toLocaleString()} 行（全件 staging 投入） |
| 厳密重複（date+staff+content80 一致） | ~${STRICT_OVERLAP.toLocaleString()} 件 |
| ルーズ一致（date+staff 一致） | ~${LOOSE_OVERLAP.toLocaleString()} 件 |

---

## 方針詳細

### staging 行数

- 全 ${UNION_ROWS.toLocaleString()} 行を staging_activity_call に投入する
- 物理削除は行わない

### 厳密重複の処理

- 重複キー: \`concat_ws('|', to_char(call_date,'YYYY-MM-DD'), call_staff, left(content,80))\`（cross_source_fp）
- Source B 側の厳密重複（~${STRICT_OVERLAP.toLocaleString()} 件）に対して:
  - \`is_duplicate = TRUE\`
  - \`review_status = 'duplicate'\`
- Source A 側は変更しない

### ルーズ一致の処理

- ルーズ一致（~${LOOSE_OVERLAP.toLocaleString()} 件）は \`review_status = 'needs_review'\` を付与する
- 物理削除禁止・確定的な紐付け変更禁止
- downstream で \`review_status = 'active'\` のみを使えば重複を回避できる

### 物理削除禁止の理由

1. raw 原本の保全方針に従い、全行を staging に保持する
2. is_duplicate / review_status フラグで管理することで可逆性を確保する
3. 後から「重複ではなかった」と判明した場合に復元できる

### 未解決事項

| 事項 | 状態 |
|------|------|
| Source A/B が同一 FileMaker DB の別エクスポートであることの確認 | 未確認 |
| ルーズ一致 ${LOOSE_OVERLAP.toLocaleString()} 件の個別判断 | Phase 7 以降 |
| customer:deal = 1:1 vs 1:N の確認 | 未確認（FK コメントアウトのまま） |

---

## downstream での使い方

\`\`\`sql
-- 有効行のみ抽出
SELECT * FROM staging_activity_call
WHERE review_status = 'active';

-- 要確認行の確認
SELECT * FROM staging_activity_call
WHERE review_status = 'needs_review';
\`\`\`

---

## 変更履歴

| バージョン | 日付 | 変更内容 |
|----------|------|---------|
| v1 | ${today()} | Phase 6 で Pattern 2 を正式採用 |
`;

  writeMd(resolve(OUT_DIR, 'activity-call-merge-policy-v1.md'), md);
}

// ═══════════════════════════════════════════════════════════════════════
// 5. generateDdlV1
// ═══════════════════════════════════════════════════════════════════════

function generateDdlV1(): void {
  const sql = `-- staging-ddl-v1.sql — Solar 260312
-- NOTE: 実行禁止。Supabase 接続禁止。dry-run 相当。
-- NOTE: Phase 6 確定版 DDL。Phase 4 草案 (v0) から昇格。
-- 生成日: ${today()}

-- ═══════════════════════════════════════════════════════════════
-- staging_customer
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_customer (
  -- PK (確定)
  customer_id        TEXT NOT NULL PRIMARY KEY,

  -- 基本情報
  furigana            TEXT,
  address             TEXT,
  postal_code         TEXT,
  phone               TEXT,
  phone_search        TEXT,
  fax                 TEXT,
  email               TEXT,

  -- 代表者情報
  representative_furigana TEXT,
  representative_mobile   TEXT,
  representative_birthday DATE,

  -- 担当者情報
  contact_furigana    TEXT,
  contact_mobile      TEXT,
  emergency_contact   TEXT,

  -- 属性
  occupation          TEXT,
  industry_subclass   TEXT,

  -- FileMaker レガシー
  fm_password         TEXT,
  fm_username         TEXT,

  -- その他
  invoice_registration TEXT,
  application_id      TEXT,
  contact_info        TEXT,
  preferred_contact_time TEXT,

  -- traceability
  raw_source_file     TEXT NOT NULL,
  raw_row_origin      INTEGER NOT NULL,
  source_fingerprint  TEXT NOT NULL UNIQUE,

  -- audit (load 時に自動付与)
  _loaded_at          TIMESTAMPTZ DEFAULT now(),
  _batch_id           TEXT DEFAULT '260312',
  _schema_version     TEXT DEFAULT 'v1'
);

CREATE INDEX IF NOT EXISTS idx_staging_customer_phone       ON staging_customer (phone);
CREATE INDEX IF NOT EXISTS idx_staging_customer_phone_search ON staging_customer (phone_search);
CREATE INDEX IF NOT EXISTS idx_staging_customer_fingerprint ON staging_customer (source_fingerprint);

-- ═══════════════════════════════════════════════════════════════
-- staging_deal
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_deal (
  -- surrogate PK (確定)
  deal_id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- FK
  -- NOTE: customer:deal = 1:1 vs 1:N ヒアリング未確定のため FK はコメントアウトのまま維持
  customer_id         TEXT NOT NULL,
  -- CONSTRAINT staging_deal_customer_fk FOREIGN KEY (customer_id) REFERENCES staging_customer(customer_id),

  -- ステータス
  status              TEXT,
  status_normalized   TEXT,  -- Phase 6 追加: status-dictionary-v3.csv の normalized_stage_v3 を参照
  cancel_flag         TEXT,
  cancel_date         DATE,
  cancel_reason       TEXT,

  -- 見積
  estimate_maker      TEXT,
  estimate_request_date DATE,
  estimate_arrival_date DATE,
  estimate_note       TEXT,

  -- FIT
  fit_approval_date   DATE,
  fit_application_date DATE,

  -- 設備
  maker               TEXT,
  module              TEXT,
  installed_kw        NUMERIC(10,3),

  -- 設置先
  installation_store  TEXT,
  installation_address TEXT,
  installation_phone  TEXT,
  installation_fax    TEXT,
  building_age        INTEGER,

  -- 受注
  order_date          DATE,
  estimate_request_date_2 DATE,
  estimate_arrival_date_2 DATE,
  site_survey_date    DATE,

  -- 契約
  applicant           TEXT,
  application_send_date DATE,
  lease_certificate_send DATE,
  consent_send        DATE,
  contractor          TEXT,
  contractor_relationship TEXT,
  user_relationship   TEXT,

  -- 金額
  monthly_amount      NUMERIC(15,2),
  lease_fee           NUMERIC(15,2),

  -- 信販
  credit_company      TEXT,
  credit_request_date DATE,
  credit_result       TEXT,
  credit_result_date  DATE,
  credit_company_2    TEXT,

  -- 電力申請
  power_application_date DATE,
  power_approval_date DATE,

  -- 工事
  drone_survey_date   DATE,
  construction_request TEXT,
  construction_request_2 TEXT,
  construction_date   DATE,
  construction_complete_date DATE,
  revisit_date        DATE,
  completion_report   DATE,
  confirmation_complete_date DATE,
  report_arrival_date DATE,
  floor_plan_arrival  DATE,

  -- 保証
  warranty_application DATE,
  warranty_arrival    DATE,
  disaster_insurance_application DATE,
  disaster_insurance_arrival DATE,

  -- 請求・入金
  invoice_date        DATE,
  invoice_date_2      DATE,
  payment_date        DATE,
  payment_date_2      DATE,
  delivery_date       DATE,
  order_placement_date DATE,

  -- 計上
  accounting_month    TEXT,
  accounting_date     DATE,
  gross_profit        NUMERIC(15,2),

  -- サービス品
  service_item_count  INTEGER,
  service_item_price  NUMERIC(15,2),
  service_item_cost   NUMERIC(15,2),
  service_item_delivery DATE,

  -- 部材
  material            TEXT,
  material_count      INTEGER,
  material_unit_price NUMERIC(15,2),
  material_cost       NUMERIC(15,2),
  material_name       TEXT,

  -- 施工・販売
  construction_management TEXT,
  sales_channel       TEXT,
  sales_store         TEXT,
  slip_number         TEXT,
  additional_construction TEXT,
  required_documents  TEXT,
  required_documents_date DATE,

  -- メモ
  note                TEXT,
  caution             TEXT,

  -- その他
  sheet_count         INTEGER,
  mail_date           DATE,
  grid_connection_date DATE,
  appointment_staff   TEXT,
  sales_staff         TEXT,
  sales_comment       TEXT,
  visit_count         INTEGER,
  visit_staff         TEXT,

  -- traceability
  raw_source_file     TEXT NOT NULL,
  raw_row_origin      INTEGER NOT NULL,
  source_fingerprint  TEXT NOT NULL UNIQUE,

  -- audit
  _loaded_at          TIMESTAMPTZ DEFAULT now(),
  _batch_id           TEXT DEFAULT '260312',
  _schema_version     TEXT DEFAULT 'v1'
);

CREATE INDEX IF NOT EXISTS idx_staging_deal_customer_id  ON staging_deal (customer_id);
CREATE INDEX IF NOT EXISTS idx_staging_deal_status       ON staging_deal (status);
CREATE INDEX IF NOT EXISTS idx_staging_deal_fingerprint  ON staging_deal (source_fingerprint);

-- ═══════════════════════════════════════════════════════════════
-- staging_activity_call
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_activity_call (
  -- surrogate PK (確定)
  activity_call_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- source 識別 (確定: CHECK 制約追加)
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('source_a', 'source_b')),

  -- コール情報
  call_date           DATE,
  call_time           TIME,
  call_staff          TEXT,
  content             TEXT,
  customer_staff      TEXT,

  -- 電話番号 (Source A のみ)
  raw_phone           TEXT,
  normalized_phone    TEXT,

  -- customer 紐付け
  matched_customer_id TEXT,
  matched_customer_candidate_count INTEGER,
  match_type          TEXT,
  fill_forward_customer_id TEXT,  -- Source B のみ

  -- merge policy v1 追加列
  cross_source_fp     TEXT,        -- concat_ws('|', date, staff, left(content,80))
  is_duplicate        BOOLEAN DEFAULT FALSE,
  review_status       TEXT DEFAULT 'active' CHECK (review_status IN ('active', 'needs_review', 'duplicate')),

  -- traceability
  raw_source_file     TEXT NOT NULL,
  raw_row_origin      INTEGER NOT NULL,
  source_fingerprint  TEXT NOT NULL,

  -- audit
  _loaded_at          TIMESTAMPTZ DEFAULT now(),
  _batch_id           TEXT DEFAULT '260312',
  _schema_version     TEXT DEFAULT 'v1'
);

CREATE INDEX IF NOT EXISTS idx_staging_activity_call_source     ON staging_activity_call (source_kind);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_date       ON staging_activity_call (call_date);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_phone      ON staging_activity_call (normalized_phone);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_matched    ON staging_activity_call (matched_customer_id);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_fingerprint ON staging_activity_call (source_fingerprint);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_cross_fp   ON staging_activity_call (cross_source_fp);
CREATE INDEX IF NOT EXISTS idx_staging_activity_call_review     ON staging_activity_call (review_status);

-- ═══════════════════════════════════════════════════════════════
-- staging_rejected_rows
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_rejected_rows (
  rejected_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity              TEXT NOT NULL,  -- 'customer', 'deal', 'activity_call'
  reject_reason       TEXT NOT NULL,
  raw_source_file     TEXT NOT NULL,
  raw_row_origin      INTEGER NOT NULL,
  source_fingerprint  TEXT NOT NULL,
  raw_data_json       JSONB,
  _rejected_at        TIMESTAMPTZ DEFAULT now(),
  _batch_id           TEXT DEFAULT '260312'
);

-- ═══════════════════════════════════════════════════════════════
-- staging_load_log
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staging_load_log (
  log_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity              TEXT NOT NULL,
  action              TEXT NOT NULL,
  row_count           INTEGER,
  started_at          TIMESTAMPTZ NOT NULL,
  completed_at        TIMESTAMPTZ,
  status              TEXT NOT NULL CHECK (status IN ('success', 'error', 'rollback')),
  error_message       TEXT,
  _batch_id           TEXT DEFAULT '260312'
);
`;

  writeSql(resolve(OUT_DIR, 'staging-ddl-v1.sql'), sql);
}

// ═══════════════════════════════════════════════════════════════════════
// 6. generatePrecheckV1
// ═══════════════════════════════════════════════════════════════════════

function generatePrecheckV1(): void {
  const sql = `-- staging-precheck-v1.sql — Solar 260312 Phase 6
-- NOTE: 実行禁止。Supabase 接続禁止。dry-run 相当。
-- 目的: staging load 前の環境確認クエリ集
-- 生成日: ${today()}

-- ─────────────────────────────────────────────────────────────
-- 1. staging テーブルの存在確認（5 テーブル）
-- ─────────────────────────────────────────────────────────────

SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'staging_customer',
    'staging_deal',
    'staging_activity_call',
    'staging_rejected_rows',
    'staging_load_log'
  )
ORDER BY table_name;

-- 期待: 5行が返ること

-- ─────────────────────────────────────────────────────────────
-- 2. 既存データ行数確認（re-run 判定）
-- ─────────────────────────────────────────────────────────────

SELECT 'staging_customer'     AS table_name, COUNT(*) AS row_count FROM staging_customer
UNION ALL
SELECT 'staging_deal',                        COUNT(*) FROM staging_deal
UNION ALL
SELECT 'staging_activity_call',               COUNT(*) FROM staging_activity_call
UNION ALL
SELECT 'staging_rejected_rows',               COUNT(*) FROM staging_rejected_rows
UNION ALL
SELECT 'staging_load_log',                    COUNT(*) FROM staging_load_log;

-- 期待: 初回は全て 0。再実行時は既存件数を確認し TRUNCATE 必要性を判断する

-- ─────────────────────────────────────────────────────────────
-- 3. 制約の確認
-- ─────────────────────────────────────────────────────────────

SELECT conname, contype, conrelid::regclass AS table_name
FROM pg_constraint
WHERE conrelid::regclass::text IN (
    'staging_customer',
    'staging_deal',
    'staging_activity_call',
    'staging_rejected_rows',
    'staging_load_log'
  )
ORDER BY table_name, conname;

-- 期待: PRIMARY KEY, UNIQUE (source_fingerprint), CHECK (source_kind, review_status, status) が存在すること

-- ─────────────────────────────────────────────────────────────
-- 4. disk space 概算
-- ─────────────────────────────────────────────────────────────

SELECT
  relname AS table_name,
  pg_size_pretty(pg_total_relation_size(oid)) AS total_size
FROM pg_class
WHERE relname IN (
    'staging_customer',
    'staging_deal',
    'staging_activity_call',
    'staging_rejected_rows',
    'staging_load_log'
  )
ORDER BY relname;

-- ─────────────────────────────────────────────────────────────
-- 5. CSV ファイル行数の手動確認（実行前に確認すること）
-- ─────────────────────────────────────────────────────────────

-- 以下をターミナルで実行し、期待値と一致することを確認する:
--
--   wc -l artifacts/filemaker-audit/solar/260312/phase3/customer-staging-v0.csv
--   期待値: 5358 行（ヘッダー含む）= 5357 レコード
--
--   wc -l artifacts/filemaker-audit/solar/260312/phase3/deal-staging-v0.csv
--   期待値: 5358 行（ヘッダー含む）= 5357 レコード
--
--   wc -l artifacts/filemaker-audit/solar/260312/phase3/activity-call-union-candidate.csv
--   期待値: 97723 行（ヘッダー含む）= 97722 レコード
--
-- ミスマッチがあれば load を中止すること。
`;

  writeSql(resolve(OUT_DIR, 'staging-precheck-v1.sql'), sql);
}

// ═══════════════════════════════════════════════════════════════════════
// 7. generateInsertDraft
// ═══════════════════════════════════════════════════════════════════════

function generateInsertDraft(manualResolution: HumanInputResult): void {
  const resolvedRows = manualResolution.rows.filter(
    (r) => r.decision_status === 'resolved' && r.chosen_strategy === 'assign_all',
  );

  let manualUpdates: string;
  if (resolvedRows.length === 0) {
    manualUpdates = `-- resolved な manual resolution がありません（反映対象 0 件）
-- manual-resolution-template.csv に decision_status=resolved / chosen_strategy=assign_all の行が記入されれば、
-- ここに UPDATE 文が生成されます。`;
  } else {
    manualUpdates = resolvedRows
      .map((r) => {
        const phone    = (r.normalized_phone || '').replace(/'/g, "''");
        const custId   = (r.chosen_customer_id || '').replace(/'/g, "''");
        const reviewId = (r.review_id || '').replace(/'/g, "''");
        return `-- ${reviewId}: ${phone} -> ${custId}
UPDATE staging_activity_call
SET matched_customer_id               = '${custId}',
    matched_customer_candidate_count  = 1,
    match_type                        = 'manual_resolved'
WHERE normalized_phone = '${phone}'
  AND source_kind      = 'source_a'
  AND match_type       = 'multi_match';

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
VALUES ('activity_call', 'manual_resolve_${reviewId}', NULL, now(), now(), 'success', '260312');`;
      })
      .join('\n\n');
  }

  const sql = `-- staging-insert-draft-v1.sql — Solar 260312 Phase 6
-- NOTE: 実行禁止。Supabase 接続禁止。dry-run 相当。
-- 目的: staging テーブルへの初回 load 手順（草案）
-- 生成日: ${today()}
-- 前提: staging-ddl-v1.sql 適用済み / precheck-v1.sql 確認済み

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- Step 1: TRUNCATE（再実行時は全件クリア）
-- ─────────────────────────────────────────────────────────────

TRUNCATE staging_activity_call;
TRUNCATE staging_deal;
TRUNCATE staging_customer;
-- staging_rejected_rows / staging_load_log は TRUNCATE しない（ログ保持）

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
VALUES ('all', 'truncate', NULL, now(), now(), 'success', '260312');

-- ─────────────────────────────────────────────────────────────
-- Step 2: staging_customer load
-- ─────────────────────────────────────────────────────────────

\\COPY staging_customer FROM 'artifacts/filemaker-audit/solar/260312/phase3/customer-staging-v0.csv'
  WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
VALUES ('customer', 'copy', 5357, now(), now(), 'success', '260312');

-- ─────────────────────────────────────────────────────────────
-- Step 3: staging_deal load
-- ─────────────────────────────────────────────────────────────

\\COPY staging_deal (
  customer_id, status, cancel_flag, cancel_date, cancel_reason,
  estimate_maker, estimate_request_date, estimate_arrival_date, estimate_note,
  fit_approval_date, fit_application_date,
  maker, module, installed_kw,
  installation_store, installation_address, installation_phone, installation_fax, building_age,
  order_date, estimate_request_date_2, estimate_arrival_date_2, site_survey_date,
  applicant, application_send_date, lease_certificate_send, consent_send,
  contractor, contractor_relationship, user_relationship,
  monthly_amount, lease_fee,
  credit_company, credit_request_date, credit_result, credit_result_date, credit_company_2,
  power_application_date, power_approval_date,
  drone_survey_date, construction_request, construction_request_2,
  construction_date, construction_complete_date, revisit_date, completion_report,
  confirmation_complete_date, report_arrival_date, floor_plan_arrival,
  warranty_application, warranty_arrival,
  disaster_insurance_application, disaster_insurance_arrival,
  invoice_date, invoice_date_2, payment_date, payment_date_2, delivery_date, order_placement_date,
  accounting_month, accounting_date, gross_profit,
  service_item_count, service_item_price, service_item_cost, service_item_delivery,
  material, material_count, material_unit_price, material_cost, material_name,
  construction_management, sales_channel, sales_store, slip_number,
  additional_construction, required_documents, required_documents_date,
  note, caution,
  sheet_count, mail_date, grid_connection_date, appointment_staff,
  sales_staff, sales_comment, visit_count, visit_staff,
  raw_source_file, raw_row_origin, source_fingerprint
)
FROM 'artifacts/filemaker-audit/solar/260312/phase3/deal-staging-v0.csv'
  WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
VALUES ('deal', 'copy', 5357, now(), now(), 'success', '260312');

-- ─────────────────────────────────────────────────────────────
-- Step 4: staging_activity_call load
-- ─────────────────────────────────────────────────────────────

\\COPY staging_activity_call (
  source_kind, call_date, call_time, call_staff, content, customer_staff,
  raw_phone, normalized_phone,
  matched_customer_id, matched_customer_candidate_count, match_type, fill_forward_customer_id,
  raw_source_file, raw_row_origin, source_fingerprint
)
FROM 'artifacts/filemaker-audit/solar/260312/phase3/activity-call-union-candidate.csv'
  WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
VALUES ('activity_call', 'copy', 97722, now(), now(), 'success', '260312');

-- ─────────────────────────────────────────────────────────────
-- Step 5: cross_source_fp を計算
-- ─────────────────────────────────────────────────────────────

UPDATE staging_activity_call
SET cross_source_fp = concat_ws('|',
    to_char(call_date, 'YYYY-MM-DD'),
    call_staff,
    left(content, 80)
  )
WHERE call_date IS NOT NULL;

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
SELECT 'activity_call', 'compute_cross_fp', COUNT(*), now(), now(), 'success', '260312'
FROM staging_activity_call WHERE cross_source_fp IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- Step 6: 厳密重複（Source B 側）を is_duplicate = TRUE にする
-- ─────────────────────────────────────────────────────────────

UPDATE staging_activity_call AS b
SET is_duplicate  = TRUE,
    review_status = 'duplicate'
WHERE b.source_kind = 'source_b'
  AND b.cross_source_fp IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM staging_activity_call AS a
    WHERE a.source_kind    = 'source_a'
      AND a.cross_source_fp = b.cross_source_fp
  );

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
SELECT 'activity_call', 'soft_dedupe_strict', COUNT(*), now(), now(), 'success', '260312'
FROM staging_activity_call WHERE is_duplicate = TRUE;

-- ─────────────────────────────────────────────────────────────
-- Step 7: ルーズ一致を review_status = 'needs_review' にする
-- ─────────────────────────────────────────────────────────────

UPDATE staging_activity_call AS b
SET review_status = 'needs_review'
WHERE b.source_kind   = 'source_b'
  AND b.is_duplicate  = FALSE
  AND b.call_date     IS NOT NULL
  AND b.call_staff    IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM staging_activity_call AS a
    WHERE a.source_kind  = 'source_a'
      AND a.call_date    = b.call_date
      AND a.call_staff   = b.call_staff
      AND (a.cross_source_fp IS DISTINCT FROM b.cross_source_fp)
  );

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
SELECT 'activity_call', 'soft_dedupe_loose', COUNT(*), now(), now(), 'success', '260312'
FROM staging_activity_call WHERE review_status = 'needs_review';

-- ─────────────────────────────────────────────────────────────
-- Step 8: manual resolution 反映
-- ─────────────────────────────────────────────────────────────

${manualUpdates}

-- ─────────────────────────────────────────────────────────────
-- Step 9: status_normalized 付与（temp table アプローチ）
-- ─────────────────────────────────────────────────────────────

-- NOTE: 以下はコメントアウト。status-dictionary-v3.csv の内容を確認してから実行すること。
-- status_normalized は unresolved を除いた status にのみ付与する。
--
-- CREATE TEMP TABLE _status_map (
--   status_value      TEXT PRIMARY KEY,
--   normalized_stage  TEXT
-- );
-- -- status-dictionary-v3.csv の normalized_stage_v3 != 'unresolved' の行を INSERT する
-- -- (スクリプトで自動生成 or 手動 INSERT)
--
-- UPDATE staging_deal d
-- SET status_normalized = m.normalized_stage
-- FROM _status_map m
-- WHERE d.status = m.status_value;
--
-- INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
-- SELECT 'deal', 'apply_status_normalized', COUNT(*), now(), now(), 'success', '260312'
-- FROM staging_deal WHERE status_normalized IS NOT NULL;
--
-- DROP TABLE _status_map;

COMMIT;
`;

  writeSql(resolve(OUT_DIR, 'staging-insert-draft-v1.sql'), sql);
}

// ═══════════════════════════════════════════════════════════════════════
// 8. generatePostcheckV1
// ═══════════════════════════════════════════════════════════════════════

function generatePostcheckV1(): void {
  const sql = `-- staging-postcheck-v1.sql — Solar 260312 Phase 6
-- NOTE: 実行禁止。Supabase 接続禁止。dry-run 相当。
-- 目的: staging load 後の整合性確認クエリ集
-- 生成日: ${today()}

-- ─────────────────────────────────────────────────────────────
-- 1. Row count（期待値チェック）
-- ─────────────────────────────────────────────────────────────

SELECT 'staging_customer'     AS table_name, COUNT(*) AS row_count, 5357   AS expected FROM staging_customer
UNION ALL
SELECT 'staging_deal',                        COUNT(*), 5357   FROM staging_deal
UNION ALL
SELECT 'staging_activity_call',               COUNT(*), 97722  FROM staging_activity_call;

-- 期待: row_count = expected の3行

-- ─────────────────────────────────────────────────────────────
-- 2. NOT NULL チェック
-- ─────────────────────────────────────────────────────────────

SELECT 'customer: customer_id NULL',   COUNT(*) FROM staging_customer WHERE customer_id IS NULL
UNION ALL
SELECT 'customer: source_fingerprint NULL', COUNT(*) FROM staging_customer WHERE source_fingerprint IS NULL
UNION ALL
SELECT 'deal: customer_id NULL',       COUNT(*) FROM staging_deal WHERE customer_id IS NULL
UNION ALL
SELECT 'deal: source_fingerprint NULL', COUNT(*) FROM staging_deal WHERE source_fingerprint IS NULL
UNION ALL
SELECT 'activity: source_kind NULL',   COUNT(*) FROM staging_activity_call WHERE source_kind IS NULL
UNION ALL
SELECT 'activity: source_fingerprint NULL', COUNT(*) FROM staging_activity_call WHERE source_fingerprint IS NULL;

-- 期待: 全て 0

-- ─────────────────────────────────────────────────────────────
-- 3. Uniqueness チェック
-- ─────────────────────────────────────────────────────────────

SELECT 'customer: duplicate customer_id',      COUNT(*) - COUNT(DISTINCT customer_id)      FROM staging_customer
UNION ALL
SELECT 'customer: duplicate source_fingerprint', COUNT(*) - COUNT(DISTINCT source_fingerprint) FROM staging_customer
UNION ALL
SELECT 'deal: duplicate source_fingerprint',   COUNT(*) - COUNT(DISTINCT source_fingerprint)   FROM staging_deal;

-- 期待: 全て 0

-- ─────────────────────────────────────────────────────────────
-- 4. Referential integrity チェック
-- ─────────────────────────────────────────────────────────────

SELECT 'deal: orphan customer_id', COUNT(*)
FROM staging_deal d
WHERE NOT EXISTS (
  SELECT 1 FROM staging_customer c WHERE c.customer_id = d.customer_id
);

-- 期待: 0

-- ─────────────────────────────────────────────────────────────
-- 5. source_kind 分布
-- ─────────────────────────────────────────────────────────────

SELECT source_kind, COUNT(*) AS row_count
FROM staging_activity_call
GROUP BY source_kind
ORDER BY source_kind;

-- 期待: source_a ~46572, source_b ~51150

-- ─────────────────────────────────────────────────────────────
-- 6. match_type 分布
-- ─────────────────────────────────────────────────────────────

SELECT match_type, COUNT(*) AS row_count
FROM staging_activity_call
GROUP BY match_type
ORDER BY row_count DESC;

-- ─────────────────────────────────────────────────────────────
-- 7. review_status 分布（新規追加）
-- ─────────────────────────────────────────────────────────────

SELECT review_status, COUNT(*) AS row_count
FROM staging_activity_call
GROUP BY review_status
ORDER BY review_status;

-- 期待例:
--   active       : ~89162 (97722 - 4280 strict dup - 3285 loose ≈ 90157 前後)
--   needs_review : ~3285
--   duplicate    : ~4280

-- ─────────────────────────────────────────────────────────────
-- 8. status / status_normalized 分布（新規追加）
-- ─────────────────────────────────────────────────────────────

SELECT status, status_normalized, COUNT(*) AS row_count
FROM staging_deal
GROUP BY status, status_normalized
ORDER BY row_count DESC
LIMIT 30;

-- ─────────────────────────────────────────────────────────────
-- 9. Load log サマリ
-- ─────────────────────────────────────────────────────────────

SELECT entity, action, row_count, status, completed_at
FROM staging_load_log
ORDER BY log_id;

-- ─────────────────────────────────────────────────────────────
-- 10. 完了マーカー
-- ─────────────────────────────────────────────────────────────

SELECT 'post_check_v1_complete' AS status, now() AS checked_at;
`;

  writeSql(resolve(OUT_DIR, 'staging-postcheck-v1.sql'), sql);
}

// ═══════════════════════════════════════════════════════════════════════
// 9. generateRollback
// ═══════════════════════════════════════════════════════════════════════

function generateRollback(manualResolution: HumanInputResult): void {
  const resolvedRows = manualResolution.rows.filter(
    (r) => r.decision_status === 'resolved' && r.chosen_strategy === 'assign_all',
  );

  let optionC: string;
  if (resolvedRows.length === 0) {
    optionC = `-- Option C: manual_resolved のみ元に戻す
-- resolved な manual resolution がないため、Option C は不要です。`;
  } else {
    const reverseUpdates = resolvedRows.map((r) => {
      const phone    = (r.normalized_phone || '').replace(/'/g, "''");
      const reviewId = (r.review_id || '').replace(/'/g, "''");
      return `-- ${reviewId}: ${phone} を multi_match に戻す
UPDATE staging_activity_call
SET matched_customer_id              = NULL,
    matched_customer_candidate_count = NULL,
    match_type                       = 'multi_match'
WHERE normalized_phone = '${phone}'
  AND source_kind      = 'source_a'
  AND match_type       = 'manual_resolved';`;
    }).join('\n\n');

    optionC = `-- Option C: manual_resolved のみ元に戻す
BEGIN;

${reverseUpdates}

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
VALUES ('activity_call', 'rollback_manual_resolve', NULL, now(), now(), 'rollback', '260312');

COMMIT;`;
  }

  const sql = `-- rollback-draft-v1.sql — Solar 260312 Phase 6
-- NOTE: 実行禁止。Supabase 接続禁止。dry-run 相当。
-- 目的: staging load のロールバック手順（草案）
-- 生成日: ${today()}

-- ─────────────────────────────────────────────────────────────
-- Option A: 全件クリア（最も強力）
-- staging_customer / deal / activity_call を全件削除する。
-- ロールバック後は staging-insert-draft-v1.sql を再実行すること。
-- ─────────────────────────────────────────────────────────────

BEGIN;

TRUNCATE staging_activity_call;
TRUNCATE staging_deal;
TRUNCATE staging_customer;

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
VALUES ('all', 'rollback_truncate', NULL, now(), now(), 'rollback', '260312');

COMMIT;

-- ─────────────────────────────────────────────────────────────
-- Option B: soft_dedupe のみ元に戻す
-- is_duplicate フラグと review_status を初期状態に戻す。
-- cross_source_fp は再計算可能なため NULL に戻す。
-- ─────────────────────────────────────────────────────────────

BEGIN;

UPDATE staging_activity_call
SET is_duplicate    = FALSE,
    review_status   = 'active',
    cross_source_fp = NULL;

INSERT INTO staging_load_log (entity, action, row_count, started_at, completed_at, status, _batch_id)
VALUES ('activity_call', 'rollback_soft_dedupe', NULL, now(), now(), 'rollback', '260312');

COMMIT;

-- ─────────────────────────────────────────────────────────────
${optionC}
`;

  writeSql(resolve(OUT_DIR, 'rollback-draft-v1.sql'), sql);
}

// ═══════════════════════════════════════════════════════════════════════
// 10. generateRunbook
// ═══════════════════════════════════════════════════════════════════════

function generateRunbook(manualResolution: HumanInputResult): void {
  const resolvedCount = manualResolution.rows.filter(
    (r) => r.decision_status === 'resolved',
  ).length;
  const assignAllCount = manualResolution.rows.filter(
    (r) => r.decision_status === 'resolved' && r.chosen_strategy === 'assign_all',
  ).length;

  const md = `# Staging Load Runbook v1 — Solar 260312 Phase 6

生成日: ${today()}

> このドキュメントは staging load の実行手順書です。
> **現時点では staging load を実行してはいけません。**
> go-no-go.md の判定が GO になるまで待機してください。

---

## 前提条件チェックリスト

実行前に以下を全て確認すること:

- [ ] staging-ddl-v1.sql の DDL が適用済みであること
- [ ] staging-precheck-v1.sql の全チェックが PASS していること
- [ ] CSV ファイルの行数が期待値と一致すること（wc -l で確認）
- [ ] phase6-go-no-go.md の判定が GO であること（現在: **CONDITIONAL-GO → 実行不可**）
- [ ] 残ブロッカーが全て解消されていること
- [ ] DB バックアップが取得済みであること（Supabase ダッシュボード）

---

## Step 0: 環境確認

\`\`\`bash
# 接続確認（psql のみ。Supabase UI からは実行しない）
psql $DATABASE_URL -c "SELECT current_database(), now();"

# CSV ファイル行数確認
wc -l artifacts/filemaker-audit/solar/260312/phase3/customer-staging-v0.csv
wc -l artifacts/filemaker-audit/solar/260312/phase3/deal-staging-v0.csv
wc -l artifacts/filemaker-audit/solar/260312/phase3/activity-call-union-candidate.csv
\`\`\`

---

## Step 1: DDL 適用

\`\`\`bash
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-ddl-v1.sql
\`\`\`

確認事項:
- [ ] 5テーブルが CREATE されたこと
- [ ] エラーがないこと

---

## Step 2: Precheck

\`\`\`bash
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-precheck-v1.sql
\`\`\`

確認事項:
- [ ] 5テーブルが存在すること
- [ ] 全テーブルの行数が 0 であること（初回実行時）
- [ ] 制約が存在すること

---

## Step 3: Load 実行

\`\`\`bash
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-insert-draft-v1.sql
\`\`\`

確認事項:
- [ ] COMMIT まで到達したこと
- [ ] エラーが出ていないこと

---

## Step 4: Postcheck

\`\`\`bash
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-postcheck-v1.sql
\`\`\`

確認事項:
- [ ] row_count が期待値と一致すること（customer: 5357, deal: 5357, activity_call: 97722）
- [ ] NOT NULL チェックが全て 0 であること
- [ ] Uniqueness チェックが全て 0 であること
- [ ] review_status 分布が期待値の範囲内であること

---

## Manual Resolution 反映件数サマリ

| 項目 | 件数 |
|------|------|
| resolved 件数 | ${resolvedCount} |
| assign_all 件数（INSERT に反映） | ${assignAllCount} |

${resolvedCount === 0 ? '> **反映対象なし**: manual-resolution-template.csv に記入がありません。' : ''}

---

## 注意事項

- **DB 実行禁止**: go-no-go.md が GO になるまで psql を実行してはいけない
- **raw ファイル編集禁止**: CSV ファイルを直接編集してはいけない
- **idempotent**: 再実行時は Step 3 の TRUNCATE から再開できる（rollback-draft-v1.sql の Option A を参照）
- **ロールバック**: 問題が発生した場合は rollback-draft-v1.sql を参照する

---

## 再生成コマンド

\`\`\`bash
npm run audit:solar:phase6
\`\`\`
`;

  writeMd(resolve(OUT_DIR, 'staging-load-runbook-v1.md'), md);
}

// ═══════════════════════════════════════════════════════════════════════
// 11. generateLoadOrder
// ═══════════════════════════════════════════════════════════════════════

function generateLoadOrder(): void {
  const md = `# Staging Load Order v1 — Solar 260312 Phase 6

生成日: ${today()}

---

## 実行シーケンス

\`\`\`
Step 0: 環境確認
        ↓
Step 1: DDL 適用（staging-ddl-v1.sql）
        ↓
Step 2: Precheck（staging-precheck-v1.sql）
        ↓
Step 3: TRUNCATE（insert-draft の Step 1）
        ↓
Step 4: staging_customer load（COPY）
        ↓
Step 5: staging_deal load（COPY）
        ↓
Step 6: staging_activity_call load（COPY）
        ↓
Step 7: cross_source_fp 計算 + soft_dedupe 適用
        ↓
Step 8: manual resolution 反映（resolved 件数に応じて）
        ↓
Step 9: Postcheck（staging-postcheck-v1.sql）
        ↓
Step 10: Load log 確認 → 完了
\`\`\`

---

## 期待値テーブル

| エンティティ | 行数 | 確認列 |
|------------|------|--------|
| staging_customer | 5,357 | customer_id（NOT NULL, UNIQUE）, source_fingerprint（UNIQUE） |
| staging_deal | 5,357 | deal_id（自動採番）, customer_id（NOT NULL）, source_fingerprint（UNIQUE） |
| staging_activity_call | 97,722 | source_kind（check 制約）, review_status（active/needs_review/duplicate） |

### soft_dedupe 適用後の activity_call 内訳（目安）

| review_status | 件数（目安） | 説明 |
|--------------|------------|------|
| active | ~89,000〜90,000 | 通常行 |
| needs_review | ~3,285 | ルーズ一致（要確認） |
| duplicate | ~4,280 | 厳密重複（B 側 inactive） |

---

## Re-run 手順

staging load に問題が生じた場合や、再実行が必要な場合:

\`\`\`bash
# 1. Option A ロールバック（全件クリア）
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/rollback-draft-v1.sql

# 2. insert-draft を再実行
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-insert-draft-v1.sql

# 3. postcheck で確認
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-postcheck-v1.sql
\`\`\`

---

## 依存関係

| ステップ | 依存先 |
|---------|--------|
| staging_deal load | staging_customer（customer_id 参照） |
| staging_activity_call load | 独立（customer FK はコメントアウト中） |
| soft_dedupe 適用 | staging_activity_call load 完了後 |
| manual resolution 反映 | staging_activity_call load + soft_dedupe 完了後 |
| status_normalized 付与 | staging_deal load + status-dictionary-v3.csv 確定後 |
`;

  writeMd(resolve(OUT_DIR, 'staging-load-order-v1.md'), md);
}

// ═══════════════════════════════════════════════════════════════════════
// 12. generateGoNoGo
// ═══════════════════════════════════════════════════════════════════════

function generateGoNoGo(
  highPriority: HumanInputResult,
  manualResolution: HumanInputResult,
  statusHearing: HumanInputResult,
  issues: ValidationIssue[],
): void {
  const errors = issues.filter((i) => i.severity === 'error');

  const resolvedCount = manualResolution.rows.filter(
    (r) => r.decision_status === 'resolved',
  ).length;

  const confirmedStatusCount = statusHearing.rows.filter(
    (r) => r.confirmed_stage && r.confirmed_stage.trim() !== '',
  ).length;

  let verdict: 'NO-GO' | 'CONDITIONAL-GO';
  let verdictReason: string;

  if (highPriority.missing || manualResolution.missing) {
    verdict = 'NO-GO';
    verdictReason = '必須入力ファイルが欠損しています（high-priority-review-packet.csv または manual-resolution-template.csv が見つかりません）';
  } else if (resolvedCount === 0 && confirmedStatusCount === 0) {
    verdict = 'CONDITIONAL-GO';
    verdictReason = '人手入力がまだありません。DDL / Load Package は生成済みですが、staging load 前に残ブロッカーの解消が必要です。';
  } else {
    verdict = 'CONDITIONAL-GO';
    verdictReason = `一部の人手入力が反映されました（resolved: ${resolvedCount} 件, confirmed_stage: ${confirmedStatusCount} 件）。ただし残ブロッカーが未解消のため GO ではありません。`;
  }

  const artifacts = [
    'resolution-validation-report.md',
    'status-dictionary-v3.csv',
    'status-normalization-decision-log.md',
    'activity-call-merge-policy-v1.md',
    'staging-ddl-v1.sql',
    'staging-load-runbook-v1.md',
    'staging-load-order-v1.md',
    'staging-precheck-v1.sql',
    'staging-insert-draft-v1.sql',
    'staging-postcheck-v1.sql',
    'rollback-draft-v1.sql',
  ];

  const md = `# Phase 6 Go / No-Go — Solar 260312

生成日: ${today()}

---

## 総合判定

### ${verdict === 'NO-GO' ? '❌ NO-GO' : '⚠️ CONDITIONAL-GO'}

**理由**: ${verdictReason}

---

## 今回生成した成果物チェックリスト

| # | ファイル | 状態 |
|---|---------|------|
${artifacts.map((f, i) => `| ${i + 1} | ${f} | ✅ 生成済み |`).join('\n')}
| 12 | phase6-go-no-go.md | ✅ 生成済み |
| 13 | phase6-summary.md | ✅ 生成済み（次に生成） |

---

## 人手レビュー反映状況

| 項目 | 状態 | 件数 |
|------|------|------|
| manual-resolution-template.csv | ${manualResolution.missing ? '**ファイル欠損**' : '存在'} | resolved: ${resolvedCount} 件 |
| status-hearing-sheet.csv | ${statusHearing.missing ? '**ファイル欠損**' : '存在'} | confirmed_stage: ${confirmedStatusCount} 件 |

---

## Validation ERROR 件数

| 種別 | 件数 |
|------|------|
| ERROR | **${errors.length}** |

${errors.length > 0 ? `### ERROR 一覧\n\n| ファイル | row_id | フィールド | メッセージ |\n|---------|--------|----------|----------|\n${errors.map((e) => `| ${e.file} | ${e.row_id} | ${e.field} | ${e.message} |`).join('\n')}\n` : ''}

---

## 今すぐ staging load してよいか？

**No。** 以下の残ブロッカーが全て解消されるまで staging load を実行してはいけません。

---

## 残ブロッカー一覧

| # | ブロッカー | 状態 |
|---|-----------|------|
| 1 | Source A/B が同一 FileMaker DB の別エクスポートであることの現場確認 | 未完了 |
| 2 | 厳密重複 ~4,280 件の判定（同一レコードと確定してよいか）の現場確認 | 未完了 |
| 3 | customer:deal の関係（1:1 vs 1:N）のヒアリング確定 → FK 解除またはコメントアウト継続の決定 | 未完了 |
| 4 | status-dictionary-v3.csv の unresolved 件数を0にすること（または unresolved のまま許容する判断） | 未完了 |
| 5 | manual-resolution-template.csv の全 high priority 項目への回答（または defer 判断） | 未完了 |
| 6 | staging load 実行環境（Supabase プロジェクト）の準備完了確認 | 未完了 |
| 7 | staging load 実行前の DB バックアップ取得 | 未完了 |

---

## 次のステップ

1. 残ブロッカーを1つずつ解消する
2. manual-resolution-template.csv / status-hearing-sheet.csv に追記した場合は \`npm run audit:solar:phase6\` を再実行する
3. 全ブロッカーが解消されたら Phase 7（staging load 実行・postcheck 確認）に進む
`;

  writeMd(resolve(OUT_DIR, 'phase6-go-no-go.md'), md);
}

// ═══════════════════════════════════════════════════════════════════════
// 13. generatePhase6Summary
// ═══════════════════════════════════════════════════════════════════════

function generatePhase6Summary(
  highPriority: HumanInputResult,
  manualResolution: HumanInputResult,
  statusHearing: HumanInputResult,
  issues: ValidationIssue[],
  statusDictV2: HumanInputResult,
): void {
  const errors   = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  const resolvedCount = manualResolution.rows.filter(
    (r) => r.decision_status === 'resolved',
  ).length;
  const confirmedStatusCount = statusHearing.rows.filter(
    (r) => r.confirmed_stage && r.confirmed_stage.trim() !== '',
  ).length;
  const unresolvedStatusCount = statusDictV2.rows.filter(
    (r) => r.stage_confidence !== 'high',
  ).length;

  const artifacts: { num: number; file: string; type: string }[] = [
    { num: 1,  file: 'resolution-validation-report.md',    type: 'markdown' },
    { num: 2,  file: 'status-dictionary-v3.csv',           type: 'CSV' },
    { num: 3,  file: 'status-normalization-decision-log.md', type: 'markdown' },
    { num: 4,  file: 'activity-call-merge-policy-v1.md',   type: 'markdown' },
    { num: 5,  file: 'staging-ddl-v1.sql',                 type: 'SQL' },
    { num: 6,  file: 'staging-load-runbook-v1.md',         type: 'markdown' },
    { num: 7,  file: 'staging-load-order-v1.md',           type: 'markdown' },
    { num: 8,  file: 'staging-precheck-v1.sql',            type: 'SQL' },
    { num: 9,  file: 'staging-insert-draft-v1.sql',        type: 'SQL' },
    { num: 10, file: 'staging-postcheck-v1.sql',           type: 'SQL' },
    { num: 11, file: 'rollback-draft-v1.sql',              type: 'SQL' },
    { num: 12, file: 'phase6-go-no-go.md',                 type: 'markdown' },
    { num: 13, file: 'phase6-summary.md',                  type: 'markdown' },
  ];

  const md = `# Phase 6 Summary — Solar 260312

生成日: ${today()}

---

## 概要

Phase 6 では、Phase 5 で生成した人手レビューテンプレートへの現場回答を ingest・検証し、
staging DDL・load package を確定版（v1）に昇格させました。
DB接続・SQL実行・rawファイル編集は行っていません。

---

## 変更概要

- Phase 5 の人手入力ファイル（3ファイル）を読み込んでバリデーションした
- status-dictionary-v3.csv を生成した（ヒアリング回答を反映、未回答は unresolved）
- activity-call の merge 方針を Pattern 2（soft_dedupe_by_cross_source_fp）に確定した
- staging DDL を v0 草案から v1 確定版に昇格させた（PK・UNIQUE・CHECK・インデックス確定）
- staging_activity_call に merge policy v1 の新規列（cross_source_fp / is_duplicate / review_status）を追加した
- staging_deal に status_normalized 列を追加した
- load package（insert-draft / precheck / postcheck / rollback / runbook / load-order）を生成した
- go-no-go 判定を行った（現在: CONDITIONAL-GO）

---

## 生成した成果物一覧（13件）

| # | ファイル | 種別 |
|---|---------|------|
${artifacts.map((a) => `| ${a.num} | ${a.file} | ${a.type} |`).join('\n')}

---

## Resolution 反映サマリ

| 項目 | 件数 |
|------|------|
| high-priority-review-packet.csv | ${highPriority.rows.length} 行（${highPriority.missing ? 'MISSING' : '読み込み済み'}） |
| manual-resolution-template.csv | ${manualResolution.rows.length} 行（${manualResolution.missing ? 'MISSING' : '読み込み済み'}） |
| status-hearing-sheet.csv | ${statusHearing.rows.length} 行（${statusHearing.missing ? 'MISSING' : '読み込み済み'}） |
| resolved 件数 | ${resolvedCount} |
| confirmed_stage 件数 | ${confirmedStatusCount} |

${resolvedCount === 0 && confirmedStatusCount === 0 ? '> **反映対象なし**: 人手入力がまだ記入されていません。\n' : ''}

---

## Validation サマリ

| 種別 | 件数 |
|------|------|
| ERROR | ${errors.length} |
| WARNING | ${warnings.length} |

---

## Status Dictionary v3 サマリ

| 項目 | 件数 |
|------|------|
| 全 status 数（v2から引き継ぎ） | ${statusDictV2.rows.length} |
| ヒアリング未回答（requires_hearing） | ${unresolvedStatusCount} |
| confirmed_stage 記入済み | ${confirmedStatusCount} |

---

## Merge Policy v1 サマリ

| 項目 | 内容 |
|------|------|
| 採用パターン | Pattern 2: soft_dedupe_by_cross_source_fp |
| staging 投入行数 | 97,722 行（全件） |
| 厳密重複（B側 inactive） | ~4,280 件 |
| ルーズ一致（needs_review） | ~3,285 件 |
| 物理削除 | 禁止 |

---

## DDL / Load Package サマリ

| ファイル | 内容 |
|---------|------|
| staging-ddl-v1.sql | PK/UNIQUE/CHECK/インデックス確定版 |
| staging-insert-draft-v1.sql | TRUNCATE → COPY → soft_dedupe → manual resolution → COMMIT |
| staging-precheck-v1.sql | テーブル存在・行数・制約・disk space 確認 |
| staging-postcheck-v1.sql | row count / NOT NULL / uniqueness / distribution 確認 |
| rollback-draft-v1.sql | Option A（全件）/ B（soft_dedupe）/ C（manual_resolved）の3択 |

---

## 変更ファイル一覧

### 新規作成（artifacts/filemaker-audit/solar/260312/phase6/）

${artifacts.map((a) => `- ${a.file}`).join('\n')}

---

## 実行コマンド

\`\`\`bash
npm run audit:solar:phase6
\`\`\`
`;

  writeMd(resolve(OUT_DIR, 'phase6-summary.md'), md);
}

// ─── entrypoint ──────────────────────────────────────────────────────
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
