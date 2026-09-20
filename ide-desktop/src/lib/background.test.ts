import { describe, expect, it } from 'vitest';
import { BACKGROUND_DEFAULTS, describeBackgroundControls, normalizeBlur, normalizeDim, normalizeScope } from './backgroundPrefs';

/*
 * 外观 → 背景 controls.
 *
 * The bug these pin: the pick button's label and the 移除 button were keyed off
 * the `backgroundImage` PREFERENCE, while the image itself lives in
 * userData/backgrounds owned by the main process. The two drift apart — the
 * preference survives a cleared userData directory, a failed copy, or a manual
 * delete, and turning the switch on does not pick a file. The UI then promised
 * 更换图片… with nothing to replace, and the enabled-but-empty case rendered a
 * background-less app with no hint why.
 */

describe('describeBackgroundControls', () => {
  it('offers 选择 while the stored state is still unknown', () => {
    // null = the main process has not answered yet. Offering 更换 before then
    // would be the same lie in a smaller window.
    const unknown = describeBackgroundControls(null, false);
    expect(unknown.pickLabel).toBe('选择图片…');
    expect(unknown.showRemove).toBe(false);
    expect(unknown.showEmptyHint).toBe(false);
  });

  it('offers 选择 and no 移除 when nothing is stored', () => {
    const none = describeBackgroundControls(false, false);
    expect(none.pickLabel).toBe('选择图片…');
    expect(none.showRemove).toBe(false);
    expect(none.showEmptyHint).toBe(false);
  });

  it('offers 更换 and 移除 once an image is stored', () => {
    const has = describeBackgroundControls(true, true);
    expect(has.pickLabel).toBe('更换图片…');
    expect(has.showRemove).toBe(true);
    expect(has.showEmptyHint).toBe(false);
  });

  it('offers 更换 even when the switch is off, as long as a file exists', () => {
    // Switch off + file present is a real state: the user kept the image and
    // only disabled it. The file is still there to replace or remove.
    const disabled = describeBackgroundControls(true, false);
    expect(disabled.pickLabel).toBe('更换图片…');
    expect(disabled.showRemove).toBe(true);
    expect(disabled.showEmptyHint).toBe(false);
  });

  it('explains the missing image when the switch is on but nothing is stored', () => {
    // The reported case: enabled, no file, no image on screen, no explanation.
    const enabledEmpty = describeBackgroundControls(false, true);
    expect(enabledEmpty.showEmptyHint).toBe(true);
    expect(enabledEmpty.pickLabel).toBe('选择图片…');
    expect(enabledEmpty.showRemove).toBe(false);
  });
});

describe('background preference normalizers', () => {
  it('clamps dim into a range that keeps the image visible', () => {
    expect(normalizeDim(0.45)).toBe(0.45);
    expect(normalizeDim(-1)).toBe(0);
    expect(normalizeDim(5)).toBe(0.9);
    expect(normalizeDim('x')).toBe(BACKGROUND_DEFAULTS.dim);
    expect(normalizeDim(Number.NaN)).toBe(BACKGROUND_DEFAULTS.dim);
  });

  it('rounds and clamps blur to a bounded pixel radius', () => {
    expect(normalizeBlur(0)).toBe(0);
    expect(normalizeBlur(12.6)).toBe(13);
    expect(normalizeBlur(-4)).toBe(0);
    expect(normalizeBlur(999)).toBe(40);
    expect(normalizeBlur(undefined)).toBe(BACKGROUND_DEFAULTS.blur);
  });

  it('accepts only the two known scopes', () => {
    expect(normalizeScope('app')).toBe('app');
    expect(normalizeScope('chat')).toBe('chat');
    expect(normalizeScope('everything')).toBe('chat');
    expect(normalizeScope(undefined)).toBe(BACKGROUND_DEFAULTS.scope);
  });
});
