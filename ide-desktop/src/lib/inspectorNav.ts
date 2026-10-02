/*
 * inspectorNav — the drill-down navigation stack for the right-hand inspector.
 *
 * The inspector is not a tab strip: clicking a row pushes a deeper level, and
 * the user walks back up with 返回 or by clicking a breadcrumb. That is a
 * stack, not a selection, and the difference matters:
 *
 *  - Pushing the same level again (graph → commit → graph → commit) must not
 *    grow the stack forever; each push is a real navigation step.
 *  - Going "back" from level 3 returns to level 2 with level 2's argument
 *    intact, which is why each entry carries its own params.
 *
 * Pure and synchronous so the behaviour is unit-testable without a DOM.
 */

export type InspectorLevel =
  | { kind: 'overview' }
  | { kind: 'changes' }
  /** A file diff; `ref` scopes it to one commit instead of the working tree. */
  | { kind: 'file'; path: string; staged?: boolean; ref?: string }
  | { kind: 'branches' }
  | { kind: 'graph' }
  | { kind: 'commit'; hash: string }
  | { kind: 'plan' }
  | { kind: 'subagents' }
  /** Per-call model trajectory: what each round-trip sent and returned. */
  | { kind: 'trajectory' };

export type InspectorEntry = {
  level: InspectorLevel;
  /** Stable identity, so pushing the same view twice is detectable. */
  key: string;
  /** Human label for the breadcrumb. */
  label: string;
};

export type InspectorStack = {
  /** Oldest first; the last entry is the current view. */
  entries: InspectorEntry[];
};

/** Identity of a level, used both as the React key and the dedupe check. */
export function levelKey(level: InspectorLevel): string {
  switch (level.kind) {
    case 'file':
      return `file:${level.ref ? `${level.ref}:` : ''}${level.staged ? 'staged' : 'work'}:${level.path}`;
    case 'commit':
      return `commit:${level.hash}`;
    default:
      return level.kind;
  }
}

/** Breadcrumb / header text for a level. */
export function levelLabel(level: InspectorLevel): string {
  switch (level.kind) {
    case 'overview': return '概览';
    case 'changes': return '更改';
    case 'branches': return '分支';
    case 'graph': return '提交图谱';
    case 'plan': return '计划';
    case 'subagents': return '子智能体';
    case 'trajectory': return '模型轨迹';
    case 'commit': return level.hash.slice(0, 7);
    case 'file': {
      const normalized = level.path.replace(/\\/g, '/');
      const name = normalized.slice(normalized.lastIndexOf('/') + 1);
      return name || normalized;
    }
  }
}

function entry(level: InspectorLevel): InspectorEntry {
  return { level, key: levelKey(level), label: levelLabel(level) };
}

/** A fresh stack showing the overview. */
export function initialStack(): InspectorStack {
  return { entries: [entry({ kind: 'overview' })] };
}

/**
 * Push a level, making it the current view.
 *
 * Pushing the level already on top is a no-op: re-clicking the row you are
 * already looking at should not stack duplicates that the user then has to
 * click 返回 through.
 */
export function pushLevel(stack: InspectorStack, level: InspectorLevel): InspectorStack {
  const next = entry(level);
  const top = stack.entries[stack.entries.length - 1];
  if (top && top.key === next.key) return stack;
  return { entries: [...stack.entries, next] };
}

/** Go back one level. At the root this is a no-op, not an empty stack. */
export function popLevel(stack: InspectorStack): InspectorStack {
  if (stack.entries.length <= 1) return stack;
  return { entries: stack.entries.slice(0, -1) };
}

/** Jump to a breadcrumb entry, dropping everything below it. */
export function goToIndex(stack: InspectorStack, index: number): InspectorStack {
  if (!Number.isInteger(index) || index < 0 || index >= stack.entries.length) return stack;
  return { entries: stack.entries.slice(0, index + 1) };
}

/** The current (deepest) view. */
export function currentEntry(stack: InspectorStack): InspectorEntry {
  return stack.entries[stack.entries.length - 1]!;
}

/** True when there is somewhere to go back to. */
export function canGoBack(stack: InspectorStack): boolean {
  return stack.entries.length > 1;
}

/**
 * A fresh stack for a newly-opened view, optionally seeded one level deep.
 *
 * Used when the session changes: a stack pointing at a file from the previous
 * conversation would show a path that is no longer meaningful, so it resets
 * to the requested root.
 */
export function resetStack(root: InspectorLevel = { kind: 'overview' }): InspectorStack {
  return { entries: [entry(root)] };
}
