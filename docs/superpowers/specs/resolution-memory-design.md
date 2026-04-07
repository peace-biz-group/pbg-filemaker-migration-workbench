# Resolution Memory — 設計書

> **目的:** 電話番号例外・shared phone・ステータス意味・customer/deal 境界などの判断を保存し、次回 rerun 時に自動反映する。

---

## 背景と対象とする判断の種類

Phase 5 では `manual-resolution-template.csv`（12 列・462 行）で人手判断を収集した。
この判断は一度しか使われず、次回の同型ファイル投入時には再入力が必要だった。

Resolution Memory は、これらの判断を「ルール」として昇格させ、再入力を不要にする。

### 対象とする判断種別

| resolution_type | 説明 | Phase での出処 |
|----------------|------|--------------|
| `shared_phone` | 複数顧客が同じ電話番号を持つケースの扱い | Phase 5 high-priority-review |
| `phone_exception` | 正規化後も不正形式に見える電話番号の扱い | Phase 5 中 |
| `status_meaning` | ステータス値 ("済", "NG" 等) の意味と正規化後の値 | Phase 6 status-dictionary-v3 |
| `customer_deal_boundary` | 同一行に customer 情報と deal 情報が混在するときの分割方針 | Phase 3 customer-deal-boundary-review |
| `parent_child_classification` | 親子混在 CSV の親行・子行の識別方針 | Phase 3 |
| `column_ignore` | 特定列を使わないという判断 | 列レビュー結果 |
| `encoding_exception` | 特定ファイルの文字化け対処方針 | ingest 時 |
| `merge_policy` | source-A / source-B などの重複統合方針 | Phase 6 activity-call-merge-policy-v1 |

---

## Resolution Memory の JSON 形式

**パス:** `{outputDir}/.decisions/resolution-memory.json`

```json
{
  "version": "1",
  "resolutions": [
    {
      "resolution_id": "res_001",
      "resolution_type": "shared_phone",
      "context_key": "phone:090-1234-5678",
      "family_id": "customer_master",
      "decision": "keep_all",
      "decision_detail": {
        "action": "keep_all",
        "reason": "会社の代表番号として複数担当者が登録されている",
        "canonical_phone": "09012345678",
        "affected_customer_ids": ["C-001", "C-002", "C-003"]
      },
      "certainty": "confirmed",
      "scope": "phone_value",
      "decided_at": "2026-04-07T00:00:00Z",
      "decided_by": "human",
      "auto_apply_condition": "exact_match:phone_normalized",
      "source_batch_ids": ["sb_abc123"],
      "notes": "260312 バッチ 高優先度 bucket 1"
    },
    {
      "resolution_id": "res_002",
      "resolution_type": "status_meaning",
      "context_key": "status:済",
      "family_id": "call_history",
      "decision": "completed",
      "decision_detail": {
        "source_value": "済",
        "normalized_stage": "completed",
        "display_label": "完了",
        "notes": "架電完了・用件達成"
      },
      "certainty": "confirmed",
      "scope": "global",
      "decided_at": "2026-04-07T00:00:00Z",
      "decided_by": "human",
      "auto_apply_condition": "exact_match:status_value"
    },
    {
      "resolution_id": "res_003",
      "resolution_type": "merge_policy",
      "context_key": "family:call_history:source_a_vs_b",
      "family_id": "call_history",
      "decision": "soft_dedupe_by_cross_source_fp",
      "decision_detail": {
        "strategy": "soft_dedupe_by_cross_source_fp",
        "source_a_label": "activity-call-source-a",
        "source_b_label": "activity-call-source-b",
        "dedup_key": "cross_source_fingerprint",
        "on_conflict": "keep_source_a"
      },
      "certainty": "confirmed",
      "scope": "family",
      "decided_at": "2026-04-07T00:00:00Z",
      "decided_by": "human",
      "auto_apply_condition": "family_match:call_history"
    }
  ]
}
```

---

## フィールド仕様

### scope の値

| scope | 意味 | 自動適用範囲 |
|-------|------|------------|
| `phone_value` | 特定の電話番号値に対する判断 | 同一正規化電話番号が出たとき |
| `status_value` | 特定のステータス値に対する判断 | 同一ステータス文字列が出たとき |
| `family` | 特定 family 全体に対する判断 | 同 family のファイルが来たとき |
| `schema_fp` | 特定 schemaFP に対する判断 | 同一 schemaFP のファイルが来たとき |
| `global` | 全 family・全ファイルへの判断 | 常に適用 |

### auto_apply_condition の書式

