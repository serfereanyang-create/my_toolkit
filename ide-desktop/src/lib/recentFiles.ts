/**
 * Iteration 13 — recently-opened files tracking.
 *
 * Pure storage layer over localStorage, keyed per workspace root so switching
 * projects never bleeds a stale file list. The record shape keeps open-count
 * and last-opened timestamp so the rail can rank "files you actually work in"
 * (recency-decayed frequency) rather than a plain LRU.
 */

export type RecentFile = {
  /** Absolute path, normalized to forward slashes for stable keys. */
  path: string;
  lastOpenedAt: number;  // ms epoch
  opens: number;
  /** Last size in bytes if known (used for the subtle size hint). */
  size?: number;
};

const STORAGE_PREFIX = 'zcode.recent:';
const MAX_RECENT = 30;

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

function storageKey(workspaceRoot: string): string {
  return STORAGE_PREFIX + normalizePath(workspaceRoot).toLowerCase();
}

/** Read + parse a workspace's recent list defensively. */
export function loadRecent(workspaceRoot: string): RecentFile[] {
  if (!workspaceRoot) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(workspaceRoot)) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry): entry is RecentFile => (
        entry && typeof entry.path === 'string' && typeof entry.lastOpenedAt === 'number'
      ))
      .map((entry) => ({ path: normalizePath(entry.path), lastOpenedAt: entry.lastOpenedAt, opens: entry.opens ?? 1, size: entry.size }))
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/**
 * Record that `path` was opened. Returns the new list (also persisted).
 * Re-opening an existing entry refreshes its timestamp and bumps `opens`.
 */
export function touchRecent(workspaceRoot: string, path: string, size?: number): RecentFile[] {
  if (!workspaceRoot) return [];
  const norm = normalizePath(path);
  const list = loadRecent(workspaceRoot);
  const now = Date.now();
  const idx = list.findIndex((f) => f.path === norm);
  if (idx >= 0) {
    list[idx] = { ...list[idx], lastOpenedAt: now, opens: list[idx].opens + 1, size: size ?? list[idx].size };
    // Move to front for the "most recent first" display order.
    const [hit] = list.splice(idx, 1);
    list.unshift(hit);
  } else {
    list.unshift({ path: norm, lastOpenedAt: now, opens: 1, size });
  }
  const trimmed = list.slice(0, MAX_RECENT);
  try {
    localStorage.setItem(storageKey(workspaceRoot), JSON.stringify(trimmed));
  } catch {
    /* quota: keep the in-memory list anyway */
  }
  return trimmed;
}

/** Remove one path from recents (e.g. file deleted). */
export function forgetRecent(workspaceRoot: string, path: string): RecentFile[] {
  const norm = normalizePath(path);
  const kept = loadRecent(workspaceRoot).filter((f) => f.path !== norm);
  try {
    localStorage.setItem(storageKey(workspaceRoot), JSON.stringify(kept));
  } catch { /* ignore */ }
  return kept;
}

export function clearRecent(workspaceRoot: string): void {
  try {
    localStorage.removeItem(storageKey(workspaceRoot));
  } catch { /* ignore */ }
}

/**
 * Rank recents for display: exponential decay of open-count by age, half-life
 * 3 days. A file opened once an hour ago outranks one opened 50 times last
 * month — but not by much.
 */
export function rankRecent(list: RecentFile[], now = Date.now()): RecentFile[] {
  const HALF_LIFE_MS = 3 * 24 * 3600_000;
  const score = (f: RecentFile) => f.opens * Math.pow(2, -(now - f.lastOpenedAt) / HALF_LIFE_MS);
  return [...list].sort((a, b) => score(b) - score(a));
}

/** "a.ts · src/components" style label for the compact rail row. */
export function recentLabel(path: string): string {
  const norm = normalizePath(path);
  const cut = norm.lastIndexOf('/');
  if (cut < 0) return norm;
  const name = norm.slice(cut + 1);
  const dir = norm.slice(0, cut);
  const tail = dir.split('/').filter(Boolean).slice(-2).join('/');
  return tail ? `${name} · ${tail}` : name;
}

/** Relative age text used next to recent rows. */
export function formatAgo(ts: number, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - ts) / 60_000));
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 时`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天`;
  return `${Math.floor(days / 7)} 周`;
}
