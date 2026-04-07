# Phase 4 Summary — Solar 260312

生成日: 2026-04-06

## 概要

Phase 4 は staging load plan の確定を目的とする。
DB 実行前の最終整理に限定し、DDL 実行・Supabase 接続・本番 insert は行わない。

---

## 生成した成果物

| # | ファイル | 説明 |
|---|---------|------|
| 1 | staging-load-spec.md | staging load 仕様書 |
| 2 | staging-load-spec.json | staging load 仕様 (machine-readable) |
| 3 | key-policy.md | unique key / fingerprint / natural key ポリシー |
| 4 | dedupe-policy.md | 重複検出・統合ポリシー |
| 5 | activity-call-merge-policy.md | Source A/B merge 方針 (3案比較 + 推奨) |
| 6 | activity-call-match-review-queue-prioritized.csv | 優先順位付き review queue |
| 7 | status-dictionary-candidate-v2.csv | ステータス辞書 v2 (ヒアリング質問付き) |
| 8 | status-hearing-guide.md | ステータスヒアリングガイド |
| 9 | staging-load-order.md | load 実行順序 |
| 10 | staging-precheck.sql | 実行前チェック SQL (草案・未実行) |
| 11 | staging-postcheck.sql | 実行後チェック SQL (草案・未実行) |
| 12 | staging-ddl-draft-v1.sql | DDL 草案 v1 (草案・未実行) |
| 13 | phase4-summary.md | このファイル |

---

## Load Spec サマリ

| Entity | Table | Rows | Load Order | Dependencies |
|--------|-------|------|-----------|-------------|
| customer | staging_customer | 5,357 | 1 | なし |
| deal | staging_deal | 5,357 | 2 | staging_customer |
| activity_call | staging_activity_call | 97,722 | 3 | staging_customer |

- Load Strategy: TRUNCATE + INSERT (idempotent)
- Provenance: 全行に raw_source_file + raw_row_origin + source_fingerprint
- Schema Version: v0 (provisional)

---

## Key / Dedupe Policy サマリ

### customer
- **PK**: customer_id (FileMaker 自動採番、ユニーク確認済み)
- **Natural Key 候補**: phone + furigana (medium confidence)
- **Dedupe**: staging では実施しない。soft dedupe rules を定義済み

### deal
- **PK**: deal_id (surrogate、staging 投入時に自動生成)
- **FK**: customer_id → staging_customer
- **1:1 / 1:N**: 現 batch では 1:1。schema は 1:N 対応可能

### activity_call
- **PK**: activity_call_id (surrogate)
- **Cross-source FP**: call_date + call_staff + content_first_80
- **Dedupe**: Source A/B 間の 11% 重複は staging 投入後に判断

---

## Merge Policy 推奨案

**案 3: 並存保持 + Downstream Review** を推奨。

| 理由 | 詳細 |
|------|------|
| データ完全性 | A のみ 35,372 件 + B のみ 34,689 件を両方保持 |
| 安全性 | 統合判断を Phase 5 に先送り。可逆性を確保 |
| 柔軟性 | どの merge strategy にも後から切り替え可能 |
| CLAUDE.md 整合 | 「unsafe な自動確定をしない」に合致 |

---

## Prioritized Review Queue サマリ

| 分類 | 件数 | 内訳 |
|------|------|------|
| multi_match | 2860 | 2候補: ~2,130 / 3-5候補: ~383 / 19候補: 337 |
| no_match | 608 | 有効な電話番号だが顧客マスタに該当なし |
| invalid | 338 | 電話番号フィールドに非電話データ |
| **合計** | **3806** | |

### multi_match サブ分類

| Bucket | 説明 | 対処方針 |
|--------|------|---------|
| family_shared_phone | 同一住所の家族が電話番号を共有 | コール内容から対象者を特定 |
| same_phone_different_name | 異なる人物が同一電話番号を使用 | コール内容/日付から正しい顧客を特定 |
| same_name_same_phone | 同一人物が複数 ID で登録 | 統合候補 |
| unclear | パターン不明 | 個別レビュー |
| (19候補) | 営業担当の携帯番号等 | 電話番号の持ち主を確認 |