```
"exact_match:{field}"         → 特定フィールドの完全一致で適用
"family_match:{family_id}"    → family ID が一致したら適用
"schema_match:{fingerprint}"  → schemaFP が一致したら適用
"always"                      → 条件なしで常に適用
"never"                       → 自動適用しない（人の確認が必要）
```

---

## 実行時の照合フロー

### shared_phone の例

```
normalize → duplicate detection → shared_phone 検出
    ↓
resolution-memory を検索
  context_key = "phone:{normalized_phone}"
  resolution_type = "shared_phone"
    ├── 見つかった (certainty = confirmed/high)
    │       → decision を自動適用 (review queue に入れない)
    │       → decision-audit-log に "auto_applied: res_001" を記録
    └── 見つからない
            → review queue に追加
            → 人が判断 → resolution memory に新規保存
```

### status_meaning の例

```
column に status 値が含まれる
    ↓
resolution-memory を検索
  context_key = "status:{raw_value}"
    ├── 見つかった
    │       → normalized_stage を自動適用
    └── 見つからない (新規ステータス値)
            → status-unknown-queue に追加
            → 人が判断 → resolution memory に追加
```

---

## Phase 5 / Phase 6 成果物からの初期ロード

### Phase 5 高優先度レビューパケットの変換

`artifacts/filemaker-audit/solar/260312/phase5/high-priority-review-packet.csv`
→ 人が回答した列を読み込み、`shared_phone` resolution として一括登録

```typescript
// scripts/seed-resolution-memory-phase5.ts
// high-priority-review-packet.csv の "判断" 列を読み、
// resolution_type = "shared_phone" で resolution-memory.json に書き込む
```

### Phase 6 ステータス辞書の変換

`artifacts/filemaker-audit/solar/260312/phase6/status-dictionary-v3.csv`
→ 各行を `status_meaning` resolution として登録

```typescript
// scripts/seed-resolution-memory-phase6-status.ts
// status-dictionary-v3.csv を読み、
// resolution_type = "status_meaning" で登録
```

### Phase 6 merge policy の変換

`artifacts/filemaker-audit/solar/260312/phase6/activity-call-merge-policy-v1.md`
→ Pattern 2 (soft_dedupe_by_cross_source_fp) を `merge_policy` resolution として登録

---

## Decision Audit Log

判断の変更履歴を `decision-audit-log.jsonl` に append-only で記録する。

```jsonl
{"ts":"2026-04-07T00:00:00Z","event":"resolution_created","resolution_id":"res_001","decided_by":"human"}
{"ts":"2026-04-08T00:00:00Z","event":"resolution_auto_applied","resolution_id":"res_001","run_id":"run_xyz","context":"phone:09012345678"}
{"ts":"2026-04-09T00:00:00Z","event":"resolution_overridden","resolution_id":"res_001","new_decision":"deduplicate","decided_by":"human"}
```

これにより「なぜこの判断になったか」が追跡できる。

---

## 新規モジュール案

**`src/core/resolution-memory.ts`**

```typescript
type ResolutionType =
  | 'shared_phone' | 'phone_exception' | 'status_meaning'
  | 'customer_deal_boundary' | 'parent_child_classification'
  | 'column_ignore' | 'encoding_exception' | 'merge_policy'

interface ResolutionRecord {
  resolution_id: string
  resolution_type: ResolutionType
  context_key: string
  family_id: string | null
  decision: string
  decision_detail: Record<string, unknown>
  certainty: 'confirmed' | 'high' | 'low'
  scope: 'phone_value' | 'status_value' | 'family' | 'schema_fp' | 'global'
  decided_at: string
  decided_by: 'human' | 'auto'
  auto_apply_condition: string
  source_batch_ids: string[]
  notes?: string
}

function lookupResolution(type: ResolutionType, contextKey: string, memory: ResolutionMemory): ResolutionRecord | null
function addResolution(record: ResolutionRecord, memory: ResolutionMemory): ResolutionMemory
function shouldAutoApply(record: ResolutionRecord): boolean
function saveMemory(memory: ResolutionMemory, outputDir: string): Promise<void>
function loadMemory(outputDir: string): Promise<ResolutionMemory>
```

---

## 運用上の注意点

- `resolution-memory.json` は人が手で編集しても構わない（JSON として valid であれば）
- `certainty = "low"` の resolution は自動適用せず、UI で「前回こう判断しましたが合っていますか？」と表示する
- 互いに矛盾する resolution が保存された場合は、決定日時が新しい方を優先する
- 削除は論理削除（`deleted_at` フィールドを追加）。物理削除は audit-log との整合性を壊す可能性がある
