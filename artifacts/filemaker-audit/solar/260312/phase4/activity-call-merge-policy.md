# Activity Call Merge Policy — Solar 260312

> **注意**: この方針は草案です。ヒアリング後に確定します。

生成日: 2026-04-06

---

## 背景

activity_call は 2 つのソースから構成される:

| Source | File | Rows | 特徴 |
|--------|------|------|------|
| **A** | 260312_コール履歴_太陽光.xlsx | 46,572 | 独立テーブル。電話番号【検索】あり。担当者25名。日時が秒単位 |
| **B** | 260312_顧客_太陽光.csv (ポータル展開) | 51,150 | 顧客レコードに紐づく。customer_id (fill-forward) あり。電話番号なし |

### Overlap 分析 (Phase 2)

| 指標 | 値 |
|------|-----|
| 厳密一致 (date + staff + content80) | 4,280 件 (11.0%) |
| ルーズ一致 (date + staff) | 3,285 件 (8.4%) |
| A のみ | 35,372 件 |
| B のみ | 34,689 件 |

**結論**: 同一 FileMaker DB の異なるエクスポートパスだが、各 source に固有のレコードが存在。単純な A ⊇ B でも B ⊇ A でもない。

---

## 3 案比較

### 案 1: A 正 / B 補完

Source A を primary、Source B を補完情報として使う。

| 項目 | 内容 |
|------|------|
| **長所** | A は電話番号があり customer 紐付けに使える。独立テーブルで構造がクリーン |
| **欠点** | B にしかない 34,689 件を捨てるか、secondary として扱う必要がある |
| **件数影響** | primary: 46,572 + secondary: ~34,689 = 約 81,261 件 |
| **review 増減** | multi_match/no_match の review は A 基準で 3,806 件のまま |
| **Ops Core 接続** | A の電話番号紐付けが Ops Core の customer 参照に使える |

### 案 2: B 正 / A 補完

Source B を primary、Source A を補完情報として使う。

| 項目 | 内容 |
|------|------|
| **長所** | B は customer_id (fill-forward) で直接紐付け済み。紐付け精度が高い |
| **欠点** | A にしかない 35,372 件を secondary 扱い。B の fill-forward customer_id は推定値 |
| **件数影響** | primary: 51,150 + secondary: ~35,372 = 約 86,522 件 |
| **review 増減** | B 側の review は少ない (fill-forward で紐付け済み) が、A の secondary 分で増加 |
| **Ops Core 接続** | B の fill-forward customer_id は Ops Core に直接使えるが、精度保証なし |

### 案 3: 並存保持 + Downstream Review (推奨)

両方を staging に投入し、downstream で統合判断。

| 項目 | 内容 |
|------|------|
| **長所** | データ欠損なし。source_kind で出元を区別。11% の重複は cross_source_fp で検出可能 |
| **欠点** | staging 行数が最大 (97,722)。downstream の統合ロジックが必要 |
| **件数影響** | staging: 97,722 件 (うち推定重複 4,280 件) |
| **review 増減** | 重複判定の review が追加で必要 (~4,280 件) |
| **Ops Core 接続** | source_kind ごとに異なる紐付け方法を Ops Core 側で選択可能 |

---

## 比較マトリクス

| 評価軸 | 案1 (A正) | 案2 (B正) | 案3 (並存) |
|--------|----------|----------|----------|
| データ完全性 | △ B固有を失うリスク | △ A固有を失うリスク | ◎ 全件保持 |
| 紐付け精度 | ○ 電話番号ベース | ○ fill-forward ID | ○ 両方利用可能 |
| review 負荷 | ○ 既存 3,806 件 | ○ 少ない | △ +4,280 件 |
| staging 複雑度 | ○ シンプル | ○ シンプル | △ 両 source 管理 |
| 可逆性 | △ 判断を先行 | △ 判断を先行 | ◎ 判断を後回し |
| Ops Core 接続 | ○ | ○ | ◎ 柔軟 |
| 安全性 | ○ | ○ | ◎ fail-safe |

---

## 推奨案: 案 3 (並存保持 + Downstream Review)

### 推奨理由

1. **安全側に倒す原則** — CLAUDE.md の最優先事項「unsafe な自動確定をしない」に合致
2. **データ欠損リスクゼロ** — A にしかない 35,372 件、B にしかない 34,689 件の両方を保持
3. **判断を後回しにできる** — merge 判断は Phase 5 でヒアリング結果を踏まえて行う
4. **可逆性** — staging に全件あれば、どの merge strategy にも後から切り替え可能
5. **Phase 3 の方針と整合** — Phase 3 で activity-call-union-candidate.csv (97,722 行) を生成済み

### 実装方針

```
1. staging_activity_call に A + B を全件投入 (97,722 行)
2. source_kind 列で 'source_a' / 'source_b' を区別
3. cross_source_fp (date|staff|content80) を計算列として追加
4. Phase 5 で merge 判断:
   - cross_source_fp 一致 → 重複として片方を inactive 化
   - A の電話番号紐付け + B の fill-forward ID を相互補完
   - 不一致分は review queue へ
```

### リスクと対策

| リスク | 対策 |
|--------|------|
| staging 行数が多い (97K) | staging テーブルにインデックスを適切に設定 |
| downstream で merge 忘れ | Phase 5 のタスクとして明示的に追跡 |
| 重複行が Ops Core に流入 | staging → production の間に merge gate を設ける |
