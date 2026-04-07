# DB Go-Live Readiness Checklist — Solar 260312

> Phase 6 で DDL 実行・staging INSERT に進む前に、
> このチェックリストの全項目が完了していることを確認してください。

生成日: 2026-04-07

---

## 1. Review 完了チェック

### High Priority Review

- [ ] high-priority-review-packet.csv の全 462 件（電話番号ベースでグループ化済み）にレビュー結果を記入した
- [ ] decision_status が `resolved` または `skip` / `defer` で埋まっている
- [ ] `unclear` が残っている場合、エスカレーション先を決めた
- [ ] manual-resolution-template.csv を記入済み

### Medium Priority Review

- [ ] no_match 608 件: staging では matched_customer_id=NULL で投入する方針を合意
- [ ] family_shared_phone 1851 件: fill-forward ID 採用の方針を合意
- [ ] unclear 210 件: Phase 6 以降に持ち越す方針を合意

### Low Priority Review

- [ ] invalid 338 件: データ品質問題として記録。staging では matched_customer_id=NULL で投入
- [ ] bulk_pattern_review 337 件: 営業担当携帯番号の特定を現場に依頼済み

---

## 2. Status Dictionary 確認

- [ ] low confidence ステータス 8 件のヒアリングが完了
- [ ] medium confidence ステータス 2 件のヒアリングが完了
- [ ] status-hearing-sheet.csv に回答が記入されている
- [ ] 審査結果の「連変」「取り直し」の意味が確認済み
- [ ] normalized_stage が確定版に更新されている

---

## 3. Merge Policy 確定

- [ ] Source A/B が同一 FileMaker DB の別エクスポートであることを確認
- [ ] merge simulation の推奨 (Pattern 2: soft_dedupe) を合意
- [ ] 厳密一致 4,280 件は同一レコードとして B 側 inactive 化する方針を合意
- [ ] ルーズ一致 3,285 件の扱いを決めた（review or inactive）

---

## 4. DDL 確定

- [ ] staging-ddl-draft-v1.sql をレビュー済み
- [ ] customer/deal の 1:1 vs 1:N を確認した結果を反映
- [ ] provisional な unique/index 制約を確定版に昇格
- [ ] _loaded_at, _batch_id, _schema_version 列の自動付与を確認
- [ ] staging_rejected_rows テーブルの構造を合意
- [ ] staging_load_log テーブルの構造を合意

---

## 5. Precheck / Postcheck 合意

- [ ] staging-precheck.sql の項目をレビュー済み
- [ ] staging-postcheck.sql の期待値を確定
  - [ ] customer: 5,357 行
  - [ ] deal: 5,357 行
  - [ ] activity_call: 行数は merge pattern により変動（合意値を記入: ＿＿＿＿ 行）
- [ ] NOT NULL violation のしきい値を合意（0 件であるべき）
- [ ] FK orphan のしきい値を合意（warning のみ or reject）

---

## 6. Rollback 計画

- [ ] staging テーブルの TRUNCATE で全件クリアできることを確認
- [ ] re-run 手順: `TRUNCATE → COPY` で idempotent に再投入できることを確認
- [ ] 破壊的変更のないことを確認（raw ファイルは read-only、production テーブルは非対象）
- [ ] manual resolution の反映は match_type = 'manual_resolved' で逆引き可能

---

## 7. 運用準備

- [ ] Supabase プロジェクトの接続情報を確保
- [ ] staging 用のスキーマ（schema）を決定（public / staging / solar_260312 等）
- [ ] COPY 実行権限の確認
- [ ] CSV ファイルの Supabase サーバーへの転送方法を決定
- [ ] Phase 6 スクリプトの作成方針を合意

---

## 判定

| 区分 | 必須 | 完了 |
|------|------|------|
| Review 完了 | high priority のみ必須。medium/low は方針合意で可 | [ ] |
| Status 確認 | low confidence のみ必須 | [ ] |
| Merge 確定 | 必須 | [ ] |
| DDL 確定 | 必須 | [ ] |
| Check 合意 | 必須 | [ ] |
| Rollback | 必須 | [ ] |
| 運用準備 | 必須 | [ ] |

**全項目が完了するまで Phase 6 (DDL 実行・staging INSERT) に進まないこと。**
