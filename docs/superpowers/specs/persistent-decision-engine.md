# Persistent Decision Engine — 設計概要

> **目的:** 一度行った判断を保存し、次回以降は自動適用することで、毎回の人手レビューを不要にする。

---

## 背景と課題

現在の運用は「毎回 review CSV を人手で埋める」前提になっている。
Phase 5 の `manual-resolution-template.csv`（462 行）を毎 run 埋める運用は、
ファイルが同型であっても判断を再入力させる構造になっており、スケールしない。

### 解決すべき問い

| 問い | 現状 | 目標 |
|------|------|------|
| 同じファイルを再投入したとき | 再レビューが発生する | 既知判断を自動適用 |
| 同じ形のファイルが来たとき | 列マッピングを一から確認 | テンプレートを自動適用 |
| 電話番号の shared phone を再度見たとき | 再判断が要求される | 保存済み判断を適用 |
| ステータス辞書が固まったあと | 毎回 hearing が必要 | v3 辞書を自動参照 |

---

## 設計原則

1. **決めたことは保存する** — 人が「確定」した判断はすべて JSON に書き出す
2. **ファイル形状で識別する** — raw filename ではなく `file_shape_fingerprint` で同型を判定
3. **信頼度で自動化範囲を制御する** — `certainty: high` のみ自動適用。`low/unknown` は review 送り
4. **上書き可能にする** — 保存済み判断は明示的に override できる。古い判断が足を引っ張らない
5. **追加フィールドで拡張する** — 既存の state JSON 構造を壊さず、新しい JSON ファイルを追加する

---

## 三層構造

```
Persistent Decision Engine
├── Source Family Registry      ← 「このファイルは何系か」を識別・記憶
├── Mapping Template Registry   ← 「この列はどう変換するか」を記憶
└── Resolution Memory           ← 「このケースはどう判断するか」を記憶
```

### 層間の関係

```
ファイル投入
    │
    ▼
[Source Family Registry]
    file_shape_fingerprint を計算
    既知 family と照合
    → family 特定 (顧客管理系 / コール履歴系 / …)
    │
    ▼
[Mapping Template Registry]
    family + schemaFP でテンプレート検索
    → high-certainty なら自動適用
    → low-certainty / 新規 schemaFP なら列レビュー
    │
    ▼
[Resolution Memory]
    run 中に発生した例外ケース (shared_phone / status 不明 / etc.)
    を既知 rule と照合
    → 保存済みなら自動解決
    → 未知なら review queue に送る
    │
    ▼
[Review Queue]
    未解決のものだけ人に渡す
    人の判断を受け取ったら Resolution Memory に書き戻す
```

---

## ストレージ構造

```
{outputDir}/
└── .decisions/                         ← 判断永続化ディレクトリ
    ├── source-family-registry.json     ← ファイル family 定義 + 識別ルール
    ├── mapping-template-registry.json  ← 列マッピングテンプレート集
    ├── resolution-memory.json          ← 判断 ledger（type別・context別）
    └── decision-audit-log.jsonl        ← 判断の変更履歴（append-only）
```

既存の `.state/workbench-state.json` は **変更しない**。
`.decisions/` は別ディレクトリとして追加する。

---

## 既存コードとの接続点

| 既存モジュール | 接続方法 |
|------------|---------|
| `template-store.ts` | `mapping-template-registry.json` のバックエンドとして利用・拡張 |
| `import-state.ts` | `source_batch_id` / `merge_ledger` はそのまま。`decision_ledger` を追加 |
| `effective-mapping.ts` | run-scoped mapping 生成時に template を参照するよう拡張 |
| `column-mapper.ts` | template-registry から suggestion を引く |
| `review-bundle.ts` | resolution memory に already-decided なものをフィルタ |
| Phase 5 手動解決テンプレート | 回答 CSV → resolution memory への変換スクリプトを追加 |

---

## 判断の一生

```
初回 run
  人が判断 (review CSV / UI 選択)
      ↓
  判断を Resolution Memory に保存
      ↓
  decision-audit-log に記録

次回以降の run
  Resolution Memory と照合
      ↓
  certainty = high → 自動適用 (review に送らない)
  certainty = low  → review に送る (保存済み判断を参考情報として添付)
  不一致 / 矛盾   → conflict review に送る
```

---

## 実装フェーズ

| フェーズ | 内容 | 成果 |
|---------|------|------|
| Phase 7a | Source Family Registry 設計・実装 | ファイル分類自動化 |
| Phase 7b | Mapping Template Registry 拡張 | 列マッピング自動適用 |
| Phase 7c | Resolution Memory 実装 | 例外判断の再利用 |
| Phase 7d | Rerun Idempotency v2 統合 | 再投入時の自動化完成 |
| Phase 7e | Review Queue フィルタ統合 | manual review 最小化達成 |

---

## 成功基準

- 同一 schemaFP のファイルを再投入したとき、列レビューなしで進む
- Phase 5 相当の shared_phone 462 件が、2 回目以降は review に出てこない
- status 辞書 (v3) が保存され、次 run 時に自動適用される
- 未知の例外だけが review queue に送られ、review 件数が run ごとに減少する
