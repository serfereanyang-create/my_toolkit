import { describe, expect, it } from 'vitest';
import { CODE_FONT_SIZE_MAX, CODE_FONT_SIZE_MIN, clampCodeFontSize, clampUiFontSize, UI_FONT_SIZE_MAX, UI_FONT_SIZE_MIN } from './uiFontSize';

/*
 * The range is a guard rail, not a preference: the type scale is additive, so a
 * base outside it flattens the hierarchy (24px packs all ten steps into 20-25px)
 * or drops text below the readable floor (10px puts 41 elements at 6-9px).
 */
describe('clampUiFontSize', () => {
  it('keeps values inside the range untouched', () => {
    expect(clampUiFontSize(14)).toBe(14);
    expect(clampUiFontSize(UI_FONT_SIZE_MIN)).toBe(UI_FONT_SIZE_MIN);
    expect(clampUiFontSize(UI_FONT_SIZE_MAX)).toBe(UI_FONT_SIZE_MAX);
  });

  it('raises values below the floor and lowers values above the ceiling', () => {
    expect(clampUiFontSize(10)).toBe(UI_FONT_SIZE_MIN);
    expect(clampUiFontSize(6)).toBe(UI_FONT_SIZE_MIN);
    expect(clampUiFontSize(40)).toBe(UI_FONT_SIZE_MAX);
  });

  it('rounds fractional sizes', () => {
    expect(clampUiFontSize(13.4)).toBe(13);
    expect(clampUiFontSize(13.6)).toBe(14);
  });

  it('accepts the string form that comes back from settings', () => {
    expect(clampUiFontSize('16')).toBe(16);
    expect(clampUiFontSize('8')).toBe(UI_FONT_SIZE_MIN);
  });

  it('returns undefined for absent or unusable values so the default applies', () => {
    expect(clampUiFontSize(undefined)).toBeUndefined();
    expect(clampUiFontSize(null)).toBeUndefined();
    expect(clampUiFontSize('')).toBeUndefined();
    expect(clampUiFontSize('large')).toBeUndefined();
    expect(clampUiFontSize(Number.NaN)).toBeUndefined();
    expect(clampUiFontSize(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  /*
   * `0` must not become 12. It is a corrupt setting, not a small one: clamping it
   * would render 12px and silently present that as the user's choice, while the
   * old build showed the default 14. undefined sends the caller back to the
   * stylesheet default instead. `Number(false)` and `Number([])` are also 0.
   */
  it('treats non-positive values as unusable rather than clamping them up', () => {
    expect(clampUiFontSize(0)).toBeUndefined();
    expect(clampUiFontSize('0')).toBeUndefined();
    expect(clampUiFontSize(false)).toBeUndefined();
    expect(clampUiFontSize([])).toBeUndefined();
    expect(clampUiFontSize(-4)).toBeUndefined();
    // Number(true) is 1 — positive, so it is merely below the floor.
    expect(clampUiFontSize(true)).toBe(UI_FONT_SIZE_MIN);
    expect(clampUiFontSize('14')).toBe(14);
  });
});

/*
 * --fs-code is the one type token App.tsx writes as an absolute px value, which
 * replaces the `max(var(--fs-floor), …)` guard inside the token instead of
 * feeding it. The floor therefore has to live at the write path; without it the
 * 代码字体大小 field's 8px minimum rendered the editor and every fenced block at
 * 8px.
 */
describe('clampCodeFontSize', () => {
  it('gives the size every out-of-range value ends up rendering at', () => {
    // 8 is what the old field allowed; 10 is --fs-floor.
    expect(clampCodeFontSize(8)).toBe(CODE_FONT_SIZE_MIN);
    expect(clampCodeFontSize(CODE_FONT_SIZE_MIN)).toBe(10);
    expect(clampCodeFontSize(13)).toBe(13);
    expect(clampCodeFontSize(CODE_FONT_SIZE_MAX)).toBe(24);
    expect(clampCodeFontSize(40)).toBe(CODE_FONT_SIZE_MAX);
  });

  it('leaves every value inside 10-24 alone, so no existing preference changes size', () => {
    for (let size = CODE_FONT_SIZE_MIN; size <= CODE_FONT_SIZE_MAX; size += 1) {
      expect(clampCodeFontSize(size)).toBe(size);
    }
  });

  it('reads the string form that comes back from settings.json', () => {
    expect(clampCodeFontSize('15')).toBe(15);
    expect(clampCodeFontSize('8')).toBe(CODE_FONT_SIZE_MIN);
    expect(clampCodeFontSize('30')).toBe(CODE_FONT_SIZE_MAX);
  });

  it('rounds fractional sizes and rejects unusable ones', () => {
    expect(clampCodeFontSize(13.4)).toBe(13);
    expect(clampCodeFontSize(13.6)).toBe(14);
    expect(clampCodeFontSize(undefined)).toBeUndefined();
    expect(clampCodeFontSize(null)).toBeUndefined();
    expect(clampCodeFontSize('')).toBeUndefined();
    expect(clampCodeFontSize('large')).toBeUndefined();
    expect(clampCodeFontSize(Number.NaN)).toBeUndefined();
  });

  it('treats non-positive values as unusable, exactly like the UI clamp', () => {
    expect(clampCodeFontSize(0)).toBeUndefined();
    expect(clampCodeFontSize('0')).toBeUndefined();
    expect(clampCodeFontSize(false)).toBeUndefined();
    expect(clampCodeFontSize([])).toBeUndefined();
    expect(clampCodeFontSize(-8)).toBeUndefined();
    expect(clampCodeFontSize(true)).toBe(CODE_FONT_SIZE_MIN);
    expect(clampCodeFontSize('14')).toBe(14);
  });
});
