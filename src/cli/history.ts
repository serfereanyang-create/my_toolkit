import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Persistent REPL input history — the Codex CLI design (history file under the
 * agent home, most-recent-last on disk, newest-first when handed to readline).
 * Stored in `<workspace>/.aicode/cli-history.json` next to the other agent
 * state (sessions, memories, reflections). Values are sanitized: single-line,
 * bounded length, deduped, capped.
 */

export const HISTORY_LIMIT = 200;
export const HISTORY_ENTRY_MAX_CHARS = 400;

export type CliHistoryFile = { entries: string[] };

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

export async function loadCliHistory(workspaceRoot: string): Promise<string[]> {
  try {
    const raw = await readFile(historyFilePath(workspaceRoot), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as CliHistoryFile).entries)) return [];
    return (parsed as CliHistoryFile).entries.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return []; // missing/corrupt history must never block startup
  }
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
  const entries = await loadCliHistory(workspaceRoot);
  if (entry) {
    const deduped = entries[entries.length - 1] === entry ? entries : [...entries, entry];
    while (deduped.length > HISTORY_LIMIT) deduped.shift();
    try {
      await mkdir(join(workspaceRoot, '.aicode'), { recursive: true });
      await writeFile(historyFilePath(workspaceRoot), `${JSON.stringify({ entries: deduped }, null, 2)}\n`, 'utf8');
    } catch {
      // ignore: history persistence is a convenience, not a correctness gate
    }
    return deduped;
  }
  return entries;
}

/** readline wants newest-first; disk keeps oldest-first (append order). */
export function toReadlineHistory(entries: string[]): string[] {
  return [...entries].reverse();
}
