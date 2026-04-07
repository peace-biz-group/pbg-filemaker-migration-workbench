# Activity Call Merge Policy v1 — Solar 260312 Phase 6

生成日: 2026-04-07

---

## 採用方針

**Pattern 2: soft_dedupe_by_cross_source_fp を採用する。**

Phase 5 のシミュレーションで3パターンを比較し、Phase 6 時点でこの方針を確定する。

---

## 前提数値

| 指標 | 値 |
|------|-----|
| Source A（コール履歴 XLSX） | 46,572 行 |
| Source B（ポータル展開） | 51,150 行 |
| Union（A + B） | 97,722 行（全件 staging 投入） |
| 厳密重複（date+staff+content80 一致） | ~4,280 件 |
| ルーズ一致（date+staff 一致） | ~3,285 件 |

---

## 方針詳細

### staging 行数

- 全 97,722 行を staging_activity_call に投入する
- 物理削除は行わない

### 厳密重複の処理

- 重複キー: `concat_ws('|', to_char(call_date,'YYYY-MM-DD'), call_staff, left(content,80))`（cross_source_fp）
- Source B 側の厳密重複（~4,280 件）に対して:
  - `is_duplicate = TRUE`
  - `review_status = 'duplicate'`
- Source A 側は変更しない

### ルーズ一致の処理

- ルーズ一致（~3,285 件）は `review_status = 'needs_review'` を付与する
- 物理削除禁止・確定的な紐付け変更禁止
- downstream で `review_status = 'active'` のみを使えば重複を回避できる

### 物理削除禁止の理由

1. raw 原本の保全方針に従い、全行を staging に保持する
2. is_duplicate / review_status フラグで管理することで可逆性を確保する
3. 後から「重複ではなかった」と判明した場合に復元できる

### 未解決事項

| 事項 | 状態 |
|------|------|
| Source A/B が同一 FileMaker DB の別エクスポートであることの確認 | 未確認 |
| ルーズ一致 3,285 件の個別判断 | Phase 7 以降 |
| customer:deal = 1:1 vs 1:N の確認 | 未確認（FK コメントアウトのまま） |

---

## downstream での使い方

```sql
-- 有効行のみ抽出
SELECT * FROM staging_activity_call
WHERE review_status = 'active';

-- 要確認行の確認
SELECT * FROM staging_activity_call
WHERE review_status = 'needs_review';
```

---

## 変更履歴

| バージョン | 日付 | 変更内容 |
|----------|------|---------|
| v1 | 2026-04-07 | Phase 6 で Pattern 2 を正式採用 |
