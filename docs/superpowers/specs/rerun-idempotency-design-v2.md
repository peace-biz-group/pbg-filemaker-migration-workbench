# Rerun Idempotency Design v2

> **目的:** same source 再投入・同型ファイル再投入・既知ルール自動適用・未知例外のみ review 送りを成立させる。

---

## v1 との差分

### v1（現状）

`import-state.ts` の `source_batch_id` (SHA256 of filepath + file_sha256 + mode + config_hash) により:
- **同一ファイル再投入の検知** → duplicate warning
- **merge_ledger** → どの row がいつ最後に見られたかを記録

**限界:**
- source_batch_id はファイル内容の重複検知に使われているが、「判断の再利用」はしていない
- 同型ファイル（同 schemaFP だが filename が違う）は別ファイルとして扱われ、列レビューが再発生する
- 人手 review (phase5 の 462 件) は毎回再入力が必要

### v2（設計目標）

| シナリオ | v1 の挙動 | v2 の目標挙動 |
|---------|----------|-------------|
| 同一ファイル再投入 | duplicate warning → skip | 既知判断を自動適用して skip |
| 同 schemaFP 別 filename | 列レビュー発生 | テンプレート自動適用 → レビューなし |
| 同 family 別 schemaFP | 全て列レビュー | 80% 以上共通なら partial 適用 |
| shared_phone 再検出 | review queue に送る | resolution memory から自動解決 |
| status 未知値再出現 | review queue に送る | status_meaning resolution から自動解決 |
| split-run part 再実行 | manifest で管理済み | part 単位の idempotency 保持（v1 継承） |

---

## Idempotency の定義

> 同じ入力セットを何度実行しても、出力は同一であり、副作用（review queue への追加・DB 挿入）は初回だけ発生する。

### 担保する範囲

1. **ファイルレベル** — 同一 file_sha256 のファイルは再 ingest しない
2. **行レベル** — merge_ledger で重複 row は skip
3. **判断レベル** — resolution memory に保存された判断は自動適用、review に送らない
4. **テンプレートレベル** — mapping template が存在する schemaFP は列レビューを skip

---

## 実行フロー（v2）

```
ファイル受信
    ↓
[1] File Idempotency Check
    SHA256 計算 → import-state で source_batch 検索
    ├── 既知 batch (same SHA256)
    │   ├── status = completed → skip (同一内容は再処理しない)
    │   └── status = partial   → 残りの part から再開
    └── 新規 → source_batch 作成 → 続行

    ↓
[2] Family Detection (Source Family Registry)
    file_shape_fingerprint 計算
    → known_fingerprints 検索
    ├── 既知 + certainty = confirmed/high
    │   → family_id + default_template_id を確定
    └── 未知 / low
        → keyword 分析 → 候補表示 → 人が確定
        → registry に保存

    ↓
[3] Template Application (Mapping Template Registry)
    schemaFP + family_id でテンプレート検索
    ├── auto_apply_eligibility = "full"
    │   → テンプレートから effective_mapping を生成 → 列レビュー不要
    ├── auto_apply_eligibility = "partial"
    │   → confirmed/high 列を pre-fill
    │   → low 列だけ列レビュー画面に表示
    └── テンプレートなし / "review_required"
        → 通常の列レビューフロー

    ↓
[4] Pipeline 実行（normalize → duplicate detection → classify）

    ↓
[5] Exception Resolution (Resolution Memory)
    発生した例外（shared_phone / status_unknown / etc.）を resolution memory と照合
    ├── 既知 resolution → 自動適用 → decision-audit-log に記録
    └── 未知 → review queue に追加

    ↓
[6] Review Queue 処理
    未知例外だけが review queue に入る
    人が判断 → resolution memory に保存 → decision-audit-log に記録

    ↓
[7] Source Batch 完了マーク
    import-state に status = completed を記録
```

---

## 同一ファイル再投入の詳細フロー

```
source_batch_id が既知 (completed)
    ↓
何が変わったか分析:
    file_sha256 が同じ → skip (no-op)
    file_sha256 が違う → 差分再処理

差分再処理の場合:
    run-diff-summary で前回 run と比較
    ├── schema_changed → 新 schemaFP でテンプレート再照合
    ├── row_count_changed → 差分行のみ処理
    └── same_content → skip
```

---

## 同型ファイル（別バッチ）の投入フロー

```
新 filename、新 SHA256 だが schemaFP は既知
    ↓
Family Registry で family_id を確定 (fingerprint ヒット)
    ↓
Mapping Template Registry でテンプレートを取得
    auto_apply_eligibility = "full" → 列レビューなし
    ↓
Resolution Memory を全て pre-load
    → run 中の例外をリアルタイムで照合

結果:
    - 列レビュー不要
    - status hearing 不要
    - shared_phone の再判断不要
    → 完全自動で pipeline が走る
```

---

## Split-Run との統合（v1 継承 + 拡張）

v1 で実装済みの `huge-csv-split-run.ts` は part 単位で manifest を持つ。
v2 では split part の処理にも resolution memory を適用する:

```
split-run 開始
    ↓
manifest から schemaFP を取得 → テンプレートを一回だけ取得
    ↓
各 part の処理:
    - effective_mapping は共通のテンプレートから生成（part ごとに再作成しない）
    - resolution memory は全 part 共通で参照
    - 未知例外は part 識別子付きで review queue に追加
    ↓
全 part 完了後:
    review queue を一括表示 → 人が判断 → resolution memory に保存
    → 再 run 時は自動適用
```

---

## Idempotency の保証事項

| 保証 | 実装 |
|-----|------|
| 同一 SHA256 は再 ingest しない | `import-state.ts` の source_batch チェック（v1 継承） |
| 同一 schemaFP は列レビューを skip | `mapping-template-registry.json` のヒット確認 |
| 既知 resolution は review queue に入れない | `resolution-memory.ts` の照合 |
| 全判断適用を audit log に記録する | `decision-audit-log.jsonl` への append |
| override 可能にする | `resolution_id` + `decided_by: "human"` で上書き |

---

## 状態遷移ダイアグラム

```
[unknown file]
    → Family Registry: unknown → 人が確定 → [known family]

[known family, unknown schemaFP]
    → Template Registry: miss → 列レビュー → テンプレート作成 → [known template]

[known template, unknown exceptions]
    → Pipeline → exceptions → resolution memory: miss → review → [known resolutions]

[known template, known resolutions]
    → Pipeline → 完全自動実行 → staging output
```

目標は全ファイルを最終状態（完全自動）に到達させること。
初回だけコストがかかり、2 回目以降はゼロレビューで走る。

---

## 未解決事項（v2 設計時点）

| 問い | 現時点の方針 |
|-----|------------|
| テンプレート間の conflict（同 schemaFP に複数候補）| 最後に confirmed したものを優先 |
| resolution の有効期限 | 設けない（明示 override まで有効） |
| DB 接続後の idempotency（挿入済みの row 重複）| Phase 7d 以降で設計（staging insert に ON CONFLICT を使う） |
| 大規模 resolution memory のパフォーマンス | JSON ファイルが 10MB 超えたら分割を検討 |
