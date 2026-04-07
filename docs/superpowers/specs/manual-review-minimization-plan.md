# Manual Review 最小化方針

> **目的:** 「毎回 review CSV を人が埋める運用」から「初回だけ判断し、次回以降は自動適用する運用」へ移行する。

---

## 現状の問題

Phase 5 では以下の review 作業が必要だった:

| 作業 | 件数 | 繰り返し |
|-----|------|---------|
| high-priority shared_phone review | 462 行 (29 電話番号) | 再投入のたびに発生 |
| medium-priority review | ~3,344 行 | 再投入のたびに発生 |
| status hearing (status-dictionary) | 16 値 | 新バッチに新ステータス値があれば発生 |
| customer/deal boundary | 15 行 | 同型ファイルでも発生 |
| 列マッピング確認 | 31 列（顧客）+ 18 列（コール）| 新 filename が来るたびに発生 |

### 問題の本質

これらの判断の **多くは繰り返し不要** だ。
「090-1234-5678 は会社の代表番号として全員保持する」という判断は、
次回再投入時には自動で適用されるべきであり、再入力は無駄なコストである。

---

## 最小化の方針

### 方針 1: 初回判断を自動昇格させる

人が review CSV に回答したとき、その回答を **Resolution Memory に自動保存** する。
次回以降、同じ context_key（電話番号・ステータス値・ファイル種別）が現れたときは自動適用する。

```
人の回答 → resolution-memory.json に保存 → 次回 run で自動適用
```

### 方針 2: review queue のフィルタリング

review bundle を生成する際に、resolution memory を参照してフィルタリングする。

```typescript
// review-bundle.ts の変更方針
function buildReviewQueue(exceptions: Exception[], memory: ResolutionMemory): ReviewItem[] {
  return exceptions.filter(ex => {
    const res = lookupResolution(ex.type, ex.contextKey, memory)
    return res === null || res.certainty === 'low'  // 未知 or low のみ残す
  })
}
```

### 方針 3: テンプレートによる列レビュー skip

同 schemaFP のファイルが来たとき、列レビューを完全に skip する。
`auto_apply_eligibility = "full"` のテンプレートがあれば、UI で列確認画面を出さない。

### 方針 4: status 辞書の固定化

Phase 6 で確定した `status-dictionary-v3.csv` を Resolution Memory に seed する。
以後は「聞いたことのない新しいステータス値」だけを review に送る。

---

## 最小化の目標値

| 作業 | Phase 5 件数 | 2 回目以降の目標 |
|-----|-------------|---------------|
| high-priority shared_phone | 462 行 | 0 行（全て resolution memory で解決） |
| medium-priority review | ~3,344 行 | ← 90% 削減（新規例外のみ） |
| status hearing | 16 値 | 0 値（辞書 v3 から自動適用） |
| customer/deal boundary | 15 行 | 0 行（家族判断済み） |
| 列マッピング確認 | 49 列 | 0 列（テンプレート適用済み） |

---

## 実装上の優先順位

### P0（必須 - review 件数に最も直接的な影響）

1. **Resolution Memory の実装** (`src/core/resolution-memory.ts`)
2. **review-bundle.ts のフィルタリング追加** (resolution memory 照合)
3. **phase5 high-priority review の seed スクリプト**
4. **status-dictionary-v3 の seed スクリプト**

### P1（重要 - 列レビュー skip）

5. **Mapping Template Registry の実装** (`src/core/mapping-template-registry.ts`)
6. **effective-mapping.ts との接続** (テンプレートから pre-fill)
7. **260312 バッチの初期テンプレート seed**

### P2（効果的 - family 自動分類）

8. **Source Family Registry の実装** (`src/core/family-registry.ts`)
9. **source-routing.ts との接続** (family 判定を routing に含める)
10. **UI での family 確認フロー** (certainty = low / unknown のとき)

---

## 「初回だけ review が必要」なケース

以下の場合は、どんなに設計を進めても review が必要になる（それで正しい）:

| ケース | 理由 |
|--------|------|
| 新しいステータス値が追加された | 値の意味を人が確定する必要がある |
| 列が追加・変更された（schema drift） | 新列の canonical_field を人が決める必要がある |
| 全く新しい形のファイルが来た | family と列マッピングを初回確定する必要がある |
| 既存の判断を覆す必要がある | 上書き理由を人が入力する必要がある |

これらは **設計の失敗ではなく、意図された review** である。

---

## review 件数のモニタリング

各 run の後に review 件数を記録し、減少傾向を確認する:

```json
// run_meta に追加するフィールド
{
  "review_stats": {
    "total_exceptions": 1200,
    "auto_resolved": 1150,
    "sent_to_review": 50,
    "auto_resolve_rate": 0.958
  }
}
```

**目標:** 同型ファイルの 2 回目以降で `auto_resolve_rate >= 0.95`

---

## 現場向けの説明

> 初めてファイルを取り込むときは、いくつか確認が必要です。
> 確認した内容は次回以降自動で使われるので、同じことを何度も聞かれることはありません。
> 新しい種類のデータが来たときだけ、また確認をお願いします。

これが「persistent decision engine」が現場に提供する体験の核心である。
