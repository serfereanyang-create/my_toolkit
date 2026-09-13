/**
 * Keyboard shortcut model (iteration 19): the canonical action list, chord
 * parsing/serialisation, event matching and conflict detection. Both the
 * rebinding UI and App's global dispatcher consume this; the main process
 * only persists user overrides keyed by action id.
 */

export type Chord = { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; key: string };

export type ShortcutAction = {
  id: string;
  /** Chinese label for the settings page. */
  label: string;
  group: '常规' | '聊天' | '面板';
  /** Default chord in serialized form, e.g. "Ctrl+Shift+P". */
  default: string;
};

/** All rebindable GLOBAL shortcuts. Editor-internal keys live in Monaco and
 *  are intentionally excluded — rebinding those would desync addCommand(). */
export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: 'palette', label: '命令面板（模糊搜索所有命令）', group: '常规', default: 'Ctrl+Shift+P' },
  { id: 'quick-open', label: '快速打开文件（模糊查找）', group: '常规', default: 'Ctrl+P' },
  { id: 'search-workspace', label: '工作区全文搜索', group: '常规', default: 'Ctrl+Shift+F' },
  { id: 'bookmarks-view', label: '书签总览', group: '常规', default: 'Ctrl+Shift+B' },
  { id: 'settings', label: '打开设置', group: '常规', default: 'Ctrl+,' },
  { id: 'toggle-terminal', label: '底部终端', group: '常规', default: 'Ctrl+T' },
  { id: 'new-chat', label: '新建聊天', group: '常规', default: 'Ctrl+N' },
  { id: 'workspace-tools', label: '工作区工具面板', group: '常规', default: 'Ctrl+Alt+W' },
  { id: 'toggle-details', label: '展开/折叠全部步骤详情', group: '聊天', default: 'Ctrl+O' },
  { id: 'side-chat', label: '侧边聊天', group: '面板', default: 'Ctrl+Alt+S' },
  { id: 'browser', label: '浏览器面板', group: '面板', default: 'Ctrl+Alt+B' },
];

/** Case-insensitive lookup of a default action by id. */
export function findAction(id: string): ShortcutAction | undefined {
  return SHORTCUT_ACTIONS.find((a) => a.id === id);
}

/** Normalize a KeyboardEvent.key to canonical chord-key form: 'a', 'comma',
 *  'f5', 'enter', 'arrowdown', 'space'. Single printable chars lowercased. */
export function normalizeKey(raw: string): string {
  const k = String(raw ?? '');
  const special: Record<string, string> = {
    ' ': 'space', ',': 'comma', '.': 'period', '/': 'slash', '\\': 'backslash',
    ';': 'semicolon', "'": 'quote', '[': 'lbracket', ']': 'rbracket', '`': 'backquote',
    '-': 'minus', '=': 'equal',
  };
  if (special[k]) return special[k];
  if (k.length === 1) return k.toLowerCase();
  return k.toLowerCase();
}

const KEY_DISPLAY: Record<string, string> = {
  comma: ',', period: '.', slash: '/', backslash: '\\', semicolon: ';', quote: "'",
  lbracket: '[', rbracket: ']', backquote: '`', minus: '-', equal: '=', space: 'Space',
  arrowdown: '↓', arrowup: '↑', arrowleft: '←', arrowright: '→', escape: 'Esc',
  enter: 'Enter', tab: 'Tab', backspace: '⌫',
};

/** Parse "Ctrl+Shift+P" / "⌘, "-tolerant into a chord; null when invalid.
 *  Bare special keys (Enter, Esc, F5) are valid with no modifiers only for
 *  non-global contexts, but parsing accepts any well-formed shape and the
 *  safety rules live in `validateChord`. */
