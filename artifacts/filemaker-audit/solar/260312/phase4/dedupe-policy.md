# Dedupe Policy — Solar 260312

> **注意**: このポリシーは草案 (v0) です。hard dedupe は Phase 4 では実施しません。

生成日: 2026-04-06

---

## 原則

1. **staging では dedupe しない** — 全件を投入し、重複候補のフラグのみ付与
2. **soft dedupe = 候補抽出** — 人手レビューの対象を絞る
3. **hard dedupe = 確定統合** — ヒアリング後に Phase 5 以降で実施
4. **元データの保全** — 統合後も source_fingerprint で原本に遡れること

---

## customer dedupe

### 方針

customer_id (お客様ID) が FileMaker 自動採番のため、同一 customer_id の重複は発生しない。
ただし、**同一人物が異なる customer_id で登録されている可能性** がある。

### Soft Dedupe Rules

| Rule | 条件 | 期待件数 | Action |
|------|------|---------|--------|
| same_phone_same_address | phone が一致 AND 住所の都道府県+市区が一致 | 要調査 | 統合候補として review queue へ |
| same_furigana_same_phone | furigana が一致 AND phone が一致 | 要調査 | 高確率重複。review queue (priority: high) |
| same_address_similar_name | 住所完全一致 AND フリガナのレーベンシュタイン距離 ≤ 2 | 要調査 | 入力ゆれ候補。review queue (priority: medium) |

### Hard Dedupe

Phase 4 では **実施しない**。理由:
- 家族共有電話番号のケースが存在 (multi_match の原因)
- 法人の複数担当者が同一電話番号を使うケースがある
- 統合の判断には現場の業務知識が必要

---

## deal dedupe

### 方針

deal は customer と 1:1 の状態。customer が統合された場合に deal の統合が必要になるが、
現 batch ではこの状況は発生しない。

### 注意事項

- 同一 customer_id に複数 deal がないことは Phase 3 で確認済み
- 将来的に他 batch (蓄電池等) のデータが入った場合に 1:N が発生する可能性あり

---

## activity_call dedupe

### Source 内 dedupe

Source A / Source B それぞれの内部で同一レコードが重複する可能性は低い（各 source は FileMaker の単一エクスポート）。

### Source 間 dedupe (A ↔ B)

| 項目 | 値 |
|------|-----|
| 厳密一致 (date + staff + content80) | 4,280 件 (11.0%) |
| ルーズ一致 (date + staff のみ) | 3,285 件 (8.4%) |
| Source A のみ | 35,372 件 |
| Source B のみ | 34,689 件 |
| 判定 | **partial_overlap** |

### Phase 4 の対応

1. staging には **両方 (A + B) を投入** する
2. `source_kind` 列で出元を区別
3. cross_source_fingerprint (`call_date|call_staff|content_first_80`) を付与
4. 統合は merge policy に基づき Phase 5 で実施

### 将来の Hard Dedupe 手順 (Phase 5 予定)

```
Step 1: cross_source_fp が完全一致 → 同一レコードとして片方を inactive 化
Step 2: date + staff が一致 + content のレーベンシュタイン距離 ≤ 10 → 同一候補
Step 3: 残りは review queue → 人手判断
```

---

## Dedupe Flag Schema

staging テーブルに将来追加予定の列:

| Column | Type | Description |
|--------|------|------------|
| _dedupe_group_id | TEXT | 同一グループと判定されたレコードをグループ化 |
| _dedupe_status | TEXT | 'active' / 'inactive' / 'pending_review' |
| _dedupe_method | TEXT | 'exact_fp' / 'loose_fp' / 'manual' |
| _dedupe_decided_at | TIMESTAMPTZ | 判定日時 |
| _dedupe_decided_by | TEXT | 判定者 |

**Phase 4 では上記列は定義のみ。データ投入は Phase 5 以降。**
