# Phase 3 Summary — Solar 260312

生成日: 2026-04-06

## 生成した staging CSV

| ファイル | 行数 | 説明 |
|---------|------|------|
| customer-staging-v0.csv | 5357 | 顧客基本情報 |
| deal-staging-v0.csv | 5357 | 案件・契約情報 |
| activity-call-source-a-staging-v0.csv | 46572 | コール履歴（独立XLSX） |
| activity-call-source-b-staging-v0.csv | 51150 | コール履歴（ポータル展開） |
| activity-call-union-candidate.csv | 97722 | コール履歴統合候補（hard dedupe なし） |

## Review Queue

| ファイル | 行数 | 説明 |
|---------|------|------|
| activity-call-match-review-queue.csv | 3806 | 電話番号マッチ要レビュー |
| customer-deal-boundary-review-queue.csv | 15 | customer/deal 境界判断 |
| status-dictionary-candidate.csv | 16 | ステータス値辞書候補 |

## 電話番号マッチ内訳 (Source A)

| 分類 | 件数 |
|------|------|
| multi_match (要レビュー) | 2860 |
| no_match (要レビュー) | 608 |
| invalid (要レビュー) | 338 |

## ステータス値 (上位)

| 値 | 件数 | 割合 | normalized_stage | confidence |
|---|------|------|-----------------|------------|
| キャンセル | 3999 | 74.6% | cancelled | high |
| 完了 | 1198 | 22.4% | completed | high |
| 再訪問調整中 | 35 | 0.7% | unresolved | low |
| FIT許可待ち | 34 | 0.6% | waiting_fit_approval | high |
| 回収保留 | 19 | 0.4% | unresolved | low |
| 工事待ち | 16 | 0.3% | waiting_construction | high |
| 対応中 | 15 | 0.3% | in_progress | medium |
| 見積待ち | 10 | 0.2% | waiting_estimate | high |
| 現調待ち | 8 | 0.1% | unresolved | low |
| 書類待ち | 7 | 0.1% | waiting_documents | medium |

## Traceability

すべての staging CSV に以下の列を付与:
- `raw_source_file`: 元ファイル名
- `raw_row_origin`: 元ファイルの行番号
- `source_fingerprint`: `file:row_N` 形式の一意識別子

## 未確定事項 (要ヒアリング)

1. customer / deal の 1:1 vs 1:N 関係
2. 「契約者」と顧客の同一性
3. 「代表者」の意味（法人代表か個人の同居家族か）
4. 見積依頼日 vs 【見積】依頼日の関係
5. ステータス「連変」「取り直し」の業務的意味
6. multi_match ケースの正しい紐付け方法
7. Source A / B のどちらを primary とするか
8. 商流・販売店・設置店名の entity 化要否

## 次にやるべきこと

1. **業務ヒアリング**: status dictionary の要確認項目を現場に確認
2. **multi_match レビュー**: review queue の high severity を優先処理
3. **Source A/B 統合方針決定**: overlap 分析結果をもとに merge strategy を確定
4. **schema v1 策定**: ヒアリング結果を反映し、確定版 schema を作成
5. **DDL 実行**: staging テーブルを Supabase に作成（Phase 4）
6. **staging insert**: CSV を staging テーブルに投入（Phase 4）
