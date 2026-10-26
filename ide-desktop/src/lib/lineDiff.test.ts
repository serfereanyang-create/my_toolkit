import { describe, expect, it } from 'vitest';
import { diffLines, inlineWordDiff, splitLines, toUnifiedDiff } from './lineDiff';

describe('splitLines', () => {
  it('drops the trailing empty segment from a final newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('\n')).toEqual(['']);
  });
});

describe('diffLines', () => {
  it('returns no changes for identical text', () => {
    const d = diffLines('a\nb\nc\n', 'a\nb\nc\n');
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.hunks).toEqual([]);
    expect(d.ops.every((op) => op.kind === 'equal')).toBe(true);
  });

  it('detects a single inserted line with correct numbering', () => {
    const d = diffLines('a\nc\n', 'a\nb\nc\n');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
    const inserted = d.ops.find((op) => op.kind === 'insert')!;
    expect(inserted.text).toBe('b');
    expect(inserted.newLine).toBe(1); // 0-based
  });

  it('detects a deleted line', () => {
    const d = diffLines('a\nb\nc\n', 'a\nc\n');
    expect(d.removed).toBe(1);
    expect(d.added).toBe(0);
    const deleted = d.ops.find((op) => op.kind === 'delete')!;
    expect(deleted.text).toBe('b');
    expect(deleted.oldLine).toBe(1);
  });

  it('handles a complete rewrite of one file into another', () => {
    const oldText = 'alpha\nbeta\ngamma\n';
    const newText = 'one\ntwo\n';
    const d = diffLines(oldText, newText);
    expect(d.removed).toBe(3);
    expect(d.added).toBe(2);
    expect(d.approximated).toBe(false);
  });

  it('handles empty sides', () => {
    expect(diffLines('', 'a\nb\n').added).toBe(2);
    expect(diffLines('a\nb\n', '').removed).toBe(2);
    expect(diffLines('', '')).toMatchObject({ added: 0, removed: 0, approximated: false });
  });

  it('pairs a change (delete+insert) with equal lines preserved', () => {
    const d = diffLines('keep\nold\nkeep\n', 'keep\nnew\nkeep\n');
    const equalCount = d.ops.filter((op) => op.kind === 'equal').length;
    expect(equalCount).toBe(2);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
  });

  it('trims common prefix/suffix so huge equal regions stay cheap', () => {
    const prefix = Array.from({ length: 500 }, (_, i) => `p${i}`).join('\n');
    const suffix = Array.from({ length: 500 }, (_, i) => `s${i}`).join('\n');
    const d = diffLines(`${prefix}\nX\n${suffix}\n`, `${prefix}\nY\n${suffix}\n`);
    expect(d.removed).toBe(1);
    expect(d.added).toBe(1);
  });

  it('falls back to anchors (approximated) for gigantic cores beyond budget', () => {
    // Two 3000-line files with only unique-line matches between them would be
    // 9M cells > the 4M DP budget; the fallback must still produce sane ops.
    const a = Array.from({ length: 3000 }, (_, i) => `a-line-${i}`);
    const b = Array.from({ length: 3000 }, (_, i) => (i < 10 ? `a-line-${i * 5}` : `b-line-${i}`));
    const d = diffLines(a.join('\n'), b.join('\n'));
    expect(d.approximated).toBe(true);
    // The 10 anchor lines must survive as equal rows.
    expect(d.ops.filter((op) => op.kind === 'equal').length).toBeGreaterThanOrEqual(9);
  });
});

describe('groupHunks', () => {
  it('merges changes within the context window into one hunk', () => {
    const old = ['1', '2', '3', 'x', '4', '5', '6'];
    const next = ['1', '2', '3', 'X', '4', '5', '6'];
    const d = diffLines(old.join('\n'), next.join('\n'), 2);
    expect(d.hunks).toHaveLength(1);
    const [hunk] = d.hunks;
    expect(hunk.oldStart).toBe(2); // one context line before the change (1-based)
    expect(hunk.ops.some((op) => op.kind === 'delete' && op.text === 'x')).toBe(true);
    expect(hunk.ops.some((op) => op.kind === 'insert' && op.text === 'X')).toBe(true);
  });

  it('splits distant changes into separate hunks', () => {
    const a = Array.from({ length: 40 }, (_, i) => String(i));
    const b = [...a];
    b[5] = 'CHANGED-5';
    b[35] = 'CHANGED-35';
    const d = diffLines(a.join('\n'), b.join('\n'), 3);
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[0].oldStart).toBeLessThan(d.hunks[1].oldStart);
  });

  it('produces correct header counts for a pure insertion', () => {
    const a = ['x', 'y'];
    const b = ['x', 'ins', 'y'];
    const d = diffLines(a.join('\n'), b.join('\n'), 1);
    const hunk = d.hunks[0];
    // Context x,y equal + 1 insert: oldCount counts equal+delete rows.
    expect(hunk.oldCount).toBe(2);
    expect(hunk.newCount).toBe(3);
  });
});

describe('inlineWordDiff', () => {
  it('marks only the changed token as different', () => {
    const { oldParts, newParts } = inlineWordDiff('const x = 1;', 'const x = 2;');
    // Tokens: 'const',' ','x',' ','=',' ','1;' vs the same with '2;'. The
    // number shares a token with ';' (no space between), so the whole token
    // is marked changed.
    expect(oldParts.filter((p) => p.changed).map((p) => p.text)).toEqual(['1;']);
    expect(newParts.filter((p) => p.changed).map((p) => p.text)).toEqual(['2;']);
    expect(oldParts[0]).toEqual({ text: 'const', changed: false });
    expect(oldParts[1]).toEqual({ text: ' ', changed: false });
  });

  it('handles identical lines with no changes', () => {
    const { oldParts, newParts } = inlineWordDiff('a b c', 'a b c');
    expect(oldParts.every((p) => !p.changed)).toBe(true);
    expect(newParts.every((p) => !p.changed)).toBe(true);
  });

  it('handles fully different lines', () => {
    const { oldParts, newParts } = inlineWordDiff('aaa', 'bbb');
    expect(oldParts.every((p) => p.changed)).toBe(true);
    expect(newParts.every((p) => p.changed)).toBe(true);
  });

  it('handles empty inputs', () => {
    expect(inlineWordDiff('', '').oldParts).toEqual([]);
    const { newParts } = inlineWordDiff('', 'x');
    expect(newParts.filter((p) => p.changed).map((p) => p.text)).toEqual(['x']);
  });
});

describe('toUnifiedDiff', () => {
  it('emits git-style headers and prefixed rows', () => {
    const d = diffLines('a\nb\n', 'a\nB\n');
    const text = toUnifiedDiff(d, 'old.txt', 'new.txt');
    expect(text).toContain('--- old.txt');
    expect(text).toContain('+++ new.txt');
    expect(text).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(text).toContain('-b');
    expect(text).toContain('+B');
    expect(text).toContain(' a');
  });

  it('round-trips nothing for an empty diff', () => {
    const d = diffLines('same\n', 'same\n');
    expect(toUnifiedDiff(d)).toBe('--- a\n+++ b');
  });
});
