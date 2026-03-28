/**
 * Text normalization utilities.
 * Handles full-width/half-width conversion, whitespace cleanup, trimming.
 */

/** Full-width ASCII → half-width ASCII (0xFF01-0xFF5E → 0x0021-0x007E). */
export function fullWidthToHalfWidth(s: string): string {
  return s.replace(/[\uFF01-\uFF5E]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0),
  );
}

/** Half-width katakana → full-width katakana mapping. */
const HW_KANA_MAP: Record<string, string> = {
  'ｦ': 'ヲ', 'ｧ': 'ァ', 'ｨ': 'ィ', 'ｩ': 'ゥ', 'ｪ': 'ェ', 'ｫ': 'ォ',
  'ｬ': 'ャ', 'ｭ': 'ュ', 'ｮ': 'ョ', 'ｯ': 'ッ', 'ｰ': 'ー',
  'ｱ': 'ア', 'ｲ': 'イ', 'ｳ': 'ウ', 'ｴ': 'エ', 'ｵ': 'オ',
  'ｶ': 'カ', 'ｷ': 'キ', 'ｸ': 'ク', 'ｹ': 'ケ', 'ｺ': 'コ',
  'ｻ': 'サ', 'ｼ': 'シ', 'ｽ': 'ス', 'ｾ': 'セ', 'ｿ': 'ソ',
  'ﾀ': 'タ', 'ﾁ': 'チ', 'ﾂ': 'ツ', 'ﾃ': 'テ', 'ﾄ': 'ト',
  'ﾅ': 'ナ', 'ﾆ': 'ニ', 'ﾇ': 'ヌ', 'ﾈ': 'ネ', 'ﾉ': 'ノ',
  'ﾊ': 'ハ', 'ﾋ': 'ヒ', 'ﾌ': 'フ', 'ﾍ': 'ヘ', 'ﾎ': 'ホ',
  'ﾏ': 'マ', 'ﾐ': 'ミ', 'ﾑ': 'ム', 'ﾒ': 'メ', 'ﾓ': 'モ',
  'ﾔ': 'ヤ', 'ﾕ': 'ユ', 'ﾖ': 'ヨ',
  'ﾗ': 'ラ', 'ﾘ': 'リ', 'ﾙ': 'ル', 'ﾚ': 'レ', 'ﾛ': 'ロ',
  'ﾜ': 'ワ', 'ﾝ': 'ン',
};

const DAKUTEN_MAP: Record<string, string> = {
  'カ': 'ガ', 'キ': 'ギ', 'ク': 'グ', 'ケ': 'ゲ', 'コ': 'ゴ',
  'サ': 'ザ', 'シ': 'ジ', 'ス': 'ズ', 'セ': 'ゼ', 'ソ': 'ゾ',
  'タ': 'ダ', 'チ': 'ヂ', 'ツ': 'ヅ', 'テ': 'デ', 'ト': 'ド',
  'ハ': 'バ', 'ヒ': 'ビ', 'フ': 'ブ', 'ヘ': 'ベ', 'ホ': 'ボ',
  'ウ': 'ヴ',
};

const HANDAKUTEN_MAP: Record<string, string> = {
  'ハ': 'パ', 'ヒ': 'ピ', 'フ': 'プ', 'ヘ': 'ペ', 'ホ': 'ポ',
};

/** Half-width katakana → full-width katakana (with dakuten/handakuten). */
export function halfWidthKanaToFullWidth(s: string): string {
  let result = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const fullKana = HW_KANA_MAP[ch];
    if (fullKana) {
      const next = s[i + 1];
      if (next === 'ﾞ' && DAKUTEN_MAP[fullKana]) {
        result += DAKUTEN_MAP[fullKana];
        i++;
      } else if (next === 'ﾟ' && HANDAKUTEN_MAP[fullKana]) {
        result += HANDAKUTEN_MAP[fullKana];
        i++;
      } else {
        result += fullKana;
      }
    } else if (ch === 'ﾞ' || ch === 'ﾟ') {
      // Standalone dakuten/handakuten that wasn't consumed
      result += ch;
    } else {
      result += ch;
    }
  }
  return result;
}

/** Normalize whitespace: collapse runs, strip control chars, trim. */
export function cleanWhitespace(s: string): string {
  return s
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\u3000/g, ' ')  // full-width space → half-width
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Full normalization pipeline for text fields. */
export function normalizeText(s: string): string {
  if (!s) return s;
  let v = s;
  v = fullWidthToHalfWidth(v);
  v = halfWidthKanaToFullWidth(v);
  v = cleanWhitespace(v);
  return v;
}
