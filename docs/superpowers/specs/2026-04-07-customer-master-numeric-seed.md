# Spec: customer_master 260312 numeric 系 seed 追加

**Date:** 2026-04-07  
**Template:** `tmpl_customer_master_260312_v1`  
**Theme:** numeric 系列（設置kw / 枚数 / 築年数）を narrow に seed 追加

---

## 目的

設備規模・回数・築年などの定量情報を auto-apply 側へ引き上げる。
integer / decimal として確定できる列のみを対象とし、fail-closed を維持する。

---

## 追加対象列（3列）

| source_col | canonical_field | inferred_type | normalization_rule | confidence | 非空件数 | 純数値率 |
|---|---|---|---|---|---|---|
| `設置kw` | `installation_kw` | `decimal` | `trim` | `high` | 1483/52623 (2.8%) | 100% |
| `枚数` | `panel_count` | `integer` | `trim` | `high` | 5353/52623 (10.2%) | 100% |
| `築年数` | `building_age_years` | `integer` | `trim` | `high` | 4684/52623 (8.9%) | 100% |

### decimal / integer 判断根拠

- **設置kw**: 値例 `7.24`, `5.3`, `6.625`, `6.095` → 小数点あり → `decimal`
- **枚数**: 値例 `20`, `25`, `22`, `40`, `50` → 整数のみ → `integer`
- **築年数**: 値例 `15`, `42`, `38`, `100` → 整数のみ → `integer`

### normalization 前提

- 全3列とも全角数字ゼロ・単位付き値ゼロ（検証済み）
- 既存コードに `normalize_decimal` / `normalize_integer` は存在しない
- `trim` のみで十分。将来 numeric normalizer が追加されても後方互換で拡張できる

---

## 除外列と理由

| source_col | 除外理由 |
|---|---|
| `回数` | 28行のみ (0.05%)。値 60/96/120/180/216/240 → リース支払い回数の可能性大。列名単独では意味不明確。fail-closed。 |
| `部材数` | 255行 (0.5%) と非常にまばら。部材原価・部材単価（amount 列）と同グループ。次フェーズへ延期。 |
| `ｻｰﾋﾞｽ品数` | 78行 (0.1%)。amount 系グループ隣接。sparse すぎる。 |
| amount 系 7列 | リース料金・計上粗利・月額・部材原価・部材単価・ｻｰﾋﾞｽ品原価・ｻｰﾋﾞｽ品単価 → 今回対象外 |
| classification 系 | 職業・業種・続柄 → 今回対象外 |

---

## 変更ファイル

### 1. `data/seeds/260312/templates.json`

`tmpl_customer_master_260312_v1` の `column_decisions` 末尾（`設置店名` の後）に 3 エントリ追加。

```json
{
  "source_col": "設置kw",
  "canonical_field": "installation_kw",
  "inferred_type": "decimal",
  "normalization_rule": "trim",
  "confidence": "high",
  "decided_at": "2026-04-07T00:00:00Z",
  "decided_by": "auto",
  "notes": "solar 260312 seed 由来。太陽光パネル設置容量 (kW)。値例: 7.24, 5.3, 6.625。1483/52623 非空。全件半角数値。"
},
{
  "source_col": "枚数",
  "canonical_field": "panel_count",
  "inferred_type": "integer",
  "normalization_rule": "trim",
  "confidence": "high",
  "decided_at": "2026-04-07T00:00:00Z",
  "decided_by": "auto",
  "notes": "solar 260312 seed 由来。太陽光パネル枚数。値例: 20, 25, 22。5353/52623 非空。全件半角整数。"
},
{
  "source_col": "築年数",
  "canonical_field": "building_age_years",
  "inferred_type": "integer",
  "normalization_rule": "trim",
  "confidence": "high",
  "decided_at": "2026-04-07T00:00:00Z",
  "decided_by": "auto",
  "notes": "solar 260312 seed 由来。建物築年数。値例: 15, 42, 38, 100。4684/52623 非空。全件半角整数。"
}
```

`notes` フィールドも更新：78列 → 81列、numeric 系 3列（設置kw・枚数・築年数）追記。

### 2. `test/core/auto-apply-orchestrator.test.ts`

260312 seed integration `describe` 末尾に `it` を 1 つ追加:

```typescript
it('customer_master partial — resolves numeric seeded cols (installation_kw / panel_count / building_age_years)', () => {
  loadSeedDir(SEED_260312, tmpDir);
  const testCols = ['設置kw', '枚数', '築年数', '部材名'];
  const result = runAutoApplyPreview(testCols, 'utf-8', true, CUSTOMER_SCHEMA_FP, tmpDir);

  expect(result.autoApplyEligibility).toBe('partial');

  const kw = result.appliedDecisions.find((d) => d.sourceColumn === '設置kw');
  expect(kw).toBeDefined();
  expect(kw!.canonicalField).toBe('installation_kw');
  expect(kw!.source).toBe('template');

  const panelCount = result.appliedDecisions.find((d) => d.sourceColumn === '枚数');
  expect(panelCount).toBeDefined();
  expect(panelCount!.canonicalField).toBe('panel_count');

  const buildingAge = result.appliedDecisions.find((d) => d.sourceColumn === '築年数');
  expect(buildingAge).toBeDefined();
  expect(buildingAge!.canonicalField).toBe('building_age_years');

  // 未 seed 列は fail-closed で unresolved に残る
  expect(result.unresolvedColumns).toContain('部材名');
});
```

---

## 不変事項

- `auto_apply_eligibility: "partial"` 維持
- 既存テストすべて維持（`部材名` が unresolved の代表として使われているため、`部材名` はこの spec では seed しない）
- orchestrator の confidence フィルタ（`low` skip）はそのまま

---

## 受け入れ条件

1. `tmpl_customer_master_260312_v1` に numeric 系 seed 3 列が追加されている
2. seed-loader で読み込める（既存テスト通過で確認）
3. orchestrator で partial 解決が維持される（新規テスト通過で確認）
4. `設置kw` `枚数` `築年数` は auto-apply される
5. `部材名` は unresolved のまま残る（fail-closed）
6. typecheck 通過

---

## 未解決（次フェーズ候補）

| 列 | 次フェーズ理由 |
|---|---|
| `部材数` / `部材名` / `部材` / `部材原価【計上】` / `部材単価【計上】` | 部材グループとして一まとめに扱う。amount 混在のため要慎重判断。 |
| `回数` | 文脈を確定させるにはデータ調査追加が必要 |
| `ｻｰﾋﾞｽ品数` / `ｻｰﾋﾞｽ品原価` / `ｻｰﾋﾞｽ品単価` / `ｻｰﾋﾞｽ品納品` | ｻｰﾋﾞｽ品グループとして一まとめに。amount 混在。 |
| `【見積】` 4列 | 見積グループ。date / text / name 混在。要別フェーズ。 |
