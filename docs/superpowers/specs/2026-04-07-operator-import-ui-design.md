# operator import UI 設計仕様

**日付**: 2026-04-07  
**対象**: pbg-filemaker-migration-workbench  
**フェーズ**: Phase 1 — 保存まで（run 実行は次フェーズ）

---

## 1. 変更概要

福岡担当者（operator）が「ファイル投入 → 自動判定確認 → 要確認だけ判断 → 保存」を行える最小 UI を追加する。

**今回フェーズの完了条件:**

```
ファイル投入 → POST /api/import-preview → 自動判定結果表示
→ 要確認列を 1 件ずつ確認 → 保存範囲付きで保存 → 左ペイン状態反映
→ 完了サマリ表示（ダッシュボードに戻る）
```

**今回フェーズに含まれないもの（次フェーズ）:**
- run 作成（パイプライン実行）
- 実行結果の確認
- run 履歴
- 再実行

> **理由**: 1テーマ厳守・最小差分。operator の判断蓄積（保存）フェーズと、実際のデータ処理（実行）フェーズは独立して段階的に導入する。

### 「今回のみ適用」の扱い

「今回のみ適用」はセッション内の一時的な判断であり、API を呼び出さない。ページを離れると消える。次回以降の自動判定には使用されない。resolution memory にも保存しない。

---

## 2. 変更ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `src/core/resolution-memory.ts` | `ResolutionType` に `'column_canonical'` を追加 |
| `src/core/auto-apply-orchestrator.ts` | Step 4b で `column_canonical` も解決対象に追加 |
| `src/ui/server.ts` | `POST /api/import-preview` 追加、`VALID_RESOLUTION_TYPES` に `'column_canonical'` 追加 |
| `src/ui/public/app.js` | `/import` ルート + `renderImportPage()` 追加、ダッシュボードにナビボタン追加 |
| `test/core/auto-apply-orchestrator.test.ts` | column_canonical 解決テストを追加 |
| `test/ui/import-preview.test.ts` | 新規: `/api/import-preview` エンドポイントテスト |

---

## 3. UI 構成

### ルート

`/import`（新設）。クライアントサイドルーターに追加。ダッシュボードに「ファイルを取り込む」ボタンを追加して導線を引く。

### 4セクション（シングルページ展開）

```
Section 1: ファイルを選ぶ  ← 常時表示
Section 2: 判定結果        ← /api/import-preview 完了後に展開
Section 3: 要確認 2ペイン  ← unresolved > 0 のとき展開（0 件の場合は「要確認なし」を表示）
Section 4: 完了サマリ      ← 全件が「保存済」または「スキップ」になった後に展開
```

#### Section 1: ファイルを選ぶ

- drag-and-drop ゾーン + `<input type="file" accept=".csv,.xlsx">`
- ファイル選択後に `POST /api/import-preview` を呼び出す
- 処理中はローディング表示
- 「※ファイルは変更・保存されません（参照専用）」注釈

#### Section 2: 判定結果

4 枚のカード:

| カード | 内容 | 色 |
|--------|------|---|
| ファイル種別 | `familyId` 表示（例: 顧客マスタ 260312 太陽光） | — |
| 自動で判定済み | `appliedDecisions.length` 件 | 緑 |
| 要確認 | `unresolvedColumns.length` 件 | オレンジ |
| 総列数 | 上 2 つの合計 | — |

ファイル名・検出エンコーディング・総行数を小文字で補足表示。

#### Section 3: 要確認 2ペイン

**左ペイン（幅 210px）:**

- 上部: 「要確認 残り N 件」（保存・スキップのたびに更新）
- 各行: 列名 + 状態バッジ
  - `未確認`（デフォルト、グレー）
  - `保存済`（緑、保存時）
  - `スキップ`（薄グレー、スキップ時）
- 選択中の行は青ハイライト（`border-left: 3px solid #3b82f6`）
- クリックで右ペインを切り替え可能

**右ペイン（flex: 1）:**

- 列名（H3）
- 「値あり: N 件（全 M 件中）」補足
- 「実際に入っている値（出現頻度 上位5件）」タグ群（各タグに件数表示）
- テキスト入力: 「この列の意味」（任意なし、入力を促す）
- 保存範囲ラジオ（黄背景カード）:
  - `今回のみ適用` — 今回の判断はこのセッションだけに使用します
  - `テンプレートとして保存` — 次回以降、同じファイル種別で自動的に使用されます
- ボタン行:
  - `[保存]`（primary）
  - `[スキップ]`（secondary）+ 「スキップ = 未対応のまま次へ進みます」注釈

#### Section 4: 完了サマリ

4 枚のカード（件数集計）:
- 自動判定済み（緑）
- テンプレートとして保存（青）
- 今回のみ適用（グレー）
- スキップ（未対応）（薄グレー）

「ダッシュボードに戻る」ボタン。run 作成・実行への導線は今回追加しない。

---

## 4. API 仕様

### `POST /api/import-preview`（新規）

**リクエスト**: `multipart/form-data` — `file`: CSV または XLSX

