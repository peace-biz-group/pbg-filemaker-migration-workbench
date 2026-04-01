# CLAUDE.md — Agent 作業前提

このファイルは Claude Code が実装判断を行う前に読む作業前提です。
実装依頼を受ける前に必ずこの内容を前提として設定してください。

---

## この repo の一言定義

> 稼働中の FileMaker を止めずに、意味単位でデータを解体・分類・既知化し、差分に耐える形へ整備するワークベンチ。

詳細は [`docs/workbench-mission.md`](docs/workbench-mission.md) を参照してください。

---

## 何を作る repo か

- FileMaker から出力した CSV / XLSX を受け取り、「これは何のファイルか」「この列は何か」を現場と一緒に決めていく仕組み
- profile マッチング / 列レビュー / effective mapping / candidate profile によって、既知化された設定を積み上げる仕組み
- 繰り返し読み込み・差分チェック・再投入に耐えるパイプライン
- ヘッダーなし CSV / ヘッダーあり CSV の両方を扱う
- 現場（低リテラシー）が使える、簡単な日本語 UI

## 何を作らない repo か

- Ops Core v1（本番業務システム）は別プロジェクト。この repo はその前段
- 最終移行スクリプト（一回実行して終わり）ではない
- 全件人手レビューを前提とするシステムではない
- FileMaker の稼働を止めて行うバッチ移行ではない
- 汎用 ETL / データウェアハウス / BI ツールではない
- 複雑なルールエンジン、AI による自動確定システムではない

---

## 最優先事項

1. **raw 原本の保全** — 入力ファイルを変更・削除しない。常に再実行できる状態を保つ
2. **unsafe な自動確定をしない** — 候補・提案は出すが、確定は人が行う
3. **FileMaker の稼働を止めない** — 読み取り・処理はローカルのみ。既存 FileMaker に書き込まない
4. **差分耐性** — 同じファイルを何度読み込んでも安全に処理できること
5. **現場で使えること** — 簡単な日本語 UI、中学生でも判断できる選択肢

---

## 非機能制約

- **ストリーム処理必須** — 大容量ファイル（300万件規模）はメモリ展開しない
- **ローカル専用** — 外部サービス・クラウド API への送信は禁止
- **XLSX を必須にしない** — XLSX 対応は補助。大容量は CSV に変換させる
- **cp932 優先** — FileMaker 出力は Shift-JIS / cp932 が多い。encoding 自動検出は cp932 を優先
- **後方互換** — run meta / profile / review の JSON は追加フィールドで拡張し、既存を破壊しない

---

## 実装判断原則

### 安全側に倒す
- 迷ったら「候補として出す」方を選ぶ。自動確定は避ける
- fast path / candidate profile は便利機能だが、`confidence === 'high'` のときだけ適用する
- unknown / pending は fail-closed（mapping に含めない）

### 最小差分で入れる
- 要求されていない機能・抽象化・設定項目を追加しない（YAGNI）
- 1依頼1テーマ。複数テーマが混ざったと感じたら確認する
- エラーハンドリング・バリデーションは system boundary（ユーザー入力・外部ファイル）のみ

### 既存構造を壊さない
- built-in profile / candidate profile / review / effective mapping の責務分離を保つ
- run-scoped な effective mapping を profile 本体に書き戻さない
- 既存の confirm / columns / rerun / run detail 導線を壊さない

### テストは実態に合わせて書く
- モックは最小限。ファイル I/O・DB 操作は実際のディレクトリを使う
- 巨大ファイルのテストは fixture を小さく切ったもので代替

---

## docs 参照順

実装判断に迷ったとき:

1. `CLAUDE.md`（このファイル）— 作業前提
2. `docs/workbench-mission.md` — 目的・対象・成功条件の正本
3. `README.md` — CLI / UI の操作説明
4. `docs/superpowers/plans/` — 直近の実装計画
5. `docs/superpowers/specs/` — 設計仕様

---

## 避けるべきこと

- 既存 build / lint / typecheck エラーの全面修正（今回触る範囲で悪化させないこと）
- profile CRUD 管理画面の構築（今の scope 外）
- 複数ファイル同時 upload 対応（scope 外）
- rerun-with-review の run-batch 対応（scope 外）
- dedupe / quarantine / pipeline の大改修（scope 外）
- UI 全面リデザイン（scope 外）
- 複雑なルールエンジン化（scope 外）
- 内部用語（candidate / effective mapping / pending / profile strength）を現場 UI に出すこと
- docstring・コメント・型アノテーションを触っていないコードに追加すること
- 未使用の `_var` リネームや backwards-compatibility shim の追加

---

## 現場 UI 文言の原則

- **簡単な日本語** — 中学生が読んでも分かる言葉を使う
- **内部語を出さない** — 「candidate profile」「effective mapping」「pending」「profile strength」は UI に表示しない
- **英語を増やさない** — 操作ラベル・エラーメッセージは日本語
- **選択肢は具体的に** — 「このまま進む」「列を確認する」「別の種別を選ぶ」「新しいファイルとして扱う」
- 現場が「わからない」と選んだ回答は、「不明」のまま記録し、自動確定しない

---

## 繰り返し import / headerless CSV / 差分前提

- 同じファイルを何度 upload しても安全に処理できること
- ヘッダーなし CSV は filename + 列数 + headerlessSuitable フラグで候補を出す
- 差分チェック / 再投入 / 再統合は一回で終わらない。sourceBatchId / schemaFingerprint で追跡する
- アポリスト約 283 万件は全件人手レビューしない。テンプレート適用 + 差分確認が主戦場

---

## 人とシステムの役割

| システムがすること | 人がすること |
|-----------------|------------|
| ファイル種別の候補を出す | 「これで合っている」を確定する |
| 列の意味を提案する | 「この列は何に使うか」を決める |
| 差分を検出する | どの差分を取り込むかを決める |
| 重複候補を出す | どれが本物の重複かを判断する |
| effective mapping を生成する | 例外・訂正を入力する |

現場回答は **candidate / proposal** であり、canonical truth ではない。
既知化された設定（profile / candidate / mapping）を積み上げながら、毎回の確認コストを下げていく。
