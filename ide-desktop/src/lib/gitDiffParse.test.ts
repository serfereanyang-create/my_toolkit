import { describe, expect, it } from 'vitest';
import { countDiffRows, parseUnifiedDiff } from './gitDiffParse';

const SAMPLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
  ' const e = 6;',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('drops file headers and keeps hunk rows typed', () => {
    const hunks = parseUnifiedDiff(SAMPLE);
    expect(hunks).toHaveLength(1);
    const kinds = hunks[0]!.rows.map((r) => r.kind);
    expect(kinds).toEqual(['ctx', 'del', 'add', 'add', 'ctx', 'ctx']);
    // No `diff --git` / `index` / `---` / `+++` leaked into the rows.
    expect(hunks[0]!.rows.some((r) => r.text.startsWith('diff --git'))).toBe(false);
    expect(hunks[0]!.rows.some((r) => r.text.startsWith('index '))).toBe(false);
  });

  it('numbers both sides correctly across a change', () => {
    const rows = parseUnifiedDiff(SAMPLE)[0]!.rows;
    // ctx line 1 exists on both sides
    expect(rows[0]).toMatchObject({ oldLine: 1, newLine: 1 });
    // the deleted line is old-only: it must carry no new-side number, or the
    // renderer would print a line number that does not exist in the new file.
    expect(rows[1]!.kind).toBe('del');
    expect(rows[1]!.oldLine).toBe(2);
    expect(rows[1]!.newLine).toBeUndefined();
    // the two added lines are new-only, advancing only the new side
    expect(rows[2]!.kind).toBe('add');
    expect(rows[2]!.newLine).toBe(2);
    expect(rows[2]!.oldLine).toBeUndefined();
    expect(rows[3]!.kind).toBe('add');
    expect(rows[3]!.newLine).toBe(3);
    expect(rows[3]!.oldLine).toBeUndefined();
    // the following context resumes at old 3 / new 4
    expect(rows[4]).toMatchObject({ kind: 'ctx', oldLine: 3, newLine: 4 });
  });

  it('splits multiple hunks and keeps each header', () => {
    const diff = [
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
      '@@ -20,2 +20,3 @@',
      ' y',
      '+z',
      ' w',
    ].join('\n');
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.header).toBe('@@ -1,2 +1,2 @@');
    expect(hunks[1]!.header).toBe('@@ -20,2 +20,3 @@');
    // The second hunk restarts numbering from its own header.
    expect(hunks[1]!.rows[0]).toMatchObject({ oldLine: 20, newLine: 20 });
  });

  it('handles a single-line hunk header without counts', () => {
    const diff = ['@@ -5 +5 @@', '-old', '+new'].join('\n');
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.rows[0]).toMatchObject({ kind: 'del', oldLine: 5 });
    expect(hunks[0]!.rows[1]).toMatchObject({ kind: 'add', newLine: 5 });
  });

  it('keeps the no-newline marker as a meta row instead of dropping it', () => {
    const diff = ['@@ -1 +1 @@', '-a', '+b', '\\ No newline at end of file'].join('\n');
    const rows = parseUnifiedDiff(diff)[0]!.rows;
    expect(rows[2]).toMatchObject({ kind: 'meta' });
    expect(rows[2]!.text).toContain('No newline');
  });

  it('does not invent a phantom row from the trailing newline', () => {
    const rows = parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\n')[0]!.rows;
    expect(rows).toHaveLength(2);
  });

  it('returns nothing for an empty or header-only diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x')).toEqual([]);
  });

  it('preserves CRLF content without leaking the carriage return', () => {
    const rows = parseUnifiedDiff('@@ -1 +1 @@\r\n-a\r\n+b\r\n')[0]!.rows;
    expect(rows[0]!.text).toBe('a');
    expect(rows[1]!.text).toBe('b');
  });

  it('does not mistake a content line starting with @@ for a header', () => {
    // A context line whose text begins with "@@ " is still prefixed by a
    // space, so it must stay a context row.
    const rows = parseUnifiedDiff('@@ -1 +1 @@\n @@ not a header')[0]!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'ctx' });
    expect(rows[0]!.text).toBe('@@ not a header');
  });
});

describe('countDiffRows', () => {
  it('totals additions and deletions', () => {
    expect(countDiffRows(parseUnifiedDiff(SAMPLE))).toEqual({ added: 2, removed: 1 });
    expect(countDiffRows([])).toEqual({ added: 0, removed: 0 });
  });
});
