import { describe, expect, it } from 'vitest';
import {
  canGoBack,
  currentEntry,
  goToIndex,
  initialStack,
  levelKey,
  levelLabel,
  popLevel,
  pushLevel,
  resetStack,
} from './inspectorNav';

describe('inspectorNav stack', () => {
  it('opens a requested changes entry with a usable overview breadcrumb', () => {
    const stack = initialStack({ kind: 'changes' });
    expect(currentEntry(stack).level).toEqual({ kind: 'changes' });
    expect(canGoBack(stack)).toBe(true);
    expect(currentEntry(popLevel(stack)).level).toEqual({ kind: 'overview' });
  });
  it('keeps the commit and index side when initially opening a file', () => {
    const level = { kind: 'file' as const, path: 'src/session.ts', staged: true, ref: 'abc1234' };
    expect(currentEntry(initialStack(level)).level).toEqual(level);
  });
  it('never duplicates the overview when it is explicitly requested', () => {
    expect(initialStack({ kind: 'overview' }).entries).toHaveLength(1);
  });
  it('starts on the overview with nothing to go back to', () => {
    const stack = initialStack();
    expect(currentEntry(stack).level.kind).toBe('overview');
    expect(canGoBack(stack)).toBe(false);
  });

  it('pushes deeper levels and walks back out in order', () => {
    let stack = initialStack();
    stack = pushLevel(stack, { kind: 'graph' });
    stack = pushLevel(stack, { kind: 'commit', hash: 'abc1234' });
    stack = pushLevel(stack, { kind: 'file', path: 'src/a.ts' });

    expect(currentEntry(stack).level).toEqual({ kind: 'file', path: 'src/a.ts' });
    expect(stack.entries.map((e) => e.level.kind)).toEqual(['overview', 'graph', 'commit', 'file']);

    stack = popLevel(stack);
    expect(currentEntry(stack).level).toEqual({ kind: 'commit', hash: 'abc1234' });
    // The commit's own argument must survive the round trip, or going back
    // would land on a different commit than the one the user came from.
    expect(currentEntry(stack).level).toHaveProperty('hash', 'abc1234');

    stack = popLevel(stack);
    expect(currentEntry(stack).level.kind).toBe('graph');
  });

  it('popping the root is a no-op, not an empty stack', () => {
    const stack = initialStack();
    expect(popLevel(stack)).toBe(stack);
    expect(popLevel(stack).entries).toHaveLength(1);
  });

  it('re-pushing the current level does not stack duplicates', () => {
    let stack = initialStack();
    stack = pushLevel(stack, { kind: 'changes' });
    const again = pushLevel(stack, { kind: 'changes' });
    expect(again).toBe(stack);
    expect(again.entries).toHaveLength(2);
  });

  it('distinguishes two files and two commits from each other', () => {
    let stack = initialStack();
    stack = pushLevel(stack, { kind: 'file', path: 'src/a.ts' });
    stack = pushLevel(stack, { kind: 'file', path: 'src/b.ts' });
    expect(stack.entries).toHaveLength(3);

    // The same path staged vs unstaged is a different view.
    let other = initialStack();
    other = pushLevel(other, { kind: 'file', path: 'src/a.ts', staged: true });
    other = pushLevel(other, { kind: 'file', path: 'src/a.ts', staged: false });
    expect(other.entries).toHaveLength(3);
  });

  it('breadcrumb jump drops everything below the target', () => {
    let stack = initialStack();
    stack = pushLevel(stack, { kind: 'graph' });
    stack = pushLevel(stack, { kind: 'commit', hash: 'deadbee' });
    stack = pushLevel(stack, { kind: 'file', path: 'x.ts' });

    stack = goToIndex(stack, 1);
    expect(currentEntry(stack).level.kind).toBe('graph');
    expect(stack.entries).toHaveLength(2);

    // Out-of-range indices must not corrupt the stack.
    expect(goToIndex(stack, 9)).toBe(stack);
    expect(goToIndex(stack, -1)).toBe(stack);
    expect(goToIndex(stack, 1.5)).toBe(stack);
  });

  it('resetStack drops a stale path when the session changes', () => {
    let stack = initialStack();
    stack = pushLevel(stack, { kind: 'file', path: 'old-session.ts' });
    const reset = resetStack();
    expect(reset.entries).toHaveLength(1);
    expect(currentEntry(reset).level.kind).toBe('overview');

    const seeded = resetStack({ kind: 'subagents' });
    expect(currentEntry(seeded).level.kind).toBe('subagents');
  });
});

describe('levelKey / levelLabel', () => {
  it('keys are unique per view, including per file and per commit', () => {
    expect(levelKey({ kind: 'overview' })).toBe('overview');
    expect(levelKey({ kind: 'file', path: 'a.ts' })).not.toBe(levelKey({ kind: 'file', path: 'b.ts' }));
    expect(levelKey({ kind: 'file', path: 'a.ts', staged: true }))
      .not.toBe(levelKey({ kind: 'file', path: 'a.ts', staged: false }));
    expect(levelKey({ kind: 'commit', hash: 'a' })).not.toBe(levelKey({ kind: 'commit', hash: 'b' }));
  });

  it('labels files by basename and commits by short hash', () => {
    expect(levelLabel({ kind: 'file', path: 'src/components/Deep/Name.tsx' })).toBe('Name.tsx');
    expect(levelLabel({ kind: 'file', path: 'C:\\proj\\src\\a.ts' })).toBe('a.ts');
    expect(levelLabel({ kind: 'commit', hash: 'abcdef1234567890' })).toBe('abcdef1');
    expect(levelLabel({ kind: 'changes' })).toBe('更改');
  });
});