**レスポンス**:

```typescript
interface ImportPreviewResponse {
  autoApplyResult: AutoApplyPreviewResult;  // 既存型、変更なし
  columnSamples: Record<string, ColumnSample>;
  totalRows: number;
  detectedEncoding: string;  // XLSX の場合は 'xlsx'
  fileName: string;
}

interface ColumnSample {
  nonEmptyCount: number;
  topValues: Array<{ value: string; count: number }>;
}
```

**サンプリング戦略**:

- `readFileInChunks` でストリーム読み込み（大容量対応）
- 最大 `MAX_SAMPLE_ROWS = 100_000` 行まで読む（先頭 N 行固定ではなく全体集計で偏りを抑制）
- 列ごとに出現カウントを蓄積し、上位 5 件を降順で返す
- サンプル取得に失敗した列は `topValues: []`、リクエスト全体は失敗させない

**エラー処理**:

- ファイルなし → 400
- 読み込みエラー → 500 + エラーメッセージ
- unresolved 0 件 → 正常レスポンス（`unresolvedColumns: []`）

### 既存 API の変更

**`POST /api/decisions/resolutions`**: `VALID_RESOLUTION_TYPES` に `'column_canonical'` を追加。  
**`POST /api/auto-apply-preview`**: 変更なし（既存契約を保持）。

---

## 5. 保存フロー

### 「今回のみ適用」で「保存」

- API 呼び出し**なし**
- セッション内 UI 状態のみ更新（左ペインバッジ → `保存済`）
- ページリロード・離脱で消滅する
- resolution memory に書き込まない

### 「テンプレートとして保存」で「保存」

`POST /api/decisions/resolutions` を呼び出す:

```json
{
  "resolution_id": "<uuid>",
  "resolution_type": "column_canonical",
  "context_key": "column:<source_col>",
  "family_id": "<autoApplyResult.familyId>",
  "decision": "<operator_input>",
  "decision_detail": {
    "canonical_field": "<operator_input>",
    "decided_via": "import_ui"
  },
  "certainty": "confirmed",
  "scope": "family",
  "decided_at": "<ISO8601>",
  "decided_by": "human",
  "auto_apply_condition": "always",
  "source_batch_ids": [],
  "notes": "<operator_input>"
}
```

成功後: 左ペインバッジ → `保存済`。

### 「スキップ」

- API 呼び出しなし
- 左ペインバッジ → `スキップ`
- 次の未確認列を自動選択

### resolution memory → orchestrator 反映

`column_canonical` で保存した決定は、次回の `runAutoApplyPreview` 呼び出し時に Step 4b で参照され、その列を解決済みとして扱う（`source: 'memory'`）。

**orchestrator の変更箇所（既存 Step 4 の直後に追加）**:

```typescript
// Step 4b: Apply resolution memory (column_canonical type)
for (const col of columns) {
  if (resolvedColumns.has(col)) continue;
  const rec = lookupResolution('column_canonical', `column:${col}`, memory);
  if (rec && shouldAutoApply(rec)) {
    appliedDecisions.push({
      sourceColumn: col,
      canonicalField: rec.decision,
      confidence: rec.certainty,
      source: 'memory',
    });
    resolvedColumns.add(col);
  }
}
```

`templates.json` は今回変更しない。

---

## 6. 未解決

| 項目 | 理由 |
|------|------|
| run 作成・実行 | 次フェーズ。今回は「保存まで」に限定 |
| run 履歴との紐付け | 次フェーズ |
| 再実行 | 次フェーズ |
| `templates.json` へのランタイム書き込み | 人手レビューが必要。今回対象外 |
| 「今回のみ適用」の run コンテキストへの引き継ぎ | run 作成フェーズで設計 |
| `column_canonical` decision の削除・編集 UI | 今回対象外 |
| ページ離脱時の未保存警告 | 今回対象外 |

---

## 7. テスト方針

### 既存テストへの影響

`test/core/auto-apply-orchestrator.test.ts` — 既存 22 件は変更なし。以下を追加:

- `column_canonical` がメモリにある列は Step 4b で解決される
- certainty=low の `column_canonical` は解決されない（fail-closed 維持）

### 新規: `test/ui/import-preview.test.ts`

- 正常: CSV アップロード → `autoApplyResult` + `columnSamples` が返る
- `topValues` は出現頻度降順 5 件
- unresolved 0 件でも正常レスポンス
- ファイルなし → 400
- `nonEmptyCount` は空値を除いた正しい件数

---

## 8. 次のnarrowテーマ

本フェーズ（保存まで）の実装完了後、以下の順で進める:

1. **run 作成・実行への導線** — 完了サマリから「実行する」ボタン追加、run 作成 API 呼び出し
2. **run 履歴の /import 連携** — import セッションと run を紐付けて表示
3. **再実行フロー** — 既存 run から /import 画面を再開できる導線
4. **「今回のみ適用」の run コンテキスト引き継ぎ** — 実行時に一時決定を run-scoped effective mapping に変換
