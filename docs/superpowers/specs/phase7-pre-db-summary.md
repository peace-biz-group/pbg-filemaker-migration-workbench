# Phase 7 — Pre-DB サマリ

> **目的:** DB 実行（Phase 8）に進む前に persistent decision engine を設計し、「ユーザーが export を置くだけで回る移行システム」の基盤を整える。

---

## 現在地（Phase 6 完了時点）

### 達成済み

| 内容 | 成果物 |
|------|--------|
| 顧客マスター・コール履歴の staging CSV 確定 | `phase3/customer-staging-v0.csv` 等 |
| staging DDL v1 確定 | `phase6/staging-ddl-v1.sql` |
| INSERT スクリプト v1 確定 | `phase6/staging-insert-draft-v1.sql` |
| Merge Policy v1 確定（Pattern 2） | `phase6/activity-call-merge-policy-v1.md` |
| Status 辞書 v3 確定 | `phase6/status-dictionary-v3.csv` |
| Go/No-Go 判定：**CONDITIONAL-GO** | `phase6/phase6-go-no-go.md` |

### CONDITIONAL-GO の条件

Phase 6 の go-no-go は「条件付き進行可」であった。
その条件の一つが「manual resolution の反映確認」であり、現状は未入力（未反映）のまま進んでいる。

Phase 7 で persistent decision engine を整備することで、
manual resolution が自動的に記録・適用される仕組みを作り、
この conditional を解除できる。

---

## Phase 7 で設計したこと

### 7 つの設計成果物

| 成果物 | 内容 | ファイル |
|--------|------|---------|
| Persistent Decision Engine 概要 | 三層構造・フロー・ストレージ設計 | `persistent-decision-engine.md` |
| Source Family Registry | file_shape_fingerprint + family 分類 | `source-family-registry-design.md` |
| Mapping Template Registry | 列マッピングテンプレート + 自動適用 | `mapping-template-registry-design.md` |
| Resolution Memory | 電話/status/merge policy の判断保存 | `resolution-memory-design.md` |
| Rerun Idempotency v2 | 再投入時の自動化フロー全体設計 | `rerun-idempotency-design-v2.md` |
| Manual Review 最小化方針 | review 件数削減の方針と目標値 | `manual-review-minimization-plan.md` |
| Phase 7 Pre-DB サマリ（このファイル） | 全体俯瞰・次フェーズへの接続 | `phase7-pre-db-summary.md` |

---

## システム目標の再定義

### Before（Phase 6 まで）

```
ユーザーが export CSV を持ってくる
    ↓
毎回 review CSV を人手で埋める（462 行 + α）
    ↓
status hearing を行う（16 値）
    ↓
列マッピングを確認する（49 列）
    ↓
審査が全部終わったら staging へ
```

### After（Phase 7 以降の目標）

```
ユーザーが export CSV を持ってくる
    ↓
[自動] family 識別 → テンプレート適用 → resolution 適用
    ↓
[必要時のみ] 未知例外だけ review に送る
    ↓
[自動] staging へ
```

---

## 新規追加コンポーネント一覧

| コンポーネント | ファイル | 既存コードへの影響 |
|-------------|---------|---------------|
| FamilyRegistry | `src/core/family-registry.ts` | `source-routing.ts` に lookup 追加 |
| MappingTemplateRegistry | `src/core/mapping-template-registry.ts` | `effective-mapping.ts` を拡張、`template-store.ts` を移行 |
| ResolutionMemory | `src/core/resolution-memory.ts` | `review-bundle.ts` にフィルタ追加 |
| DecisionAuditLog | `src/core/decision-audit-log.ts` | 全判断適用時に append |
| Seed スクリプト群 | `scripts/seed-*.ts` | 既存成果物を初期データとして登録 |

### ストレージ（追加のみ、既存を壊さない）

```
{outputDir}/
├── .state/workbench-state.json       ← 変更なし
└── .decisions/                       ← 新規追加
    ├── source-family-registry.json
    ├── mapping-template-registry.json
    ├── resolution-memory.json
    └── decision-audit-log.jsonl
```

---

## 実装優先順位

```
P0: Resolution Memory + review-bundle フィルタ
    → phase5 high-priority-review の再発を防ぐ
    → 影響: review 件数を最大 90% 削減

P1: Mapping Template Registry
    → 列レビューの再発を防ぐ
    → 影響: 同型ファイルの ingest を完全自動化

P2: Source Family Registry
    → family 自動分類
    → 影響: ファイル種別確認 UI を low-certainty 時のみ表示

P3: Rerun Idempotency v2 統合テスト
    → 全コンポーネント統合 + 260312 バッチ再投入テスト
```

---

## Phase 8（DB 実行）への接続条件

Phase 7 実装が完了し、以下を満たすことで Phase 8 に進む:

| 条件 | 確認方法 |
|------|---------|
| 260312 バッチ再投入時に review 件数 = 0 | `audit/260312/rerun-test` ログ |
| status 辞書 v3 が全自動適用される | `resolution-memory.json` に 16 値の seed 確認 |
| staging DDL v1 に対して insert スクリプトが冪等 | precheck / postcheck を 2 回実行して差分なし |
| manual resolution 未入力問題の解消 | resolution memory seed でカバー、go-no-go conditional を解除 |

---

## 未解決事項（Phase 8 以降に持ち越し）

| 問い | 持ち越し先 |
|-----|----------|
| DB 挿入後の ON CONFLICT 設計 | Phase 8 |
| staging → ops-core-ready の変換 | Phase 8 |
| Supabase / PostgreSQL 接続設定 | Phase 8（本番環境設定） |
| 複数バッチの cross-batch 重複検知 | Phase 8 以降 |
| アポリスト 283 万件の split-run + resolution 適用 | Phase 8 / Phase 9 |

---

## 一言まとめ

> Phase 7 は「毎回の人手 review」を「初回だけの判断保存」に変える基盤設計。
> Phase 8 の DB 実行に進む前に、この基盤を入れることで、
> 移行完了後の追加バッチ・再投入・新型ファイルが自動で処理される。
