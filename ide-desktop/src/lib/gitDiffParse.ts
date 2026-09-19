/*
 * gitDiffParse — turn unified diff text into renderable rows.
 *
 * The inspector's file level shows a real diff, so it needs more than a blob
 * of text: line numbers per side, an add/del/context kind, and hunk headers
 * so the user can see where in the file each change sits.
 *
 * Pure, so the parsing is unit-testable without a repo or a DOM.
 */

export type DiffRowKind = 'add' | 'del' | 'ctx' | 'meta';

export type DiffRow = {
  kind: DiffRowKind;
  /** Line number in the old file, when the row exists there. */
  oldLine?: number;
  /** Line number in the new file, when the row exists there. */
  newLine?: number;
  text: string;
};

export type DiffHunk = {
  /** The raw `@@ ... @@` header, shown as a separator. */
  header: string;
  rows: DiffRow[];
};

/**
 * Read the leading digits at `start`, returning the number and the index just
 * past them. Scanned by hand rather than regex-matched: the hunk header is a
 * fixed little grammar, and indexOf/digit scanning keeps it trivially
 * auditable and immune to backtracking, matching the parsing style already
 * used in electron/git.cjs.
 */
function readNumber(text: string, start: number): { value: number; next: number } | null {
  let end = start;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    if (code < 48 || code > 57) break; // not 0-9
    end += 1;
  }
  if (end === start) return null;
  return { value: Number(text.slice(start, end)), next: end };
}

/**
 * Parse a `@@ -oldStart[,oldCount] +newStart[,newCount] @@` header.
 * Returns null for anything that is not a hunk header.
 */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  if (!line.startsWith('@@ -')) return null;
  const oldPart = readNumber(line, 4);
  if (!oldPart) return null;

  // Skip an optional ",count" on the old side.
  let at = oldPart.next;
  if (line[at] === ',') {
    const oldCount = readNumber(line, at + 1);
    if (!oldCount) return null;
    at = oldCount.next;
  }
  if (line.slice(at, at + 2) !== ' +') return null;

  const newPart = readNumber(line, at + 2);
  if (!newPart) return null;
  return { oldStart: oldPart.value, newStart: newPart.value };
}

/**
 * Split a unified diff into hunks of typed rows.
 *
 * File headers (`diff --git`, `index`, `---`, `+++`) are dropped: the
 * inspector already knows which file it is showing, so repeating the header
 * on every file would be noise. Everything else is preserved verbatim,
 * including `\ No newline at end of file`.
 */
export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  if (!diff) return hunks;

  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    const header = parseHunkHeader(line);
    if (header) {
      oldLine = header.oldStart;
      newLine = header.newStart;
      current = { header: line, rows: [] };
      hunks.push(current);
      continue;
    }

    // File-level preamble before the first hunk is not part of any hunk.
    if (!current) continue;

    // A diff line always starts with a marker; a stray empty string is the
    // trailing newline of the split and must not become a phantom context row.
    if (line === '') continue;

    const marker = line[0];
    const text = line.slice(1);

    if (marker === '+') {
      current.rows.push({ kind: 'add', newLine, text });
      newLine += 1;
    } else if (marker === '-') {
      current.rows.push({ kind: 'del', oldLine, text });
      oldLine += 1;
    } else if (marker === ' ') {
      current.rows.push({ kind: 'ctx', oldLine, newLine, text });
      oldLine += 1;
      newLine += 1;
    } else {
      // "\ No newline at end of file" and any other marker-less line.
      current.rows.push({ kind: 'meta', text: line });
    }
  }

  return hunks;
}

/** Totals across a whole diff, for the level's header summary. */
export function countDiffRows(hunks: DiffHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const row of hunk.rows) {
      if (row.kind === 'add') added += 1;
      else if (row.kind === 'del') removed += 1;
    }
  }
  return { added, removed };
}
