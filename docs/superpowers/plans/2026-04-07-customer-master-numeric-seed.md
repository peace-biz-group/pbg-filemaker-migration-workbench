# customer_master numeric seed 追加 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tmpl_customer_master_260312_v1` に numeric 系 3 列（設置kw / 枚数 / 築年数）を seed 追加し、auto-apply で解決されるようにする。

**Architecture:** `data/seeds/260312/templates.json` の `column_decisions` 末尾に 3 エントリを追加するのみ。orchestrator は既存ロジックのまま（`confidence === 'low'` のみ skip）。テストは `auto-apply-orchestrator.test.ts` の 260312 seed integration describe に `it` を 1 つ追加。

**Tech Stack:** JSON（直接編集）、Vitest（テストランナー）

---

## 変更ファイル

- Modify: `data/seeds/260312/templates.json`（`column_decisions` 3 エントリ追加 + `notes` 更新）
- Modify: `test/core/auto-apply-orchestrator.test.ts`（`it` 1 つ追加）

---

### Task 1: 失敗するテストを書く

**Files:**
- Modify: `test/core/auto-apply-orchestrator.test.ts`

- [ ] **Step 1: テストを追加する**

`test/core/auto-apply-orchestrator.test.ts` のファイル末尾、最後の `});`（describe ブロックの閉じ括弧）の直前に以下を追加する。

現在のファイル末尾（参考）:
```
  it('customer_master partial — resolves document flow date seeded cols', () => {
    ...
  });

});  ← この直前に追加
```

追加するコード:
```typescript
  it('customer_master partial — resolves numeric seeded cols (installation_kw / panel_count / building_age_years)', () => {
    loadSeedDir(SEED_260312, tmpDir);

    const testCols = ['設置kw', '枚数', '築年数', '部材名'];
    const result = runAutoApplyPreview(testCols, 'utf-8', true, CUSTOMER_SCHEMA_FP, tmpDir);

    expect(result.templateId).toBe('tmpl_customer_master_260312_v1');
    expect(result.autoApplyEligibility).toBe('partial');

    const kw = result.appliedDecisions.find((d) => d.sourceColumn === '設置kw');
    expect(kw).toBeDefined();
    expect(kw!.canonicalField).toBe('installation_kw');
    expect(kw!.source).toBe('template');

    const panelCount = result.appliedDecisions.find((d) => d.sourceColumn === '枚数');
    expect(panelCount).toBeDefined();
    expect(panelCount!.canonicalField).toBe('panel_count');
    expect(panelCount!.source).toBe('template');

    const buildingAge = result.appliedDecisions.find((d) => d.sourceColumn === '築年数');
    expect(buildingAge).toBeDefined();
    expect(buildingAge!.canonicalField).toBe('building_age_years');
    expect(buildingAge!.source).toBe('template');

    // 未 seed 列は fail-closed で unresolved に残る
    expect(result.unresolvedColumns).toContain('部材名');
    expect(result.unresolvedColumns).not.toContain('設置kw');
    expect(result.unresolvedColumns).not.toContain('枚数');
    expect(result.unresolvedColumns).not.toContain('築年数');
  });
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npx vitest run test/core/auto-apply-orchestrator.test.ts --reporter=verbose 2>&1 | tail -30
```

期待結果: `customer_master partial — resolves numeric seeded cols` が FAIL。
`kw` が `undefined` になるため `expect(kw).toBeDefined()` で失敗するはず。

---

### Task 2: templates.json に numeric seed を追加する

**Files:**
- Modify: `data/seeds/260312/templates.json`

- [ ] **Step 1: 3 エントリを追加する**

`data/seeds/260312/templates.json` の `tmpl_customer_master_260312_v1` テンプレート内、
`設置店名` エントリ（現在の最終 column_decision）の直後、`]`（column_decisions 配列の閉じ括弧）の直前に以下を追加する。

追加前（末尾付近）:
```json
      {
        "source_col": "設置店名",
        "canonical_field": "installation_site_name",
        ...
      }
    ],
    "auto_apply_eligibility": "partial",
```

追加後:
```json
      {
        "source_col": "設置店名",
        "canonical_field": "installation_site_name",
        "inferred_type": "name",
        "normalization_rule": "trim",
        "confidence": "high",
        "decided_at": "2026-04-07T00:00:00Z",
        "decided_by": "auto",
        "notes": "solar 260312 seed 由来。設置場所の名義人氏名。5316/5357 非空。"
      },
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
    ],
    "auto_apply_eligibility": "partial",
```

- [ ] **Step 2: `notes` フィールドを更新する**

同テンプレート末尾の `"notes"` フィールドを更新する。

> 注意: 現在の notes は "70 列" と記載されているが、実際の column_decisions は 78 件（text/name 8列が追加済みだが notes 未更新）。今回 3 列追加で 81 件になるため、notes を実態に合わせて修正する。

