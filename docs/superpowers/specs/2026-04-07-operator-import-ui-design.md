# operator import UI 設計仕様

**日付**: 2026-04-07  
**対象**: pbg-filemaker-migration-workbench  
**スコープ**: operator 最小 import UI ── `/import` 専用ルート、`POST /api/import-preview` API、orchestrator `column_canonical` 対応

---

## 目的

福岡担当者（operator）が「ファイル投入 → 自動判定確認 → 要確認だけ判断 → 保存」を行える最小 UI を追加する。既存の auto-apply orchestrator / resolution memory の責務を維持したまま、runtime で列マッピングを蓄積できる運転席を作る。

---

## 設計決定まとめ

| 項目 | 決定 |
|------|------|
| ルート | 専用ルート `/import`（新設） |
| 要確認 UI | 2ペイン（左:一覧+進捗、右:詳細+入力） |
| ページ構成 | シングルページ展開（4セクション順次展開） |
| 右ペイン | 出現頻度上位 5 件のサンプル値付き |
| 保存範囲 | 「今回のみ適用」（保存なし）／「テンプレートとして保存」（resolution memory） |
| 「テンプレートとして保存」の保存先 | `resolution_memory.json` — `resolution_type: "column_canonical"`（新型）|
| `templates.json` の自動書き換え | しない（人手レビュー時のみ） |

---

## 変更ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `src/core/resolution-memory.ts` | `ResolutionType` に `'column_canonical'` を追加 |
| `src/core/auto-apply-orchestrator.ts` | Step 4 で `column_canonical` も解決対象に追加 |
| `src/ui/server.ts` | `POST /api/import-preview` 追加、`VALID_RESOLUTION_TYPES` に `'column_canonical'` 追加 |
| `src/ui/public/app.js` | `/import` ルート + `renderImportPage()` 追加、ダッシュボードにナビボタン追加 |
| `test/core/auto-apply-orchestrator.test.ts` | column_canonical 解決テストを追加 |
| `test/ui/import-preview.test.ts` | 新規: `/api/import-preview` エンドポイントテスト |

---

## 1. TypeScript 変更: `resolution-memory.ts`

`ResolutionType` に `'column_canonical'` を追加する。意味: operator が確定した列の canonical フィールド名マッピング。

```typescript
export type ResolutionType =
  | 'shared_phone'
  | 'phone_exception'
  | 'status_meaning'
  | 'customer_deal_boundary'
  | 'parent_child_classification'
  | 'column_ignore'
  | 'encoding_exception'
  | 'merge_policy'
  | 'column_canonical';  // 追加: operator が確定した列マッピング
```

---

## 2. orchestrator 変更: `auto-apply-orchestrator.ts`

既存の Step 4（`column_ignore` 参照）の直後に Step 4b を追加する。`column_canonical` レコードを参照し、`shouldAutoApply` が true ならそのカラムを解決済みにする。

```typescript
// Step 4b: Apply resolution memory (column_canonical type)
for (const col of columns) {
  if (resolvedColumns.has(col)) continue;
  const rec = lookupResolution('column_canonical', `column:${col}`, memory);
  if (rec && shouldAutoApply(rec)) {
    appliedDecisions.push({
      sourceColumn: col,
      canonicalField: rec.decision,   // operator が入力した意味
      confidence: rec.certainty,
      source: 'memory',
    });
    resolvedColumns.add(col);
  }
}
```

既存の Step 1〜4 および Step 5 の変更なし。

---

## 3. 新 API: `POST /api/import-preview`

### 役割

ファイルをアップロードすると 1 回の呼び出しで以下を返す:
- `autoApplyResult`: 既存 `AutoApplyPreviewResult`（orchestrator がそのまま返す）
- `columnSamples`: 列ごとの代表値（出現頻度上位 5 件 + 非空件数 + 総行数）

### リクエスト

`multipart/form-data`
- `file`: CSV または XLSX

