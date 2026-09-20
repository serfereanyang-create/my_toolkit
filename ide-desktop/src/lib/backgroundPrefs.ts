/*
 * Custom background image (外观 → 背景) — the parts with no Electron dependency.
 *
 * Kept separate from `background.ts` so they can be unit tested without a
 * preload bridge: `background.ts` imports `desktop` from `./ipc`, which reads
 * `window.zcodeDesktop` at module load and therefore cannot be imported in a
 * plain Node test. The controls decision lives here because that is where the
 * bug was — the pick/remove labels were derived from the wrong state.
 */

export type BackgroundScope = 'app' | 'chat';

export const BACKGROUND_DEFAULTS = {
  dim: 0.45,
  blur: 0,
  scope: 'chat' as BackgroundScope,
};

/** Clamp dim to a range that always leaves the image visible. */
export function normalizeDim(value: unknown): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : BACKGROUND_DEFAULTS.dim;
  return Math.min(0.9, Math.max(0, num));
}

/** Blur in px. Capped so the image stays recognisable and the GPU work bounded. */
export function normalizeBlur(value: unknown): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : BACKGROUND_DEFAULTS.blur;
  return Math.min(40, Math.max(0, Math.round(num)));
}

export function normalizeScope(value: unknown): BackgroundScope {
  return value === 'app' ? 'app' : 'chat';
}

/**
 * What the 背景图片 row should offer, given what is actually stored.
 *
 * `stored` is null until the main process has answered, and the controls must
 * not guess in the meantime: claiming 更换 before the probe returns would offer
 * a replacement for an image that may not exist.
 *
 * The two states worth distinguishing are driven by the FILE, not the switch —
 * the `backgroundImage` preference and the stored image drift apart (the
 * preference survives a cleared userData directory, a failed copy, or a manual
 * delete, and turning the switch on does not pick a file). Keying the label off
 * the switch promised a 更换 with nothing to replace.
 *
 * `enabled && stored === false` is the state worth telling the user about: the
 * switch is on, nothing is stored, and nothing on screen explains the missing
 * image.
 */
export function describeBackgroundControls(
  stored: boolean | null,
  enabled: boolean,
): { pickLabel: string; showRemove: boolean; showEmptyHint: boolean } {
  return {
    pickLabel: stored ? '更换图片…' : '选择图片…',
    showRemove: stored === true,
    showEmptyHint: enabled && stored === false,
  };
}
