# Huge CSV Split Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 巨大 FileMaker CSV を Workbench 内で安全に分割し、part 001 実行後の resume で残り part に設定を自動適用できる CLI 機能を追加する。

**Architecture:** 既存 `ingestFile` の quote fallback を使って raw CSV を安全に part 化し、個別 part の実行は `executeRun` を再利用する。新規機能は `split` と `split-run` に閉じ、manifest と summary に split / part001 / resume の段階と reuse 事実を残す。

**Tech Stack:** TypeScript, Commander, existing ingest pipeline, existing CSV writer, Vitest

---

### Task 1: 型と仕様反映

**Files:**
- Modify: `src/types/index.ts`
- Modify: `docs/superpowers/specs/2026-04-06-huge-csv-split-run-design.md`
- Test: `test/core/huge-csv-split.test.ts`

- [ ] **Step 1: split/split-run summary 型のテスト骨組みを書く**
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: manifest / summary / reusable context の型を追加する**
- [ ] **Step 4: テストまたは typecheck で整合性を確認する**

### Task 2: 安全 split コア実装

**Files:**
- Create: `src/core/huge-csv-split.ts`
- Modify: `src/io/csv-writer.ts`
- Test: `test/core/huge-csv-split.test.ts`

- [ ] **Step 1: quote 崩れ CSV を split できる failing test を書く**
- [ ] **Step 2: テストが期待通り fail することを確認する**
- [ ] **Step 3: `splitCsvFile()` を最小実装する**
- [ ] **Step 4: header 付与・欠落なし・重複なしの追加 failing test を書く**
- [ ] **Step 5: part writer を調整してテストを pass させる**
- [ ] **Step 6: manifest に sourceDiagnosis / stage を入れる**
- [ ] **Step 7: split テスト群を再実行する**

### Task 3: split-run の part001 実行

**Files:**
- Create: `src/core/huge-csv-split-run.ts`
- Modify: `src/core/pipeline-runner.ts`
- Test: `test/core/huge-csv-split-run.test.ts`

- [ ] **Step 1: split-run 初回実行で part001 だけ走って止まる failing test を書く**
- [ ] **Step 2: fail を確認する**
- [ ] **Step 3: `runInitialSplitPart()` 相当を最小実装する**
- [ ] **Step 4: summary に stage / stopReason / partResults が残るよう実装する**
- [ ] **Step 5: テストを再実行して pass を確認する**

### Task 4: resume と reusable context

**Files:**
- Modify: `src/core/huge-csv-split-run.ts`
- Modify: `src/core/pipeline-runner.ts`
- Test: `test/core/huge-csv-split-run.test.ts`

- [ ] **Step 1: resume で残り part を処理できる failing test を書く**
- [ ] **Step 2: reusable context がないと resume 失敗する failing test を書く**
- [ ] **Step 3: schemaFingerprint 不一致で停止する failing test を書く**
- [ ] **Step 4: fail を確認する**
- [ ] **Step 5: `resumeSplitRun()` と reusable context 抽出を実装する**
- [ ] **Step 6: `reusedProfileId` / `reusedEffectiveMapping` / `reusedSourceRouting` / `reusedFromRunId` / `schemaFingerprintMatchedAllParts` を summary に保存する**
- [ ] **Step 7: テストを再実行して pass を確認する**

### Task 5: CLI 配線

**Files:**
- Create: `src/cli/commands/split.ts`
- Create: `src/cli/commands/split-run.ts`
- Modify: `src/cli/index.ts`
- Test: `test/core/huge-csv-split-run.test.ts`

- [ ] **Step 1: CLI の使用想定を表す failing test または最小統合テストを書く**
- [ ] **Step 2: fail を確認する**
- [ ] **Step 3: `split` / `split-run` コマンドを実装する**
- [ ] **Step 4: `--resume-from-manifest` / `--reuse-run` / `--manifest` を配線する**
- [ ] **Step 5: 関連テストを再実行する**

### Task 6: README と回帰確認

**Files:**
- Modify: `README.md`
- Test: `test/ingest/csv-ingest.test.ts`
- Test: `test/ui/server.test.ts`
- Test: `test/ui/upload-encoding-and-errors.test.ts`

- [ ] **Step 1: README に `split` / `split-run` / resume の使い方を書く**
- [ ] **Step 2: 既存通常系テストを実行する**
- [ ] **Step 3: typecheck と lint を実行する**
- [ ] **Step 4: 必要なら最小修正して全体を green にする**

---

## Self-Review

- spec coverage: split / part001 / resume / sourceDiagnosis / reuse summary / stopReason / schema 停止を全タスクに割り当てた
- placeholders: 実装対象ファイルと検証観点を明記した
- type consistency: `SplitManifest`, `SplitRunSummary`, reusable context の反映先を揃えた

