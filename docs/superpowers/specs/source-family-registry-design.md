# Source Family Registry — 設計書

> **目的:** raw filename ではなく `file_shape_fingerprint` 単位で「このファイルは何系か」を識別・記憶する仕組み。

---

## 背景

FileMaker から出力されるファイルは、エクスポート日時・連番によって filename が変わる。
しかし「顧客管理のエクスポートは毎回同じ列構成を持つ」という安定性がある。
Filename で識別しようとすると、再エクスポートのたびに人手で種別を教え直す必要が生じる。
`file_shape_fingerprint` で識別することで、「一度この形のファイルを見たことがある」を記憶できる。

---

## file_shape_fingerprint の定義

```
file_shape_fingerprint = SHA256(
  sorted(column_names).join(',')          // 列名の順序非依存ハッシュ
  + "|" + column_count                    // 列数
  + "|" + encoding                        // cp932 / utf-8 / ...
  + "|" + has_header (0 or 1)             // ヘッダーあり/なし
)
```

### 設計判断

- **filename は含めない** — 再エクスポートで filename が変わっても同じ fingerprint を持つ
- **列数を含める** — 同名列でも列数が違えば別 family とみなす
- **encoding を含める** — cp932 / utf-8 で意味が変わるケースがある
- **row count は含めない** — 行数が変わっても同じ family のファイルが多いため

---

## Family 分類の定義

### 基本 Family

| family_id | 表示名 | 主な特徴列 | 典型 filename パターン |
|-----------|--------|-----------|----------------------|
| `customer_master` | 顧客管理系 | 氏名・電話番号・住所・会社名 | `*顧客*`, `*customer*`, `*客先*` |
| `call_history` | コール履歴系 | 通話日時・担当者・コール結果 | `*コール*`, `*call*`, `*通話*` |
| `visit_history` | 訪問履歴系 | 訪問日・訪問者・訪問結果 | `*訪問*`, `*visit*` |
| `appo_source` | アポ元系 | アポ取得元・媒体・日付 | `*アポ*`, `*appo*` |
| `contract` | 契約系 | 契約番号・契約日・金額 | `*契約*`, `*contract*` |
| `unknown` | 未分類 | — | — |

### Family 自動判定ロジック

```
1. column_names と keyword-matcher で一致スコアを算出
   → customer_master score = Σ(match weights for 氏名/電話/住所/会社名)
   → call_history score    = Σ(match weights for 通話日時/担当者/コール結果)
   → ...

2. 最高スコアの family を候補とする
   → score >= threshold (0.6) なら certainty = "high"
   → 0.3 <= score < 0.6   なら certainty = "low" (人に確認)
   → score < 0.3           なら family = "unknown"

3. 人が確認した場合は certainty を "confirmed" に昇格し、registry に保存
```

---

## Registry JSON 形式

**パス:** `{outputDir}/.decisions/source-family-registry.json`

```json
{
  "version": "1",
  "families": {
    "customer_master": {
      "display_name": "顧客管理系",
      "keyword_weights": {
        "氏名": 0.3, "名前": 0.3, "フリガナ": 0.2,
        "電話番号": 0.3, "携帯": 0.2,
        "住所": 0.2, "郵便番号": 0.2,
        "会社名": 0.2, "法人名": 0.2
      },
      "threshold": 0.6,
      "default_template_id": "customer_master_v1"
    },
    "call_history": {
      "display_name": "コール履歴系",
      "keyword_weights": {
        "通話日": 0.4, "コール日": 0.4, "通話日時": 0.4,
        "担当者": 0.3, "営業担当": 0.3,
        "コール結果": 0.4, "架電結果": 0.4,
        "折り返し": 0.2
      },
      "threshold": 0.6,
      "default_template_id": "call_history_v1"
    }
  },
  "known_fingerprints": {
    "abc123...": {
      "fingerprint": "abc123...",
      "family_id": "customer_master",
      "certainty": "confirmed",
      "confirmed_at": "2026-04-07T00:00:00Z",
      "confirmed_by": "human",
      "column_count": 31,
      "encoding": "cp932",
      "has_header": true,
      "sample_filename": "260312_顧客マスター.csv",
      "matched_template_id": "customer_master_v1",
      "notes": "260312 Solar バッチ 顧客マスター確定"
    },
    "def456...": {
      "fingerprint": "def456...",
      "family_id": "call_history",
      "certainty": "high",
      "confirmed_at": null,
      "column_count": 18,
      "encoding": "cp932",
      "has_header": true,
      "sample_filename": "260312_コール履歴.csv"
    }
  }
}
```

