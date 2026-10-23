// Detect accidental script switches, not non-ASCII text in general. Accents,
// Greek maths, emoji, source code and requested languages remain valid.
const SCRIPTS = [
  [/\p{Script=Cyrillic}/u, /\b(ruso|rusa|rusos|rusas|russian|ucraniano|ukrainian|bulgaro|bulgarian|cirilico|cyrillic)\b/i],
  [/\p{Script=Han}/u, /\b(chino|china|chinese|mandarin|japones|japonesa|japanese|kanji|hanzi)\b/i],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, /\b(japones|japonesa|japanese|kana)\b/i],
  [/\p{Script=Hangul}/u, /\b(coreano|coreana|korean|hangul)\b/i],
  [/\p{Script=Arabic}/u, /\b(arabe|arabic|persa|persian|urdu)\b/i],
  [/\p{Script=Hebrew}/u, /\b(hebreo|hebrea|hebrew)\b/i],
  [/\p{Script=Devanagari}/u, /\b(hindi|sanscrito|sanskrit|marathi|nepali)\b/i],
  [/\p{Script=Thai}/u, /\b(tailandes|tailandesa|thai)\b/i]
];

// Keep these spans byte-for-byte during model-assisted repair as well.
export function protectedTextSpans(text) {
  return String(text || '').match(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|\$\$[\s\S]*?(?:\$\$|$)|\$[^$\n]+\$|\\\[[\s\S]*?(?:\\\]|$)|\\\([\s\S]*?(?:\\\)|$)|https?:\/\/[^\s<>]+/g) || [];
}

function prose(text) {
  let value = String(text || '');
  for (const span of protectedTextSpans(value)) value = value.replace(span, ' ');
  return value;
}

export function textQualityIssues(text, context = '') {
  const value = prose(text);
  const issues = [];
  const languageContext = String(context).normalize('NFD').replace(/\p{Mark}/gu, '');
  if (/\uFFFD|Ã[\u0080-\u00BF]|Â[\u0080-\u00BF]|â[€\u0080-\u00BF]|ðŸ/.test(value)) issues.push('damaged UTF-8 text');
  for (const [script, language] of SCRIPTS) {
    if (script.test(value) && !script.test(context) && !language.test(languageContext)) {
      issues.push('unexpected writing system: ' + (value.match(new RegExp(script.source + '+', 'u')) || [''])[0]);
    }
  }
  return issues;
}

export const TEXT_QUALITY_PROMPT = 'Write consistently in the language requested by the student (Spanish by default). Check all prose, titles, questions, options and explanations before sending: never insert accidental words or fragments in another language or damaged UTF-8 characters. Preserve accents, mathematical notation, code, proper names and foreign-language examples when relevant to the requested subject. Do not copy language corruption from earlier assistant messages. Never write your reasoning, plans, drafts or self-checks in the answer (no "Wait,", "Let me…", "Also ensure…"): think before you write, and write only what the student should read.';
