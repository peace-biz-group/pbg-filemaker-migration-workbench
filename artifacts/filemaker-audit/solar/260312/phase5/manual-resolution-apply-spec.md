# Manual Resolution Apply Spec — Solar 260312

> このドキュメントは、manual-resolution-template.csv に記入された人手判断を
> staging データに反映する方法を定義します。

生成日: 2026-04-07

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
| `resolved` | 正しい顧客を特定できた | chosen_customer_id を staging に反映 |
| `skip` | 今回はスキップ（後で対応） | staging は変更しない |
| `unclear` | 判断できない | エスカレーション対象 |
| `defer` | 追加情報が必要 | 保留。Phase 6 以降で再検討 |

## chosen_strategy の選択肢

| 値 | 意味 | 適用方法 |
|-----|------|---------|
| `assign_all` | この電話番号の全コールを chosen_customer_id に紐付け | staging_activity_call の matched_customer_id を更新 |
| `assign_by_date` | 日付範囲ごとに異なる顧客に紐付け | note に日付範囲と顧客 ID を記載。手動で分割 |
| `split` | コールごとに個別判断が必要 | 個別レビュー用の詳細テンプレートを別途生成 |

---

## 反映ルール

### どの列を見るか

1. `review_id` → high-priority-review-packet.csv と紐付け
2. `decision_status` → `resolved` のみ反映
3. `chosen_customer_id` → 反映先の顧客 ID
4. `chosen_strategy` → 反映方法

### どの staging row に反映するか

```
対象: staging_activity_call
条件:
  - normalized_phone = template.normalized_phone
  - source_kind = 'source_a'  (Source A のみ。Source B は fill_forward_customer_id で紐付け済み)
  - match_type IN ('multi_match')
```

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

```sql
-- decision_status = 'resolved' AND chosen_strategy = 'assign_all' の場合
-- NOTE: 実行禁止。Phase 6 で確認後に実行。

UPDATE staging_activity_call
SET matched_customer_id = :chosen_customer_id,
    matched_customer_candidate_count = 1,
    match_type = 'manual_resolved'
WHERE normalized_phone = :normalized_phone
  AND source_kind = 'source_a'
  AND match_type = 'multi_match';
```

---

## 反映フロー

```
1. 現場が manual-resolution-template.csv を記入
2. 記入済み CSV を Phase 6 スクリプトに渡す
3. スクリプトが decision_status = 'resolved' の行を抽出
4. staging_activity_call を UPDATE
5. 更新件数と match_type 分布を postcheck で確認
6. 変更ログを staging_load_log に記録
```

---

## 安全策

1. **dry-run モード**: 反映前に UPDATE 対象行数を表示。実行は手動確認後
2. **バックアップ**: UPDATE 前に staging_activity_call の snapshot を保存
3. **ロールバック**: match_type = 'manual_resolved' の行を元の 'multi_match' に戻す逆 UPDATE を用意
4. **監査**: 変更日時・変更者・review_id を staging_load_log に記録
