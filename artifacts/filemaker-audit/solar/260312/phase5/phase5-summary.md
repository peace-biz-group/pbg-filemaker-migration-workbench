# Phase 5 Summary — Solar 260312

生成日: 2026-04-07

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
| 対象コール行数 | 462 件 |
| レビュー項目数（電話番号別） | 29 件 |
| review_bucket: unclear | 313 件 |
| review_bucket: same_name_same_phone | 60 件 |
| review_bucket: same_phone_different_name | 89 件 |

review packet は CSV に候補顧客の名前・住所を付加し、
現場が content_preview を読んで `chosen_customer_id` を記入できる形式。

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
| ヒアリング対象ステータス | 10 件 |
| 対象 deal 行数 | 97 件 |
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
| 8 | low confidence ステータス 8 件の意味 | 75 deal 行 | 業務担当者 |

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
| package.json | `audit:solar:phase5` スクリプト追加 |

---

## 実行コマンド

```bash
npm run audit:solar:phase5
```