### レスポンス

```typescript
interface ImportPreviewResponse {
  autoApplyResult: AutoApplyPreviewResult;
  columnSamples: Record<string, ColumnSample>;
  totalRows: number;
  detectedEncoding: string;
  fileName: string;
}

interface ColumnSample {
  nonEmptyCount: number;
  topValues: Array<{ value: string; count: number }>;
}
```

### サンプリング戦略

- `readFileInChunks` でストリーム読み込み（大容量対応）
- 最大 `MAX_SAMPLE_ROWS = 100_000` 行まで読む（52,623 行のソーラー顧客 CSV は全件読み込み）
- 列ごとに `Map<string, number>` で出現カウントを蓄積
- 読み込み完了後、上位 5 件を降順で返す
- 先頭 N 行固定ではなく全体から集計するため偏りが出にくい

### エラー処理

- ファイルなし → 400
- 読み込みエラー（不正フォーマット等）→ 500 + エラーメッセージ
- unresolved 0 件 → 正常レスポンス（`autoApplyResult.unresolvedColumns: []`）
- fail-open にしない: サンプル取得失敗時は `topValues: []` を返し、リクエスト全体は失敗させない

### XLSX サポート

`ingestFile` は CSV / XLSX 両対応。XLSX の場合も同じレスポンス形状を返す。ただし XLSX の encoding 検出は不要（Unicode 固定）。`detectedEncoding` は `'xlsx'` を返す。

### 実装場所

`src/ui/server.ts` — `POST /api/auto-apply-preview` の直後に追加。

```
app.post('/api/import-preview', upload.single('file'), async (req, res) => { ... })
```

`VALID_RESOLUTION_TYPES` Set に `'column_canonical'` を追加（`/api/decisions/resolutions` バリデーション）。

---

## 4. UI: `/import` ページ

### ルーティング

`app.js` のクライアントサイドルーター（`navigate()` / `popstate`）に `/import` を追加。`renderImportPage()` を呼び出す。

ダッシュボード（`renderDashboard()`）に「ファイルを取り込む」ボタンを追加し `/import` へ遷移。

### 4セクション構成（シングルページ展開）

```
Section 1: ファイルを選ぶ  ← 常時表示
Section 2: 判定結果        ← import-preview 完了後に展開
Section 3: 要確認 2ペイン  ← unresolved > 0 のとき展開（0 件でもセクション表示、空旨を表示）
Section 4: 完了サマリ      ← 全件処理後（保存 or スキップ）に展開
```

### Section 1: ファイルを選ぶ

- `<input type="file" accept=".csv,.xlsx">` + drag-and-drop ゾーン
- ファイル選択 → `POST /api/import-preview` を `FormData` で呼び出し
- ローディング表示中は Section 2 をスケルトン表示
- 「※ファイルは変更・保存されません（参照専用）」注釈

### Section 2: 判定結果

4 枚のカード:
- **ファイル種別**: `familyId` の日本語表示（例: 顧客マスタ）
- **自動で判定済み**: `appliedDecisions.length` 件（緑）
- **要確認**: `unresolvedColumns.length` 件（オレンジ）
- **総列数**: `appliedDecisions.length + unresolvedColumns.length`

ファイル名・エンコーディング・総行数を小文字で補足表示。

### Section 3: 要確認 2ペイン

**左ペイン（幅 210px）:**

- 上部: 「要確認 残り N 件」（保存・スキップのたびに更新）
- 各行: 列名 + 状態バッジ
  - `未確認` (default, グレー)
  - `保存済` (緑、保存したとき)
  - `スキップ` (グレー薄、スキップしたとき)
- 選択中の行は青ハイライト（`border-left: 3px solid #3b82f6`）
- クリックで右ペインを切り替える

**右ペイン（flex: 1）:**