### certainty 値の意味

| certainty | 意味 | 自動適用 |
|-----------|------|---------|
| `confirmed` | 人が明示的に確定した | ○ |
| `high` | キーワードスコアが threshold 以上 | ○（警告なし） |
| `low` | スコアが threshold 未満だが候補あり | △（人に確認、参考表示） |
| `unknown` | 分類不能 | ✗（人が指定するまでブロック） |

---

## 実行時の動作フロー

```
ファイル受信
    ↓
file_shape_fingerprint を計算
    ↓
known_fingerprints を参照
    ├── 既知 (certainty = confirmed/high)
    │       └─→ family + template を自動適用 → pipeline へ
    ├── 既知 (certainty = low)
    │       └─→ 候補 family を UI に表示 → 人が確認 → 確定後 pipeline へ
    └── 未知
            └─→ keyword-matcher でスコア計算
                ├── high → certainty = "high" で registry に追加 → pipeline へ
                ├── low  → 人に確認 → confirmed で追加 → pipeline へ
                └── 0    → family = "unknown" → ブロック（手動指定待ち）
```

---

## 既存コードとの統合

| 既存コード | 変更内容 |
|-----------|---------|
| `src/core/source-routing.ts` | `determineRoute()` 内で FamilyRegistry を参照し、routingDecision に `familyId` を追加 |
| `src/core/column-mapper.ts` | column suggestion の前に family テンプレートを優先参照 |
| `src/config/schema.ts` | `WorkbenchConfig.families?` フィールド追加（オプション）|
| `src/ui/server.ts` | アップロード後に family 確認 UI を表示（certainty = low / unknown のとき） |

---

## 新規モジュール案

**`src/core/family-registry.ts`**

```typescript
interface FamilyRegistryEntry {
  fingerprint: string
  family_id: FamilyId
  certainty: 'confirmed' | 'high' | 'low' | 'unknown'
  confirmed_at: string | null
  column_count: number
  encoding: string
  has_header: boolean
  sample_filename: string
  matched_template_id: string | null
  notes?: string
}

interface FamilyRegistry {
  version: string
  families: Record<FamilyId, FamilyDefinition>
  known_fingerprints: Record<string, FamilyRegistryEntry>
}

function computeFileShapeFingerprint(columns: string[], encoding: string, hasHeader: boolean): string
function detectFamily(columns: string[], registry: FamilyRegistry): { familyId: FamilyId; certainty: string; score: number }
function lookupFingerprint(fp: string, registry: FamilyRegistry): FamilyRegistryEntry | null
function registerFingerprint(entry: FamilyRegistryEntry, registry: FamilyRegistry): FamilyRegistry
function saveRegistry(registry: FamilyRegistry, outputDir: string): Promise<void>
function loadRegistry(outputDir: string): Promise<FamilyRegistry>
```

---

## 移行パス（260312 バッチ用）

Phase 6 で確定した 260312 バッチの情報を初期 registry に登録する手順:

```typescript
// scripts/seed-family-registry-260312.ts
// 顧客マスター (260312) の fingerprint を confirmed で登録
// コール履歴 source-A / source-B の fingerprint を confirmed で登録
```

これにより、次回 260312 の再投入や同型バッチ投入時に family 判定が自動で行われる。
