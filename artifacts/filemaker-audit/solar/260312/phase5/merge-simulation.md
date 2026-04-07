# Merge Simulation — Solar 260312

> Phase 4 で推奨した「A/B 並存保持 + Downstream Review」を前提に、
> 3 パターンの merge 結果をシミュレーションする。

生成日: 2026-04-07

---

## 前提数値 (Phase 2/3 で確認済み)

| 指標 | 値 |
|------|-----|
| Source A (コール履歴 XLSX) | 46,572 行 |
| Source B (ポータル展開) | 51,150 行 |
| Union (A + B) | 97,722 行 |
| 厳密一致 (date+staff+content80) | 4,280 件 (11.0%) |
| ルーズ一致 (date+staff) | 3,285 件 (8.4%) |
| A 固有 FP | 35,372 件 |
| B 固有 FP | 34,689 件 |

---

## 3 パターン比較

### Pattern 1: keep_all — 全件保持

| 項目 | 内容 |
|------|------|
| 概要 | A/B 全件を staging に投入。重複もそのまま保持 |
| 合計行数 | 97,722 |
| Source A 保持 | 46,572 |
| Source B 保持 | 51,150 |
| 重複処理 | 0 件 — 重複は検出するが行削除しない |
| レビュー依存行 | 0 件 |
| 追跡可能性 | source_kind + source_fingerprint で完全追跡可能 |
| downstream 簡潔さ | 低 — downstream で重複除去ロジックが必要 |

### Pattern 2: soft_dedupe_by_cross_source_fp — FP 一致分を inactive 化

| 項目 | 内容 |
|------|------|
| 概要 | 厳密一致 (date+staff+content80) の重複を Source B 側で inactive 化 |
| 合計行数 | 93,442 |
| Source A 保持 | 46,572 |
| Source B 保持 | 46,870 |
| 重複処理 | 4,280 件 — 厳密一致 4280 件は B 側を _dedupe_status=inactive に。ルーズ一致 3285 件は要レビュー |
| レビュー依存行 | 3,285 件 |
| 追跡可能性 | inactive 行も staging に残るため完全追跡可能。_dedupe_status で区別 |
| downstream 簡潔さ | 中 — active 行のみ使えば良い。ルーズ一致分はレビュー待ち |

### Pattern 3: keep_A_primary_and_attach_B_reference — A を正に B を補完

| 項目 | 内容 |
|------|------|
| 概要 | Source A を primary。B のうち A に厳密一致しない行のみ追加 |
| 合計行数 | 81,261 |
| Source A 保持 | 46,572 |
| Source B 保持 | 34,689 |
| 重複処理 | 16,461 件 — B のうち A と厳密一致する 16461 件を除外。B 固有の 34689 件のみ追加 |
| レビュー依存行 | 0 件 |
| 追跡可能性 | 除外された B 行は staging 外。原本参照は raw ファイルのみ |
| downstream 簡潔さ | 高 — A が primary で統一。B は補完のみ。Ops Core 接続がシンプル |

---

## 比較マトリクス

| 評価軸 | keep_all | soft_dedupe | A_primary_B_ref |
|--------|----------|-------------|-----------------|
| 合計行数 | 97,722 | 93,442 | 81,261 |
| A 保持 | 46,572 | 46,572 | 46,572 |
| B 保持 | 51,150 | 46,870 | 34,689 |
| 重複処理 | 0 | 4,280 | 16,461 |
| レビュー依存 | 0 | 3,285 | 0 |
| 追跡可能性 | ◎ | ◎ | △ |
| downstream 簡潔さ | × | ○ | ◎ |
| データ完全性 | ◎ | ◎ | △ |
| 安全性 | ◎ | ○ | ○ |

---

## 推奨

**Phase 5 時点の推奨: Pattern 2 (soft_dedupe_by_cross_source_fp)**

Phase 4 では「並存保持」を推奨したが、staging に入れるタイミングでは Pattern 2 が最もバランスが良い。

**理由**:
1. 厳密一致 4,280 件は同一レコードと判断して安全 → B 側を inactive 化
2. inactive にするだけで行を削除しないため、可逆性を維持
3. ルーズ一致 3,285 件はレビュー待ちとして保持
4. downstream では `_dedupe_status = 'active'` のみを使えば良い
5. Phase 4 の「並存保持」方針とも矛盾しない (全行は staging に存在する)

**ヒアリング確認事項**:
- Source A/B が同一 FileMaker DB の別エクスポートであることの確認
- 厳密一致 = 同一レコードと判断してよいか

---

## 次のステップ

1. ヒアリングで Source A/B の出元を確認
2. 確認が取れたら Pattern 2 を適用
3. ルーズ一致 3,285 件を review queue に追加
4. staging INSERT 時に `_dedupe_status` 列を付与
