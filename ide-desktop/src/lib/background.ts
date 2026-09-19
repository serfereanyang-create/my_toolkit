import { desktop } from './ipc';

/*
 * Custom background image (外观 → 背景).
 *
 * The bytes live in the app's userData directory, owned by the main process
 * (see appearance.* in electron/ipc.cjs); the renderer only ever receives a
 * data URL. Preferences therefore store the *controls* — enabled, dim, blur,
 * scope, and a version stamp — never the image or a path to it.
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
 * Apply the background to <html>. Passing `null` clears every custom property
 * and attribute so the UI returns exactly to its default appearance.
 */
export function applyBackground(options: {
  dataUrl: string | null;
  dim: number;
  blur: number;
  scope: BackgroundScope;
}) {
  const root = document.documentElement;
  if (!options.dataUrl) {
    root.removeAttribute('data-bg-image');
    root.removeAttribute('data-bg-scope');
    root.style.removeProperty('--bg-image');
    root.style.removeProperty('--bg-dim');
    root.style.removeProperty('--bg-blur');
    root.style.removeProperty('--bg-blur-scale');
    return;
  }
  // Blur samples outside the element, leaving a soft translucent edge; scaling
  // up by slightly more than the blur radius pushes that fringe off-screen.
  const scale = options.blur > 0 ? 1 + options.blur / 200 : 1;
  root.style.setProperty('--bg-image', `url("${options.dataUrl}")`);
  root.style.setProperty('--bg-dim', String(options.dim));
  root.style.setProperty('--bg-blur', `${options.blur}px`);
  root.style.setProperty('--bg-blur-scale', String(scale));
  root.setAttribute('data-bg-image', 'true');
  root.setAttribute('data-bg-scope', options.scope);
}

/** Read the stored image, or null when none has been chosen. */
export async function readBackground(): Promise<string | null> {
  const result = await desktop.appearance.readBackground();
  return result.ok && result.dataUrl ? result.dataUrl : null;
}

/**
 * Open the file picker and store the chosen image.
 * Returns the new version stamp so callers can persist it and trigger a reload.
 */
export async function pickBackground(): Promise<
  { ok: true; version: number } | { ok: false; canceled?: boolean; error?: string }
> {
  const result = await desktop.appearance.pickBackground();
  if (!result.ok) return { ok: false, canceled: result.canceled, error: result.error };
  return { ok: true, version: result.version ?? Date.now() };
}

export async function clearBackground(): Promise<void> {
  await desktop.appearance.clearBackground();
}