- 列名（大、H3）
- 「値あり: N件（全M件中）」補足
- 「実際に入っている値（出現頻度 上位5件）」タグ群（各タグに件数表示）
- テキスト入力: 「この列の意味」（プレースホルダー: 例: 顧客の業種（詳細））
- 保存範囲ラジオ（黄背景カード）:
  - `今回のみ適用`（説明: 今回の判断はこのセッションだけに使用します）
  - `テンプレートとして保存`（説明: 次回以降、同じファイル種別で自動的に使用されます）
- ボタン行:
  - `[保存]` ボタン（primary）
  - `[スキップ]` ボタン（secondary）+ 「スキップ = 未対応のまま次へ進みます」注釈

### 保存動作

**「今回のみ適用」を選択して「保存」:**
- API 呼び出しなし
- 左ペインバッジを「保存済」に変更
- 「残り N 件」カウントダウン
- 次の未確認列を自動選択

**「テンプレートとして保存」を選択して「保存」:**
- `POST /api/decisions/resolutions` を呼び出す:

```json
{
  "resolution_id": "<uuid>",
  "resolution_type": "column_canonical",
  "context_key": "column:<source_col>",
  "family_id": "<autoApplyResult.familyId>",
  "decision": "<operator_input>",
  "decision_detail": { "canonical_field": "<operator_input>", "decided_via": "import_ui" },
  "certainty": "confirmed",
  "scope": "family",
  "decided_at": "<ISO8601>",
  "decided_by": "human",
  "auto_apply_condition": "always",
  "source_batch_ids": [],
  "notes": "<operator_input>"
}
```

- 成功後: 左ペインバッジを「保存済」に変更

**「スキップ」:**
- API 呼び出しなし
- 左ペインバッジを「スキップ」に変更
- 次の未確認列を自動選択

### Section 4: 完了サマリ

全 unresolved 列が「保存済」または「スキップ」になると展開。

4 枚カード:
- 自動判定済み（緑）
- テンプレートとして保存（青）
- 今回のみ適用（グレー）
- スキップ（未対応）（薄グレー）

「ダッシュボードに戻る」ボタン。

---

## 5. データフロー図

```
operator
  │
  ▼ ファイル選択
POST /api/import-preview
  │ multer → tempfile
  │ ingestFile(encoding=auto, previewRows=なし)
  │ readFileInChunks → 最大100k行を列ごとに頻度カウント
  │ runAutoApplyPreview(columns, ...)
  │
  ▼ ImportPreviewResponse
renderImportPage (Section 2+3 展開)
  │
  ▼ 「テンプレートとして保存」選択 → [保存]
POST /api/decisions/resolutions
  │ resolution_type: "column_canonical"
  │ resolution_memory.json に追記
  │
  ▼ 次回 runAutoApplyPreview 呼び出し時
  Step 4b: column_canonical レコードを参照 → 解決済みとして扱う
```

---

## 6. テスト方針

### 既存テストへの影響

`test/core/auto-apply-orchestrator.test.ts` — 既存 22 件のテストは変更なし。新たに以下を追加:

- `column_canonical` がメモリにある列は Step 4b で解決される
- `column_canonical` でも `shouldAutoApply` が false（certainty=low）なら解決されない

### 新規テスト: `test/ui/import-preview.test.ts`

- 正常: CSV アップロード → `autoApplyResult` + `columnSamples` が返る
- `columnSamples` の `topValues` は出現頻度降順 5 件
- `unresolved 0` 件でも正常レスポンス（`unresolvedColumns: []`）
- ファイルなし → 400
- `columnSamples` の `nonEmptyCount` は正しい（空値を除く）

---

## 7. 非対象（スコープ外）

- `templates.json` のランタイム自動更新
- run の作成・パイプライン実行
- 本番 DB 投入 / Supabase / pbg-operations-core
- run 履歴との紐付け
- role / 権限管理
- call_history 専用 UI
- 74 ファイル全体対応
