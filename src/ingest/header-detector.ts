// src/ingest/header-detector.ts

export interface HeaderEvidence {
  columnIndex: number;
  value: string;
  looksLikeData: boolean;
  reason: string; // "数字です", "電話番号のようです", "日付のようです", "メールアドレスのようです", "住所のようです"
}

export interface HeaderDetectionResult {
  isLikelyHeader: boolean;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
  evidence: HeaderEvidence[];
}

const PATTERNS: Array<{ regex: RegExp | RegExp[]; reason: string }> = [
  { regex: /^\d+$/, reason: '数字です' },
  {
    regex: [
      /^0\d{1,4}[-ー]?\d{1,4}[-ー]?\d{3,4}$/,
      /^\+81\d{9,11}$/,
    ],
    reason: '電話番号のようです',
  },
  { regex: /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/, reason: '日付のようです' },
  { regex: /^(令和|平成|昭和|大正|明治)\d/, reason: '日付のようです' },
  { regex: /^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+\.\d+$/, reason: '数字です' },
  { regex: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, reason: 'メールアドレスのようです' },
  {
    regex: /^(北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)/,
    reason: '住所のようです',
  },
];

function classifyCell(value: string): { looksLikeData: boolean; reason: string } {
  for (const { regex, reason } of PATTERNS) {
    const regexes = Array.isArray(regex) ? regex : [regex];
    if (regexes.some((r) => r.test(value))) {
      return { looksLikeData: true, reason };
    }
  }
  return { looksLikeData: false, reason: '' };
}

/**
 * Analyze the first row of a CSV file and determine if it looks like a header row.
 * Returns detailed evidence about each cell's classification.
 */
export function detectHeaderLikelihood(firstRow: string[]): HeaderDetectionResult {
  const evidence: HeaderEvidence[] = firstRow.map((value, columnIndex) => {
    const { looksLikeData, reason } = classifyCell(value);
    return { columnIndex, value, looksLikeData, reason };
  });

  // Empty cells are ignored for ratio calculation
  const nonEmptyCells = evidence.filter((e) => e.value !== '');
  const totalCells = nonEmptyCells.length;
  const dataCount = nonEmptyCells.filter((e) => e.looksLikeData).length;

  let isLikelyHeader: boolean;
  let confidence: 'high' | 'medium' | 'low';

  if (totalCells === 0) {
    // All cells empty
    isLikelyHeader = true;
    confidence = 'low';
  } else {
    const ratio = dataCount / totalCells;
    if (ratio > 0.6) {
      isLikelyHeader = false;
      confidence = 'high';
    } else if (ratio > 0.3) {
      isLikelyHeader = false;
      confidence = 'medium';
    } else if (ratio > 0.0) {
      isLikelyHeader = true;
      confidence = 'low';
    } else {
      // ratio === 0.0
      isLikelyHeader = true;
      confidence = 'high';
    }
  }

  const warnings: string[] = [];
  if (!isLikelyHeader && confidence === 'high') {
    warnings.push('1行目はデータのようです（項目名ではない可能性があります）');
  } else if (!isLikelyHeader && confidence === 'medium') {
    warnings.push('1行目にデータっぽい値が含まれています。項目名の行かどうか確認してください。');
  } else if (isLikelyHeader && confidence === 'low') {
    warnings.push('1行目の判定が難しいです。内容を確認してください。');
  }

  return { isLikelyHeader, confidence, warnings, evidence };
}
