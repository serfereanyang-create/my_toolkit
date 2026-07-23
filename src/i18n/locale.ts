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

export function isChineseLocale(locale: Locale | undefined) {
  return locale === 'zh';
}
