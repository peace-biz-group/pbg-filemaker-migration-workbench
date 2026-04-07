# Staging Load Order v1 — Solar 260312 Phase 6

生成日: 2026-04-07

---

## 実行シーケンス

```
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
```

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

```bash
# 1. Option A ロールバック（全件クリア）
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/rollback-draft-v1.sql

# 2. insert-draft を再実行
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-insert-draft-v1.sql

# 3. postcheck で確認
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-postcheck-v1.sql
```

---

## 依存関係

| ステップ | 依存先 |
|---------|--------|
| staging_deal load | staging_customer（customer_id 参照） |
| staging_activity_call load | 独立（customer FK はコメントアウト中） |
| soft_dedupe 適用 | staging_activity_call load 完了後 |
| manual resolution 反映 | staging_activity_call load + soft_dedupe 完了後 |
| status_normalized 付与 | staging_deal load + status-dictionary-v3.csv 確定後 |