変更前（`notes` の現在値）:
```
"notes": "solar 260312 seed 由来。260312_顧客_太陽光.csv / .xlsx (124列、CSV と XLSX は同一列構成)。master row + portal 混在前提。全 124 列のうち代表 70 列を seed（customer canonical 63列 + portal artifact 7列）。残り 54 列は人手レビュー。内訳: 基本属性 20列 / date 系 22列 / cancel 系 3列 / status-detail 1列 / portal 7列 / 人系 6列（作成者・修正者・訪問担当者・ｱﾎﾟ担当・担当者ﾌﾘｶﾞﾅ・代表者ﾌﾘｶﾞﾅ）/ ID系 2列（申請ID・伝票番号）/ 成績・請求系 4列（成績計上日・成績計上月・請求書発行日・入金日）/ 書類・手続き系 5列（借受証発送・承諾書発送・報告書到着日・保証書着・保証申請）/ 設備フロー系 2列（平面図到着・完工報告）。portal 列（ｱﾎﾟﾘｽﾄ:: / ｺｰﾙ履歴:: prefix）は canonical_field=null で auto-apply 側が skip 扱いにする。auto_apply_eligibility=partial（全 seeded 列が high confidence のため、seeded 列を auto-apply し未解決列を review queue へ）。schema_fingerprint: computeSchemaFingerprint(headers) from review-bundle.ts (lowercase+trim, sort, join \0)。算出根拠: scripts/compute-template-fingerprints-260312.ts"
```

変更後（`70 列` → `81 列`、`63列` → `74列`、`54 列` → `43 列`、text/name 系 8列・numeric 系 3列を breakdown に追記）:
```
"notes": "solar 260312 seed 由来。260312_顧客_太陽光.csv / .xlsx (124列、CSV と XLSX は同一列構成)。master row + portal 混在前提。全 124 列のうち代表 81 列を seed（customer canonical 74列 + portal artifact 7列）。残り 43 列は人手レビュー。内訳: 基本属性 20列 / date 系 22列 / cancel 系 3列 / status-detail 1列 / portal 7列 / 人系 6列（作成者・修正者・訪問担当者・ｱﾎﾟ担当・担当者ﾌﾘｶﾞﾅ・代表者ﾌﾘｶﾞﾅ）/ ID系 2列（申請ID・伝票番号）/ 成績・請求系 4列（成績計上日・成績計上月・請求書発行日・入金日）/ 書類・手続き系 5列（借受証発送・承諾書発送・報告書到着日・保証書着・保証申請）/ 設備フロー系 2列（平面図到着・完工報告）/ text/name 系 8列（注意事項・備考・営業コメント・工事希望・工事希望1・施工管理・販売店・設置店名）/ numeric 系 3列（設置kw・枚数・築年数）。portal 列（ｱﾎﾟﾘｽﾄ:: / ｺｰﾙ履歴:: prefix）は canonical_field=null で auto-apply 側が skip 扱いにする。auto_apply_eligibility=partial（全 seeded 列が high confidence のため、seeded 列を auto-apply し未解決列を review queue へ）。schema_fingerprint: computeSchemaFingerprint(headers) from review-bundle.ts (lowercase+trim, sort, join \\0)。算出根拠: scripts/compute-template-fingerprints-260312.ts"
```

- [ ] **Step 3: JSON の構文を確認する**

```bash
node -e "JSON.parse(require('fs').readFileSync('data/seeds/260312/templates.json','utf-8')); console.log('JSON OK')"
```

期待結果: `JSON OK`

---

### Task 3: テストを通す・typecheck・コミット

**Files:**
- 変更なし（Task 1・2 の成果物を検証してコミット）

- [ ] **Step 1: 新規テストが通ることを確認する**

```bash
npx vitest run test/core/auto-apply-orchestrator.test.ts --reporter=verbose 2>&1 | tail -40
```

期待結果: 全テスト PASS。`customer_master partial — resolves numeric seeded cols` も PASS。

- [ ] **Step 2: 既存テスト全体が壊れていないことを確認する**

```bash
npx vitest run test/core/ --reporter=verbose 2>&1 | tail -20
```

期待結果: 全テスト PASS。

- [ ] **Step 3: typecheck を通す**

```bash
npx tsc --noEmit 2>&1 | head -20
```

期待結果: エラーなし（出力なし）。

- [ ] **Step 4: コミットする**

```bash
git add data/seeds/260312/templates.json test/core/auto-apply-orchestrator.test.ts
git commit -m "$(cat <<'EOF'
feat(seed): add numeric cols to customer_master 260312 template

設置kw(decimal) / 枚数(integer) / 築年数(integer) を high confidence で seed 追加。
全件半角数値・単位なし確認済み。normalization_rule=trim。
81列 seed 済み（+3、旧 78列）。auto_apply_eligibility=partial 維持。

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

期待結果: コミット成功。

---

## 完了チェックリスト

- [ ] `tmpl_customer_master_260312_v1` に `設置kw` / `枚数` / `築年数` の 3 エントリがある
- [ ] 3 列の `confidence` がすべて `high`
- [ ] `設置kw` が `inferred_type: "decimal"`、`枚数` と `築年数` が `inferred_type: "integer"`
- [ ] `auto_apply_eligibility` が `"partial"` のまま
- [ ] `notes` が 81 列表記に更新されている
- [ ] `auto-apply-orchestrator.test.ts` に numeric テストが追加され PASS
- [ ] 既存テスト全体 PASS
- [ ] typecheck エラーなし
