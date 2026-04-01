/**
 * File Profile — ファイル種別定義の型
 *
 * 各ファイルの「これは何の一覧か」「列は何番目に何が入るか」を定義する。
 * 位置ベース列マッピングを正とし、ヘッダー名ベースは補助。
 */

/** 列の定義 */
export interface ColumnDef {
  /** 0-based の列位置 */
  position: number;
  /** 日本語ラベル（UIに表示する名前） */
  label: string;
  /** 内部キー名（正規化・マッピング用） */
  key: string;
  /** この列が必須か */
  required: boolean;
  /** 入力規則の簡易説明（任意） */
  rule?: string;
  /** ヘッダー名のヒント（補助マッチング用） */
  headerHints?: string[];
}

/** 列レビュー時の現場回答 */
export interface ColumnReviewEntry {
  position: number;
  label: string;
  key: string;
  /** この列は何を入れる場所か（現場の回答） */
  meaning: string;
  /** 今も使うか */
  inUse: 'yes' | 'no' | 'unknown';
  /** 必須か */
  required: 'yes' | 'no' | 'unknown';
  /** 入力ルール（自由記述） */
  rule: string;
}

/** ファイルプロファイル */
export interface FileProfile {
  /** 一意の識別子 */
  id: string;
  /** 日本語ラベル（「顧客一覧」など） */
  label: string;
  /** ファイル名マッチング用ヒント（glob-like パターン） */
  filenameHints: string[];
  /** 既定の文字コード */
  defaultEncoding: 'cp932' | 'utf8' | 'auto';
  /** 既定のヘッダー有無 */
  defaultHasHeader: boolean;
  /** 位置ベース列定義 */
  columns: ColumnDef[];
  /** プレビューで見せる主要列の position */
  previewColumns: number[];
  /** カテゴリ（管理用） */
  category: string;
  /** 仮置きフラグ — true なら seed データで未確認 */
  provisional: boolean;
}

/** プロファイルマッチ結果 */
export interface ProfileMatchResult {
  /** マッチしたプロファイル（null なら新規） */
  profile: FileProfile | null;
  /** マッチの信頼度 */
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** マッチ理由 */
  reason: string;
  /** 他の候補（スコア順） */
  alternatives: Array<{ profile: FileProfile; confidence: 'high' | 'medium' | 'low'; reason: string }>;
}

/** アップロード確認時に送る情報 */
export interface UploadConfirmation {
  /** ファイル名 */
  filename: string;
  /** 検出した情報 */
  diagnosis: {
    detectedEncoding: string;
    appliedEncoding: string;
    headerApplied: boolean;
    format: string;
  };
  /** プレビュー行（先頭数行） */
  previewRows: Record<string, string>[];
  /** 検出した列名 */
  columns: string[];
  /** プロファイルマッチ結果 */
  profileMatch: ProfileMatchResult;
}
