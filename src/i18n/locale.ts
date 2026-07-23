export type Locale = 'zh' | 'en';

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function detectLocale(text: string | undefined | null): Locale {
  if (!text) return 'en';
  const sample = text.slice(0, 4000);
  const cjk = sample.match(new RegExp(CJK_RE.source, 'g'))?.length ?? 0;
  // Prefer Chinese when there is any meaningful CJK (users often mix path + 中文).
  if (cjk >= 1) return 'zh';
  return 'en';
}

/**
 * Sticky locale for a session/turn chain.
 * - Any CJK in current text switches to zh and sticks.
 * - Short continuations like "继续"/"ok" keep previous locale.
 * - Explicit long English without CJK can switch back to en.
 */
export function resolveSessionLocale(options: {
  text?: string | null;
  previous?: Locale;
}): Locale {
  const text = options.text ?? '';
  const detected = detectLocale(text);
  if (detected === 'zh') return 'zh';
  if (!options.previous) return detected;
  const trimmed = text.trim();
  // Keep sticky language for short follow-ups.
  if (trimmed.length > 0 && trimmed.length <= 12) return options.previous;
  // Pure ASCII longer prompts may switch to en.
  if (trimmed.length >= 24 && detected === 'en') return 'en';
  return options.previous;
}

export function isChineseLocale(locale: Locale | undefined) {
  return locale === 'zh';
}
