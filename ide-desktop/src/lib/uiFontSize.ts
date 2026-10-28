/*
 * Bounds for the interface font size.
 *
 * The scale in styles.css is ten additive steps around --fs-base, so an
 * out-of-range base does not merely look wrong — it removes the hierarchy. At
 * 24px every tier landed between 20 and 25px (measured on the real UI), and at
 * 10px forty-one text elements rendered between 6 and 9px. The field below and
 * App.tsx both go through this, because a value written by an older build or
 * edited into settings.json by hand never passed through the field.
 */
export const UI_FONT_SIZE_MIN = 12;
export const UI_FONT_SIZE_MAX = 20;

/** The stylesheet's --fs-base, so the settings field can show what is actually
 *  in effect when no preference has been written yet. */
export const UI_FONT_SIZE_DEFAULT = 14;

/** Returns undefined when the preference is absent or unusable, so the caller
 *  falls back to the stylesheet default rather than writing a guess. Non-positive
 *  values count as unusable: 0 is not a chosen size, and letting it through would
 *  render as 12 and claim the user had picked 12. */
export function clampUiFontSize(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.min(UI_FONT_SIZE_MAX, Math.max(UI_FONT_SIZE_MIN, Math.round(numeric)));
}

/*
 * Bounds for the code font size.
 *
 * Same floor as the stylesheet's --fs-floor: 代码字体大小 writes --fs-code as an
 * absolute px value, which replaces the whole `max(var(--fs-floor), …)`
 * expression inside the token, so the token's own guard never applies once a
 * preference exists. 12 was the field's old minimum and the Terminal's default;
 * 10 is where the transcript's code surfaces stop being readable, and 24 is
 * where a fenced block starts crowding out the prose around it (the editor and
 * the terminal both hold their line height, so it is a density limit, not a
 * legibility one).
 */
export const CODE_FONT_SIZE_MIN = 10;
export const CODE_FONT_SIZE_MAX = 24;

/** Returns undefined when the preference is absent or unusable, so the caller
 *  keeps its own fallback (12 in the settings field, 13 in the editor). Same
 *  non-positive rule as its sibling above. */
export function clampCodeFontSize(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.min(CODE_FONT_SIZE_MAX, Math.max(CODE_FONT_SIZE_MIN, Math.round(numeric)));
}
