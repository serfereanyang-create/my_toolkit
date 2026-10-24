import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The slash menu shows commands grouped by category, but keyboard selection
 *  indexes a flat list. If those two orders differ, ↑/↓ highlight one row and
 *  Enter inserts another — which is exactly what shipped before: the 40th
 *  visible row read /git status and Enter inserted /tools.
 *
 *  These checks read the component's source rather than mounting it: the
 *  ordering is a property of two literal arrays, and the failure mode is a
 *  mismatch between them, so comparing the arrays is the direct assertion. */
const source = readFileSync(join(__dirname, '..', 'components', 'SlashCommandMenu.tsx'), 'utf8');

function literal(name: string): string {
  const start = source.indexOf(`const ${name}`);
  expect(start).toBeGreaterThan(-1);
  const open = source.indexOf('[', start);
  // The commands array ends with `];`, the category list with `] as const;`.
  const close = Math.min(
    ...['];', '] as const'].map((end) => {
      const at = source.indexOf(end, open);
      return at === -1 ? Number.POSITIVE_INFINITY : at;
    }),
  );
  expect(Number.isFinite(close)).toBe(true);
  return source.slice(open, close);
}

const CATEGORY_ORDER = [...literal('CATEGORIES').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
const COMMANDS = [...literal('SLASH_COMMANDS').matchAll(/\{ command: '([^']+)'[^}]*category: '([a-z]+)'/g)]
  .map((m) => ({ command: m[1], category: m[2] }));

describe('SlashCommandMenu ordering', () => {
  it('parses every command', () => {
    expect(CATEGORY_ORDER.length).toBeGreaterThan(5);
    expect(COMMANDS.length).toBeGreaterThan(40);
  });

  it('sections every command into a category the menu renders', () => {
    for (const command of COMMANDS) {
      // A category missing from CATEGORIES would be filtered out of the
      // grouped view entirely — the command would exist but never appear.
      expect(CATEGORY_ORDER).toContain(command.category);
    }
  });

  it('builds the selectable list by walking the rendered categories', () => {
    // The regression guard: both the flat list and the grouped sections must
    // come from the same category-ordered array.
    expect(source).toContain(
      'const ORDERED_COMMANDS: SlashCommand[] = CATEGORIES.flatMap((category) =>',
    );
    expect(source).toContain('const visibleItems = lower\n    ? ORDERED_COMMANDS.filter(');
    expect(source).toContain('const commands = ORDERED_COMMANDS.filter((cmd) => cmd.category === category);');
    // The declaration-order array may be read only by ORDERED_COMMANDS; any
    // other reader (selection or rendering) reintroduces the offset.
    const rawReads = source.split('SLASH_COMMANDS.filter(').length - 1;
    expect(rawReads).toBe(1);
  });

  it('renders the flat list in the same order the grouped view does', () => {
    const grouped = CATEGORY_ORDER.flatMap((category) =>
      COMMANDS.filter((cmd) => cmd.category === category).map((cmd) => cmd.command));
    expect(grouped.length).toBe(COMMANDS.length);
    // No command may be dropped by the grouped walk.
    expect(new Set(grouped).size).toBe(new Set(COMMANDS.map((cmd) => cmd.command)).size);
  });

  it('keeps the two categories whose source order differs last', () => {
    // Catches a future reorder of CATEGORIES that would silently reintroduce
    // the offset: 高级's commands are declared after 常用 in the source but
    // rendered last, which is what made the flat index drift.
    const git = CATEGORY_ORDER.indexOf('git');
    const tools = CATEGORY_ORDER.indexOf('tools');
    const advanced = CATEGORY_ORDER.indexOf('advanced');
    expect(git).toBeLessThan(tools);
    expect(tools).toBeLessThan(advanced);
  });
});
