# Mapping Template Registry — 設計書

> **目的:** 一度決めた列対応・型対応・分解ルールを保存し、次回同型ファイルに自動適用する。

---

## 背景

既存の `template-store.ts` は `FileTemplate`（schemaFP 基準）を持ち、列マッピングを保存できる。
ただし以下の課題がある:

1. **列名ベースのみ** — 型推論の判断・分解ルールが保存されない
2. **confidence 管理がない** — 自動適用してよいか判断する仕組みがない
3. **Family との連携がない** — どの family のテンプレートか分からない
4. **version 管理がない** — schema が変わったときの旧テンプレートとの紐付けができない

これらを解決する `MappingTemplateRegistry` を設計する。

---

## テンプレートの構造

### ColumnDecision（列ごとの確定判断）

```typescript
interface ColumnDecision {
  source_col: string               // FileMaker 側の列名
  canonical_field: string | null   // 変換先の canonical フィールド名 (null = 不使用)
  inferred_type: string            // "phone" | "email" | "name" | "date" | "text" | "flag" | "id"
  normalization_rule: string | null // "normalize_phone" | "normalize_date" | "trim" | null
  decompose_to?: string[]          // 分解先列名 (例: ["住所_都道府県", "住所_市区町村"])
  confidence: 'confirmed' | 'high' | 'low'
  decided_at: string               // ISO8601
  decided_by: 'human' | 'auto'
  source_example?: string          // 元データの値サンプル (1件)
  notes?: string
}
```

### MappingTemplate（テンプレート本体）

```typescript
interface MappingTemplate {
  template_id: string              // "customer_master_v1" etc.
  family_id: string                // source family
  schema_fingerprint: string       // schemaFP (列名ハッシュ)
  version: number                  // テンプレートのバージョン
  parent_template_id?: string      // 前バージョンの template_id
  created_at: string
  confirmed_at: string | null
  column_decisions: ColumnDecision[]
  auto_apply_eligibility: 'full' | 'partial' | 'review_required'
  // full     = 全列 confirmed/high → 列レビューなしで進む
  // partial  = 一部 low → confirmed/high 列を先行適用、low 列のみ確認
  // review_required = 未確定列あり → 列レビューが必要
  known_schema_fingerprints: string[]  // この template を過去に適用した schemaFP 一覧
}
```

---

## Registry JSON 形式

**パス:** `{outputDir}/.decisions/mapping-template-registry.json`

```json
{
  "version": "1",
  "templates": {
    "customer_master_v1": {
      "template_id": "customer_master_v1",
      "family_id": "customer_master",
      "schema_fingerprint": "abc123...",
      "version": 1,
      "created_at": "2026-04-07T00:00:00Z",
      "confirmed_at": "2026-04-07T00:00:00Z",
      "auto_apply_eligibility": "full",
      "known_schema_fingerprints": ["abc123...", "abc124..."],
      "column_decisions": [
        {
          "source_col": "顧客名",
          "canonical_field": "name",
          "inferred_type": "name",
          "normalization_rule": "trim",
          "confidence": "confirmed",
          "decided_at": "2026-04-07T00:00:00Z",
          "decided_by": "human",
          "source_example": "山田 太郎"
        },
        {
          "source_col": "電話番号",
          "canonical_field": "phone",
          "inferred_type": "phone",
          "normalization_rule": "normalize_phone",
          "confidence": "confirmed",
          "decided_at": "2026-04-07T00:00:00Z",
          "decided_by": "human",
          "source_example": "０９０－１２３４－５６７８"
        },
        {
          "source_col": "備考",
          "canonical_field": null,
          "inferred_type": "text",
          "normalization_rule": null,
          "confidence": "confirmed",
          "decided_at": "2026-04-07T00:00:00Z",
          "decided_by": "human",
          "notes": "備考は staging に持ち込まない"
        }
      ]
    }
  },
  "fingerprint_to_template": {
    "abc123...": "customer_master_v1",
    "def456...": "call_history_v1"
  }
}
```

---

## auto_apply_eligibility の判定ロジック

```
全 column_decisions の confidence を集計:
  confirmed_count = decisions.filter(d => d.confidence === 'confirmed').length
  high_count      = decisions.filter(d => d.confidence === 'high').length
  low_count       = decisions.filter(d => d.confidence === 'low').length
  total           = confirmed_count + high_count + low_count

if (low_count === 0)
  → auto_apply_eligibility = "full"

else if (low_count / total <= 0.2)
  → auto_apply_eligibility = "partial"
  (confirmed/high を自動適用、low 列のみ確認画面に出す)

else
  → auto_apply_eligibility = "review_required"
```

---

## Schema Drift 対応

同じ family でも列が追加・削除されることがある。

```
新 schemaFP が届いた
    ↓
fingerprint_to_template を検索
    ├── ヒット → 既存テンプレートを適用 (known_schema_fingerprints に追記)
    └── ミス  → 最も近い同 family のテンプレートを探す
                ├── 列の重なりが 80% 以上 → "partial" 適用
                │   (新規列だけ review に送る)
                └── 重なりが 80% 未満 → 新テンプレートとして作成 (parent_template_id で紐付け)
```

---

## 既存コードとの統合

### `template-store.ts` からの移行

既存の `FileTemplate` は `MappingTemplate` の subset に相当する。
移行は段階的に行う:

| 段階 | 内容 |
|------|------|
| Step 1 | `MappingTemplateRegistry` を新規作成し、新規テンプレートはこちらに保存 |
| Step 2 | `template-store.ts` の `loadTemplate()` が registry を参照するよう変更 |
| Step 3 | 既存 `FileTemplate` を `MappingTemplate` に変換してインポート |

### `effective-mapping.ts` との連携

```
run 開始時:
  1. schemaFP から テンプレートを取得
  2. auto_apply_eligibility = "full" なら effective_mapping をテンプレートから生成
  3. "partial" なら confirmed/high 列のみ pre-fill し、low 列を review 対象として残す
  4. run 後に人が review した結果を ColumnDecision として保存
```

---

## テンプレートの昇格フロー

```
初回 run (新規 schemaFP)
    列レビューで全列の canonical_field を決定
        ↓
    ColumnDecision (decided_by = "human", confidence = "confirmed") として保存
        ↓
    MappingTemplate 新規作成 (auto_apply_eligibility = "full")
        ↓
次回 run (同 schemaFP)
    テンプレートを参照 → 自動適用 → 列レビュー不要
```

---

## 260312 バッチ用初期テンプレート

Phase 3 の `staging-column-map.csv` が存在し、顧客マスター・コール履歴の列マッピングが確定している。
これを初期テンプレートとして seed する:

```
scripts/seed-mapping-templates-260312.ts
  → 顧客マスター 31 列 → customer_master_v1
  → コール履歴 source-A 18 列 → call_history_source_a_v1
  → コール履歴 source-B 18 列 → call_history_source_b_v1
```

これにより 260312 再投入時はテンプレートが即座に適用される。
