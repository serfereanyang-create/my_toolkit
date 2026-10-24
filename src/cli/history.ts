import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renameWithRetry, serializeWrites, writeFileAtomic } from '../utils/atomic.js';

/**
 * Persistent REPL input history — the Codex CLI design (history file under the
 * agent home, most-recent-last on disk, newest-first when handed to readline).
 * Stored in `<workspace>/.aicode/cli-history.json` next to the other agent
 * state (sessions, memories, reflections). Values are sanitized: single-line,
 * bounded length, deduped, capped.
 *
 * The file is one whole-file read-modify-write, so it carries the same three
 * failure modes as every other JSON store here — and this one is the least
 * recoverable, because nothing else holds a copy of what the user typed:
 *   - a crash during the write used to leave it truncated (plain writeFile
 *     truncates first), and the next prompt read that as "no history" and
 *     rewrote the whole file: 200 prompts gone, silently;
 *   - two REPLs (or a fast paste) appended concurrently, both read the same
 *     snapshot and the second write dropped the first entry;
 *   - a transient read error (antivirus / another editor holding the handle on
 *     Windows) was indistinguishable from an empty file, so a momentary lock
 *     also erased it.
 * Hence: atomic write, per-file serialization, quarantine-on-corrupt, and no
 * write at all when the current contents could not be read.
 */

export const HISTORY_LIMIT = 200;
export const HISTORY_ENTRY_MAX_CHARS = 400;

export type CliHistoryFile = { entries: string[] };

/**
 * What was read, whether writing over it is safe, and whether `entries` are the
 * salvaged remains of a damaged file (which the caller should make durable).
 */
type HistoryRead = { entries: string[]; writable: boolean; recovered: boolean };

export function historyFilePath(workspaceRoot: string): string {
  return join(workspaceRoot, '.aicode', 'cli-history.json');
}

/** Normalize one raw input line into a history entry ('' = do not record). */
export function normalizeHistoryEntry(text: string): string {
  const singleLine = text.replace(/\r/g, '').replace(/\n/g, ' ').trim();
  if (!singleLine) return '';
  return singleLine.length > HISTORY_ENTRY_MAX_CHARS
    ? `${singleLine.slice(0, HISTORY_ENTRY_MAX_CHARS - 1)}…`
    : singleLine;
}

/**
 * Recover the complete entries from a truncated file: `writeFile` in place
 * cuts the file mid-string, so everything before the cut is still intact and
 * worth keeping. Only whole JSON string literals are taken; the partial tail
 * is dropped. Returns [] when nothing can be trusted.
 */
export function salvageHistoryEntries(raw: string): string[] {
  const marker = raw.indexOf('"entries"');
  const open = marker < 0 ? -1 : raw.indexOf('[', marker);
  if (open < 0) return [];
  const recovered: string[] = [];
  const literal = /"((?:[^"\\]|\\.)*)"/g;
  literal.lastIndex = open + 1;
  for (let match = literal.exec(raw); match; match = literal.exec(raw)) {
    try {
      const value = JSON.parse(`"${match[1]}"`) as unknown;
      if (typeof value === 'string' && normalizeHistoryEntry(value)) recovered.push(value);
    } catch {
      // not a complete literal — stop at the first one that no longer parses
      break;
    }
    if (recovered.length > HISTORY_LIMIT * 4) break; // a runaway file is not history
  }
  return recovered.slice(-HISTORY_LIMIT);
}

async function readHistoryFile(workspaceRoot: string): Promise<HistoryRead> {
  const file = historyFilePath(workspaceRoot);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    // Genuinely absent: an empty history, and a write is safe.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], writable: true, recovered: false };
    // Anything else (EPERM/EBUSY/EIO) means the contents exist but are
    // invisible to us right now — never overwrite what we could not see.
    return { entries: [], writable: false, recovered: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as CliHistoryFile).entries)) {
    // Unusable contents: keep the original so the prompts in it are not lost,
    // then report writable so appending starts a fresh, valid file.
    const backup = `${file}.corrupt-${Date.now()}.json`;
    const preserved = await renameWithRetry(file, backup).then(
      () => true,
      () => false,
    );
    const salvaged = salvageHistoryEntries(raw);
    if (!preserved) return { entries: salvaged, writable: false, recovered: false };
    return { entries: salvaged, writable: true, recovered: salvaged.length > 0 };
  }
  return {
    entries: (parsed as CliHistoryFile).entries.filter((entry): entry is string => typeof entry === 'string'),
    writable: true,
    recovered: false,
  };
}

/** True when nothing is at `path` (a read failure counts as "something is there"). */
async function isAbsent(path: string): Promise<boolean> {
  return await readFile(path).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );
}

export async function loadCliHistory(workspaceRoot: string): Promise<string[]> {
  const { entries, recovered } = await readHistoryFile(workspaceRoot);
  if (!recovered) return entries;
  // The salvage happened on a file we just moved aside, so `entries` live only
  // in memory: write them back or the next append starts from nothing.
  const file = historyFilePath(workspaceRoot);
  return await serializeWrites(file, async () => {
    if (await isAbsent(file)) {
      await writeFileAtomic(file, `${JSON.stringify({ entries }, null, 2)}\n`).catch(() => undefined);
    }
    return entries;
  });
}

/**
 * Append an entry (upstream chat_composer_history semantics: empty submissions
 * ignored, ADJACENT duplicates collapsed — only compared against the newest
 * entry, no global move-to-newest). Most-recent-last on disk.
 * Returns the updated entry list. Best-effort write: failures are swallowed so
 * a read-only disk cannot break the REPL.
 */
export async function appendCliHistory(workspaceRoot: string, text: string): Promise<string[]> {
  const entry = normalizeHistoryEntry(text);
  if (!entry) return await loadCliHistory(workspaceRoot);
  const file = historyFilePath(workspaceRoot);
  return await serializeWrites(file, async () => {
    const { entries, writable } = await readHistoryFile(workspaceRoot);
    const deduped = entries[entries.length - 1] === entry ? entries : [...entries, entry];
    while (deduped.length > HISTORY_LIMIT) deduped.shift();
    if (!writable) return deduped;
    try {
      await writeFileAtomic(file, `${JSON.stringify({ entries: deduped }, null, 2)}\n`);
    } catch {
      // ignore: history persistence is a convenience, not a correctness gate
    }
    return deduped;
  });
}

/** readline wants newest-first; disk keeps oldest-first (append order). */
export function toReadlineHistory(entries: string[]): string[] {
  return [...entries].reverse();
}
