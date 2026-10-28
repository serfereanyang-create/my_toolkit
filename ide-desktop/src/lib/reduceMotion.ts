/**
 * reduceMotion.ts — JS 侧"减少动态效果"的判定入口。
 *
 * CSS 侧的口径在 src/styles.css（两条全局规则）：
 *   html[data-reduce-motion='on'] * { animation-duration: .01ms !important; … }
 *   @media (prefers-reduced-motion: reduce) { html:not([data-reduce-motion='off']) * { … } }
 * 即：显式 on 强制减动效；显式 off 压过系统偏好；其余跟随 OS。
 *
 * CSS 管不到 `scrollTo({ behavior: 'smooth' })` 这类显式平滑滚动，所以那几个
 * 调用点统一走 scrollBehavior()，与上面两条规则读同一组来源，不另设开关。
 */

const ATTR = 'data-reduce-motion';

export function prefersReducedMotion(): boolean {
  if (typeof document === 'undefined') return false;
  const forced = document.documentElement.getAttribute(ATTR);
  if (forced === 'on') return true;
  if (forced === 'off') return false;
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** scrollTo / scrollIntoView 的 behavior：减动效时退回瞬时滚动。 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
