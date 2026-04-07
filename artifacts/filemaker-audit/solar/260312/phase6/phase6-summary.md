# Phase 6 Summary — Solar 260312

生成日: 2026-04-07

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
| 1 | resolution-validation-report.md | markdown |
| 2 | status-dictionary-v3.csv | CSV |
| 3 | status-normalization-decision-log.md | markdown |
| 4 | activity-call-merge-policy-v1.md | markdown |
| 5 | staging-ddl-v1.sql | SQL |
| 6 | staging-load-runbook-v1.md | markdown |
| 7 | staging-load-order-v1.md | markdown |
| 8 | staging-precheck-v1.sql | SQL |
| 9 | staging-insert-draft-v1.sql | SQL |
| 10 | staging-postcheck-v1.sql | SQL |
| 11 | rollback-draft-v1.sql | SQL |
| 12 | phase6-go-no-go.md | markdown |
| 13 | phase6-summary.md | markdown |

---

## Resolution 反映サマリ

| 項目 | 件数 |
|------|------|
| high-priority-review-packet.csv | 29 行（読み込み済み） |
| manual-resolution-template.csv | 29 行（読み込み済み） |
| status-hearing-sheet.csv | 10 行（読み込み済み） |
| resolved 件数 | 0 |
| confirmed_stage 件数 | 0 |

> **反映対象なし**: 人手入力がまだ記入されていません。


---

## Validation サマリ

| 種別 | 件数 |
|------|------|
| ERROR | 0 |
| WARNING | 0 |

---

## Status Dictionary v3 サマリ

| 項目 | 件数 |
|------|------|
| 全 status 数（v2から引き継ぎ） | 16 |
| ヒアリング未回答（requires_hearing） | 10 |
| confirmed_stage 記入済み | 0 |

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

- resolution-validation-report.md
- status-dictionary-v3.csv
- status-normalization-decision-log.md
- activity-call-merge-policy-v1.md
- staging-ddl-v1.sql
- staging-load-runbook-v1.md
- staging-load-order-v1.md
- staging-precheck-v1.sql
- staging-insert-draft-v1.sql
- staging-postcheck-v1.sql
- rollback-draft-v1.sql
- phase6-go-no-go.md
- phase6-summary.md

---

## 実行コマンド

```bash
npm run audit:solar:phase6
```