---

## Unresolved / 要ヒアリング事項

### 高優先

| # | 項目 | 影響範囲 | 確認先 |
|---|------|---------|--------|
| 1 | Source A/B のどちらが primary か | activity_call 97,722 件 | 現場/FileMaker 管理者 |
| 2 | customer / deal の 1:1 vs 1:N | スキーマ設計 | 業務担当者 |
| 3 | 「連変」「取り直し」の業務的意味 | 審査結果の正規化 | 業務担当者 |
| 4 | multi_match (19候補) の電話番号 09094847774 の持ち主 | 337 コール行 | 営業担当者 |

### 中優先

| # | 項目 | 影響範囲 | 確認先 |
|---|------|---------|--------|
| 5 | 「再訪問調整中」等 8 件の low confidence ステータス | 88 deal 行 | 業務担当者 |
| 6 | 「契約者」と顧客の同一性 | customer/deal 境界 | 業務担当者 |
| 7 | 「代表者」の意味 (法人代表 or 世帯主) | customer スキーマ | 業務担当者 |
| 8 | 見積依頼日 vs 【見積】依頼日の関係 | deal 列の統合判断 | 業務担当者 |

### 低優先

| # | 項目 | 影響範囲 | 確認先 |
|---|------|---------|--------|
| 9 | 設置店名 / 販売店 / 商流の entity 化 | 将来のマスタ設計 | Phase 5 以降 |
| 10 | 「お客様担当」列の意味 | activity_call | 業務担当者 |

---

## 次にやるべきこと

### Phase 5 予定

1. **ヒアリング実施**: status-hearing-guide.md に基づく現場確認
2. **multi_match 優先レビュー**: prioritized review queue の high priority から処理
3. **Source A/B merge 実行**: merge policy に基づく統合
4. **DDL 実行**: staging-ddl-draft-v1.sql を確定版に昇格し、Supabase に作成
5. **staging INSERT**: staging-load-order.md に従い投入
6. **post-check 実行**: staging-postcheck.sql で整合性確認
7. **schema v1 策定**: ヒアリング結果を反映した確定版 schema

---

## 実行コマンド

```bash
# Phase 4 成果物の再生成
npm run audit:solar:phase4
```

---

## 変更ファイル一覧

### 新規作成

| ファイル | パス |
|---------|------|
| Phase 4 スクリプト | scripts/audit-solar-260312-phase4.ts |
| staging-load-spec.md | artifacts/filemaker-audit/solar/260312/phase4/staging-load-spec.md |
| staging-load-spec.json | artifacts/filemaker-audit/solar/260312/phase4/staging-load-spec.json |
| key-policy.md | artifacts/filemaker-audit/solar/260312/phase4/key-policy.md |
| dedupe-policy.md | artifacts/filemaker-audit/solar/260312/phase4/dedupe-policy.md |
| activity-call-merge-policy.md | artifacts/filemaker-audit/solar/260312/phase4/activity-call-merge-policy.md |
| activity-call-match-review-queue-prioritized.csv | artifacts/filemaker-audit/solar/260312/phase4/activity-call-match-review-queue-prioritized.csv |
| status-dictionary-candidate-v2.csv | artifacts/filemaker-audit/solar/260312/phase4/status-dictionary-candidate-v2.csv |
| status-hearing-guide.md | artifacts/filemaker-audit/solar/260312/phase4/status-hearing-guide.md |
| staging-load-order.md | artifacts/filemaker-audit/solar/260312/phase4/staging-load-order.md |
| staging-precheck.sql | artifacts/filemaker-audit/solar/260312/phase4/staging-precheck.sql |
| staging-postcheck.sql | artifacts/filemaker-audit/solar/260312/phase4/staging-postcheck.sql |
| staging-ddl-draft-v1.sql | artifacts/filemaker-audit/solar/260312/phase4/staging-ddl-draft-v1.sql |
| phase4-summary.md | artifacts/filemaker-audit/solar/260312/phase4/phase4-summary.md |

### 変更

| ファイル | 変更内容 |
|---------|---------|
| package.json | `audit:solar:phase4` スクリプト追加 |