export function parseChord(serialized: string): Chord | null {
  let text = String(serialized ?? '').trim();
  if (!text) return null;
  // A key may itself be "+": only "X++" (a modifier then the plus key) has
  // the final '+' as the key character, not a dangling separator.
  let plusKey = false;
  if (text.endsWith('++')) {
    plusKey = true;
    text = text.slice(0, -1);
  }
  let ctrl = false, shift = false, alt = false, meta = false;
  const parts = text.split('+');
  const keyParts: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const low = p.trim().toLowerCase();
    if ((low === 'ctrl' || low === 'control' || low === '⌃') && i < parts.length - 1) { ctrl = true; continue; }
    if ((low === 'shift' || low === '⇧') && i < parts.length - 1) { shift = true; continue; }
    if ((low === 'alt' || low === 'option' || low === '⌥') && i < parts.length - 1) { alt = true; continue; }
    if ((low === 'meta' || low === 'cmd' || low === 'command' || low === '⌘' || low === 'win') && i < parts.length - 1) { meta = true; continue; }
    keyParts.push(p.trim());
  }
  const key = plusKey ? '+' : keyParts.join('+').toLowerCase();
  if (!key) return null;
  const known = /^(f(?:[1-9]|1[0-9]|2[0-4])|space|enter|escape|esc|tab|backspace|delete|insert|home|end|pageup|pagedown|arrowup|arrowdown|arrowleft|arrowright|[a-z0-9.,;'"`/\\\[\]=+-])$/;
  if (!known.test(key)) return null;
  const canon = key === 'esc' ? 'escape' : normalizeKey(key);
  return { ctrl, shift, alt, meta, key: canon };
}

/** Serialize back to canonical display form, e.g. "Ctrl+Shift+P". */
export function serializeChord(chord: Chord): string {
  const mods: string[] = [];
  if (chord.ctrl) mods.push('Ctrl');
  if (chord.alt) mods.push('Alt');
  if (chord.shift) mods.push('Shift');
  if (chord.meta) mods.push('Meta');
  const key = KEY_DISPLAY[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return mods.length ? [...mods, key].join('+') : String(key);
}

/** Build a chord from a live KeyboardEvent (used by the rebinding capture UI). */
export function chordFromEvent(event: {
  key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean;
}): Chord | null {
  const raw = event.key;
  const bare = raw.toLowerCase();
  if (bare === 'control' || bare === 'shift' || bare === 'alt' || bare === 'meta') return null; // modifier-only press
  return {
    ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey,
    key: normalizeKey(raw),
  };
}

/** True when a KeyboardEvent matches a chord. Cmd counts as Ctrl (VS Code
 *  convention): a chord asking for ctrl matches ctrl or meta presses, and a
 *  bare meta chord only matches meta. */
export function chordMatches(event: {
  key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean;
}, chord: Chord): boolean {
  const ctrlHeld = chord.meta ? event.ctrlKey : (event.ctrlKey || event.metaKey);
  const metaHeld = chord.meta ? event.metaKey : false;
  return ctrlHeld === chord.ctrl
    && metaHeld === chord.meta
    && event.shiftKey === chord.shift
    && event.altKey === chord.alt
    && normalizeKey(event.key) === chord.key;
}

const RISKY_BARE = new Set(['escape', 'enter', 'tab', 'backspace', 'delete', 'space']);

/**
 * Safety rules for a user-entered chord in the global context:
 * - must include Ctrl or Alt as the base (never hijack plain typing),
 * - plain letter keys without Ctrl/Alt are rejected,
 * - function-key-only chords (F5..F12) are allowed,
 * - never allow chords that kill the app OS windowing (Ctrl+W/Ctrl+Q reserved).
 */
export function validateChord(chord: Chord): string | null {
  const isFKey = /^f(?:[1-9]|1[0-9]|2[0-4])$/.test(chord.key);
  if (isFKey && !chord.ctrl && !chord.alt && !chord.meta) return null;
  if (!chord.ctrl && !chord.alt && !chord.meta) {
    return RISKY_BARE.has(chord.key) ? '该按键会干扰正常输入，请配合 Ctrl/Alt 使用' : '全局快捷键必须包含 Ctrl 或 Alt';
  }
  if (chord.ctrl && !chord.alt && !chord.meta && (chord.key === 'w' || chord.key === 'q')) {
    return 'Ctrl+W / Ctrl+Q 被系统保留';
  }
  return null;
}

/**
 * Resolve the effective chord per action: user override when present AND
 * valid, else the default. Invalid overrides are dropped (they may predate
 * new safety rules).
 */
export function resolveBindings(overrides: Record<string, string>): Record<string, Chord> {
  const out: Record<string, Chord> = {};
  for (const action of SHORTCUT_ACTIONS) {
    const candidate = overrides[action.id];
    let chord = candidate ? parseChord(candidate) : null;
    if (chord && validateChord(chord)) chord = null;
    out[action.id] = chord ?? parseChord(action.default)!;
  }
  return out;
}

/** Map serialized chords to the action ids that use them; length>1 = conflict. */
export function findConflicts(bindings: Record<string, Chord>): Map<string, string[]> {
  const byChord = new Map<string, string[]>();
  for (const [id, chord] of Object.entries(bindings)) {
    const key = serializeChord(chord);
    const list = byChord.get(key) ?? [];
    list.push(id);
    byChord.set(key, list);
  }
  const conflicts = new Map<string, string[]>();
  for (const [key, ids] of byChord) if (ids.length > 1) conflicts.set(key, ids);
  return conflicts;
}

/**
 * Given an event and resolved bindings, return the action id that owns the
 * first matching chord (stable order = SHORTCUT_ACTIONS order).
 */
export function matchAction(event: {
  key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean;
}, bindings: Record<string, Chord>): string | null {
  for (const action of SHORTCUT_ACTIONS) {
    const chord = bindings[action.id];
    if (chord && chordMatches(event, chord)) return action.id;
  }
  return null;
}
