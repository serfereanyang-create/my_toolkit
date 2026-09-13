/**
 * Persistent composer input history (Codex CLI history.json design):
 * dedupe + cap, most-recent-last, recall with ArrowUp/ArrowDown.
 * Stored in localStorage so it survives app restarts without an IPC round-trip.
 */

const STORAGE_KEY = 'yoycode.inputHistory.v1';
export const INPUT_HISTORY_LIMIT = 200;

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

// node-environment (vitest) has no localStorage; fall back to an in-memory map
// so the module stays unit-testable and renderer code never crashes.
const memoryStore = new Map<string, string>();
const fallbackStorage: StorageLike = {
  getItem: (key) => memoryStore.get(key) ?? null,
  setItem: (key, value) => { memoryStore.set(key, value); },
};

function storage(): StorageLike {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Electron sandbox edge cases: treat as unavailable.
  }
  return fallbackStorage;
}

export function normalizeHistoryEntry(text: string): string {
  const singleLine = text.replace(/\r/g, '').replace(/\n/g, ' ').trim();
  if (!singleLine) return '';
  return singleLine.length > 400 ? `${singleLine.slice(0, 399)}…` : singleLine;
}

export function loadInputHistory(): string[] {
  try {
    const raw = storage().getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

/** Append (dedupe move-to-newest, cap). Returns the updated list. */
export function pushInputHistory(text: string): string[] {
  const entry = normalizeHistoryEntry(text);
  if (!entry) return loadInputHistory();
  const entries = loadInputHistory().filter((item) => item !== entry);
  entries.push(entry);
  while (entries.length > INPUT_HISTORY_LIMIT) entries.shift();
  try {
    storage().setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota/serialization failures must never break sending
  }
  return entries;
}

/** Test-only helper: wipe persisted history so cases stay independent. */
export function clearInputHistory(): void {
  try {
    storage().setItem(STORAGE_KEY, JSON.stringify([]));
  } catch {
    // ignore
  }
}
