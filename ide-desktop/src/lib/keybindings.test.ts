import { describe, expect, it } from 'vitest';
import {
  parseChord, serializeChord, chordMatches, chordFromEvent, validateChord,
  resolveBindings, findConflicts, matchAction, normalizeKey, SHORTCUT_ACTIONS,
} from './keybindings';

describe('normalizeKey', () => {
  it('maps printable chars to lowercase and specials to names', () => {
    expect(normalizeKey('A')).toBe('a');
    expect(normalizeKey(' ')).toBe('space');
    expect(normalizeKey(',')).toBe('comma');
    expect(normalizeKey('ArrowDown')).toBe('arrowdown');
  });
});

describe('parseChord / serializeChord roundtrip', () => {
  for (const text of ['Ctrl+Shift+P', 'Ctrl+P', 'Ctrl+,', 'Ctrl+Alt+W', 'Ctrl+T', 'Shift+Ctrl+P']) {
    it(`roundtrips ${text}`, () => {
      const chord = parseChord(text);
      expect(chord).not.toBeNull();
      // serialise reorders modifiers, so compare via parse of serialise
      expect(parseChord(serializeChord(chord!))).toEqual(chord);
    });
  }

  it('parses ctrl/shift flags irrespective of order', () => {
    const a = parseChord('Ctrl+Shift+P');
    const b = parseChord('Shift+Ctrl+P');
    expect(a).toEqual(b);
  });

  it('treats literal plus key: Ctrl++', () => {
    const chord = parseChord('Ctrl++');
    expect(chord).toEqual({ ctrl: true, shift: false, alt: false, meta: false, key: '+' });
  });

  it('rejects garbage and empty', () => {
    expect(parseChord('')).toBeNull();
    expect(parseChord('Ctrl+')).toBeNull();
    expect(parseChord('Ctrl+NotAKey')).toBeNull();
    expect(parseChord('Ctrl+Shift')).toBeNull();
  });

  it('accepts bare F-keys', () => {
    expect(parseChord('F7')?.key).toBe('f7');
  });

  it('normalises esc to escape', () => {
    expect(parseChord('Escape')?.key).toBe('escape');
    expect(parseChord('Esc')?.key).toBe('escape');
  });
});

describe('validateChord', () => {
  it('requires a base modifier for ordinary keys', () => {
    expect(validateChord({ ctrl: false, shift: false, alt: false, meta: false, key: 'a' }))
      .toMatch(/Ctrl|Alt/);
    expect(validateChord({ ctrl: false, shift: true, alt: false, meta: false, key: 'a' }))
      .toMatch(/Ctrl|Alt/);
  });
  it('allows function keys alone', () => {
    expect(validateChord({ ctrl: false, shift: false, alt: false, meta: false, key: 'f5' })).toBeNull();
  });
  it('reserves Ctrl+W and Ctrl+Q', () => {
    expect(validateChord({ ctrl: true, shift: false, alt: false, meta: false, key: 'w' })).toMatch(/保留/);
    expect(validateChord({ ctrl: true, shift: false, alt: false, meta: false, key: 'q' })).toMatch(/保留/);
  });
  it('permits normal chords', () => {
    expect(validateChord(parseChord('Ctrl+Shift+P')!)).toBeNull();
    expect(validateChord(parseChord('Ctrl+Alt+S')!)).toBeNull();
  });
});

describe('chordMatches / chordFromEvent', () => {
  const ev = (key: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) => ({
    key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta,
  });
  it('matches exact modifier combination', () => {
    const chord = parseChord('Ctrl+Shift+P')!;
    expect(chordMatches(ev('P', { ctrl: true, shift: true }), chord)).toBe(true);
    expect(chordMatches(ev('p', { ctrl: true }), chord)).toBe(false); // missing shift
  });
  it('ignores modifier-only presses when building chords', () => {
    expect(chordFromEvent(ev('Control'))).toBeNull();
  });
  it('captures letters case-insensitively', () => {
    const chord = parseChord('Ctrl+P')!;
    expect(chordMatches(ev('P', { ctrl: true }), chord)).toBe(true);
  });
});

describe('resolveBindings', () => {
  it('uses defaults when no overrides', () => {
    const map = resolveBindings({});
    expect(map['palette']).toEqual(parseChord('Ctrl+Shift+P'));
  });
  it('applies valid overrides', () => {
    const map = resolveBindings({ 'toggle-terminal': 'Ctrl+Shift+`' });
    expect(serializeChord(map['toggle-terminal'])).toBe('Ctrl+Shift+`');
    expect(map['toggle-terminal']).toEqual(parseChord('Ctrl+Shift+`'));
  });
  it('drops invalid overrides', () => {
    const map = resolveBindings({ 'quick-open': 'A' }); // no modifier — rejected
    expect(map['quick-open']).toEqual(parseChord('Ctrl+P'));
  });
  it('covers every declared action', () => {
    const map = resolveBindings({});
    for (const a of SHORTCUT_ACTIONS) expect(map[a.id]).toBeTruthy();
  });
});

describe('findConflicts', () => {
  it('detects two actions sharing a chord', () => {
    const bindings = resolveBindings({ 'new-chat': 'Ctrl+T' }); // clash with toggle-terminal
    const conflicts = findConflicts(bindings);
    const ids = conflicts.get('Ctrl+T') ?? [];
    expect(ids.sort()).toEqual(['new-chat', 'toggle-terminal']);
  });
  it('no conflicts on defaults', () => {
    expect(findConflicts(resolveBindings({})).size).toBe(0);
  });
});

describe('matchAction', () => {
  it('returns the owner action id for a matching event', () => {
    const bindings = resolveBindings({});
    expect(matchAction({ key: 'P', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, bindings)).toBe('palette');
    expect(matchAction({ key: 'P', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }, bindings)).toBe('quick-open');
  });
  it('returns null when nothing matches', () => {
    const bindings = resolveBindings({});
    expect(matchAction({ key: 'x', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, bindings)).toBeNull();
  });
});
