# Staging Load Runbook v1 — Solar 260312 Phase 6

生成日: 2026-04-07

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

```bash
# 接続確認（psql のみ。Supabase UI からは実行しない）
psql $DATABASE_URL -c "SELECT current_database(), now();"

# CSV ファイル行数確認
wc -l artifacts/filemaker-audit/solar/260312/phase3/customer-staging-v0.csv
wc -l artifacts/filemaker-audit/solar/260312/phase3/deal-staging-v0.csv
wc -l artifacts/filemaker-audit/solar/260312/phase3/activity-call-union-candidate.csv
```

---

## Step 1: DDL 適用

```bash
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-ddl-v1.sql
```

確認事項:
- [ ] 5テーブルが CREATE されたこと
- [ ] エラーがないこと

---

## Step 2: Precheck

```bash
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-precheck-v1.sql
```

確認事項:
- [ ] 5テーブルが存在すること
- [ ] 全テーブルの行数が 0 であること（初回実行時）
- [ ] 制約が存在すること

---

## Step 3: Load 実行

```bash
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-insert-draft-v1.sql
```

確認事項:
- [ ] COMMIT まで到達したこと
- [ ] エラーが出ていないこと

---

## Step 4: Postcheck

```bash
psql $DATABASE_URL -f artifacts/filemaker-audit/solar/260312/phase6/staging-postcheck-v1.sql
```

確認事項:
- [ ] row_count が期待値と一致すること（customer: 5357, deal: 5357, activity_call: 97722）
- [ ] NOT NULL チェックが全て 0 であること
- [ ] Uniqueness チェックが全て 0 であること
- [ ] review_status 分布が期待値の範囲内であること

---

## Manual Resolution 反映件数サマリ

| 項目 | 件数 |
|------|------|
| resolved 件数 | 0 |
| assign_all 件数（INSERT に反映） | 0 |

> **反映対象なし**: manual-resolution-template.csv に記入がありません。

---

## 注意事項

- **DB 実行禁止**: go-no-go.md が GO になるまで psql を実行してはいけない
- **raw ファイル編集禁止**: CSV ファイルを直接編集してはいけない
- **idempotent**: 再実行時は Step 3 の TRUNCATE から再開できる（rollback-draft-v1.sql の Option A を参照）
- **ロールバック**: 問題が発生した場合は rollback-draft-v1.sql を参照する

---

## 再生成コマンド

```bash
npm run audit:solar:phase6
```
