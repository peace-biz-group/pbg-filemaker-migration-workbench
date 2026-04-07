# Key Policy — Solar 260312

> **注意**: このポリシーは草案 (v0) です。unique 制約は provisional であり、ヒアリング後に確定します。

生成日: 2026-04-06

---

## customer

### Primary Key

| 項目 | 内容 |
|------|------|
| Candidate PK | customer_id (お客様ID) |
| Type | TEXT |
| Source | 260312_顧客_太陽光.csv の「お客様ID」列 |
| Uniqueness | マスタ行 5,357 件中ユニーク (Phase 1 で検証済み) |
| Format | `RC[0-9][A-Z][0-9]{3}` パターン (例: RC0L001, RC5E067) |
| Confidence | **high** — FileMaker が自動採番した ID。重複なし |

### Natural Key 候補

| Candidate | 構成列 | Uniqueness | Confidence | Note |
|-----------|--------|------------|------------|------|
| phone | phone (電話番号) | 低 — multi_match が 6.1% | low | 同一電話番号を複数顧客が共有 (家族/法人) |
| furigana + address | furigana + address | 中 — 未検証 | medium | 同姓同名同住所は稀だが皆無ではない |
| phone + furigana | phone + furigana | 高 — 未検証 | medium | 同一電話番号でもフリガナが異なれば区別可能 |

### Duplicate Warning 条件

以下の条件に合致する行は重複候補として警告:

1. **同一電話番号 + 同一住所**: 同じ電話番号と住所を持つ別 customer_id → 統合候補
2. **同一フリガナ + 同一電話番号**: 同じフリガナと電話番号 → 重複入力の可能性
3. **同一住所 + 類似フリガナ**: 住所一致 + フリガナのレーベンシュタイン距離 ≤ 2 → 入力揺れ候補

---

## deal

### Primary Key

| 項目 | 内容 |
|------|------|
| Candidate PK | (自動採番) — 現時点で deal 固有 ID は元データに存在しない |
| Surrogate Key | staging 投入時に deal_id (SERIAL/UUID) を自動生成 |
| FK | customer_id → staging_customer.customer_id |

### Customer との Relation

| 仮説 | 根拠 | Confidence |
|------|------|------------|
| **1:1** | 現データでは customer_id ごとに deal 行が1行。マスタ行 5,357 = deal 行 5,357 | high (現データ上) |
| 1:N | FileMaker 上で同一顧客に複数案件がある可能性 (太陽光 + 蓄電池など)。ただし 260312 batch は太陽光のみ | low (現 batch では) |

**判定**: 現 batch では 1:1 として staging。ただし schema は 1:N に対応可能な形（deal_id 独立、customer_id FK）で設計済み。

### 1:1 仮説と 1:N 仮説の保持

```
staging_deal に deal_id (surrogate) を付与することで、
将来的に 1:N が判明した場合にも既存データの再投入なしで対応可能。
現時点では customer_id が実質的な unique key として機能する。
```

---

## activity_call

### Source A / B 共通 Fingerprint

| 項目 | 内容 |
|------|------|
| 構成 | `normalizeDate(call_date) + '|' + call_staff + '|' + content_first_80` |
| 用途 | Source A / B 間の同一レコード検出 |
| 一致率 | 11.0% (Phase 2 で検証済み) |
| Confidence | **medium** — 内容テキストの差異で一致率が下がっている可能性あり |

### Source-Specific Fingerprint

| Source | 構成 | 用途 |
|--------|------|------|
| Source A | `source_fingerprint` = `260312_コール履歴_太陽光.xlsx:row_N` | raw 原本追跡 |
| Source B | `source_fingerprint` = `260312_顧客_太陽光.csv:row_N` | raw 原本追跡 |

### Soft Dedupe Key

| Key | 構成 | 用途 | Note |
|-----|------|------|------|
| date_staff | `call_date + call_staff` | ルーズ一致 (日付+担当者) で候補抽出 | 一致率 8.4% (ルーズ) |
| date_staff_content80 | `call_date + call_staff + content_first_80` | 厳密一致で同一レコード判定 | 一致率 11.0% |
| phone_date | `normalized_phone + call_date` | 同一顧客の同日コール検出 | Source A のみ (B は phone なし) |

### Hard Dedupe

**Phase 4 では実施しない。** 以下の理由:

1. Source A/B が同一 FileMaker DB の異なるエクスポートパスである可能性が高いが、確証がない
2. 内容テキストの微差（全角/半角、改行、切り捨て長）で fingerprint が一致しないケースがある
3. 統合判断は merge policy に基づき、ヒアリング後に Phase 5 で実施

---

## Fingerprint Format Summary

| Entity | Fingerprint | Format | Example |
|--------|-------------|--------|---------|
| customer | source_fingerprint | `{filename}:row_{N}` | `260312_顧客_太陽光.csv:row_2` |
| deal | source_fingerprint | `{filename}:row_{N}` | `260312_顧客_太陽光.csv:row_2` |
| activity_call | source_fingerprint | `{filename}:row_{N}` | `260312_コール履歴_太陽光.xlsx:row_80` |
| activity_call | cross_source_fp | `{date}|{staff}|{content80}` | `2021-02-25|篠原里代|工事完了` |
