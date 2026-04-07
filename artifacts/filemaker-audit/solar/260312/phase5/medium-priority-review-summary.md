# Medium Priority Review Summary — Solar 260312

> medium priority のレビュー項目を bucket 単位でまとめたものです。
> 全件の個別レビューではなく、bucket ごとの一括処理方針を示します。

生成日: 2026-04-07

---

## 概要

| 項目 | 値 |
|------|-----|
| 対象コール行数 | 2669 件 |
| bucket 数 | 3 |

## bucket 別内訳

| Bucket | コール行数 | ユニーク電話番号数 | 推奨処理 |
|--------|----------|-----------------|---------|
| no_match | 608 | 316 | investigate_or_defer |
| family_shared_phone | 1851 | 74 | content_based_batch_match |
| unclear | 210 | 7 | individual_review |

---

## bucket 別の処理方針

### family_shared_phone (1851 件)

同一住所の家族が電話番号を共有しているケース。

**処理方針**:
1. コール内容に個人名が出ている場合 → その顧客 ID に紐付け
2. 個人名が出ていない場合 → Source B の fill_forward_customer_id を採用
3. どちらも判断できない場合 → 世帯主（customer_id が若い方）に仮紐付け + `match_confidence=low` フラグ

**一括処理の可否**: 部分的に可能。名前が出ているケースは grep で抽出できる。

### no_match (608 件)

有効な電話番号だが顧客マスタに該当なし。

**処理方針**:
1. staging 投入時は `matched_customer_id = NULL` のまま保持
2. 電話番号が複数回出現 → 新規顧客の可能性。現場に確認
3. 1回のみ出現 → 番号変更 or 誤入力の可能性。低優先

**一括処理の可否**: 一括で `matched_customer_id = NULL` 処理可能。個別確認は後回し。

### unclear (210 件)

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
