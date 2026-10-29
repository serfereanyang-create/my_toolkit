import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import {
  normalizeToolScope,
  resolveToolScope,
  selectScopedTools,
  type ResolvedToolScope,
  type ToolScope,
} from '../src/tools/scope.js';

/*
 * Unknown scopes must fail CLOSED.
 *
 * `ResolvedToolScope` is a union, but runtime values reach the scope functions
 * through casts (runtime/createRuntime.ts:97 `(config.toolScope ?? 'auto') as
 * ToolScope`) and hand-written config files (`toolScope: "full "`). Measured on
 * this tree before the fix, such a value selected 236 tools: COMPACT_ALLOW ∪
 * STANDARD_EXTRA_ALLOW, i.e. compact plus all 36 write/shell tools, because
 * every `scope === 'standard'` gate was false. That is wider than compact, so
 * the old fallback failed OPEN.
 *
 * The fix normalises at both entrances (`resolveToolScope`,
 * `selectScopedTools`) to exactly compact, and reports each distinct bad value
 * once on stderr. This file pins: the three legal scopes are unchanged (count
 * + byte digest), unknown values equal compact, and the warning fires.
 *
 * "Unchanged" means unchanged BY THE NORMALISATION. The standard row moved
 * 332→333 on 2026-10-29 when the tool-surface audit added run_script to
 * STANDARD_EXTRA_ALLOW; compact and full still match their 2026-10-28 digests,
 * which is the evidence that the fail-closed work left them alone.
 *
 * The warning dedupes per distinct raw value for the life of the process, so
 * every bad value below is used in exactly one test; a value reused across
 * tests would be silently quiet the second time.
 */

/** Measured on 2026-10-28 before src/tools/scope.ts was touched; standard re-measured 2026-10-29. */
const BASELINE: Record<ResolvedToolScope, { count: number; digest: string }> = {
  compact: { count: 200, digest: '7b7aa8a85b961cc20ba91f5826ed960d20c8d6886e91fa0c459c7d8731beead7' },
  standard: { count: 333, digest: 'e32a658cc471c82754f1d56de437e7008fdd3b97bf48d35f5e59b41a167779e8' },
  full: { count: 363, digest: '400eea088fbe89c31f6b29c34a0b4c7014a1626c751ebc3f9df72dc787848c43' },
};

function scopedNames(scope: ResolvedToolScope): string[] {
  return selectScopedTools(createDefaultToolRegistry(), scope).map((tool) => tool.name).sort();
}

function digest(names: string[]): string {
  return createHash('sha256').update(names.join('\n')).digest('hex');
}

/** Run `fn` with console.error captured instead of printed; restore it always. */
function captureStderr<T>(fn: () => T): { result: T; messages: string[] } {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    return { result: fn(), messages };
  } finally {
    console.error = original;
  }
}

test('the three legal scopes still select exactly the pre-fix sets', () => {
  for (const scope of ['compact', 'standard', 'full'] as const) {
    const names = scopedNames(scope);
    assert.equal(names.length, BASELINE[scope].count, `${scope}: count`);
    assert.equal(digest(names), BASELINE[scope].digest, `${scope}: byte-identical set`);
  }
});

test('every unknown scope selects exactly the compact set, never a write', () => {
  const compact = scopedNames('compact');
  const unknown = ['bogus', 'full ', 'Complete', 'readonly', 'FULL', 'standard ', 'compact '];
  for (const value of unknown) {
    const { result: names, messages } = captureStderr(() => scopedNames(value as ResolvedToolScope));
    assert.deepEqual(names, compact, `${JSON.stringify(value)} must select exactly compact`);
    assert.equal(names.length, 200, `${JSON.stringify(value)}: count`);
    // The old failure mode in one line: compact carries no write and no shell.
    for (const name of ['write_file', 'append_file', 'edit_lines', 'run_command', 'git_commit', 'apply_patch']) {
      assert.ok(!names.includes(name), `${JSON.stringify(value)} must not expose ${name}`);
    }
    assert.ok(!names.includes('spawn_subagent'), `${JSON.stringify(value)} must not expose spawn_subagent`);
    assert.equal(messages.length, 1, `${JSON.stringify(value)} must warn once`);
    assert.match(messages[0]!, /^\[ToolScope\] Unknown tool scope/);
    assert.match(messages[0]!, /falling back to "compact"/);
  }
});

test('normalizeToolScope is a pass-through for legal values and warns per distinct value', () => {
  const before = captureStderr(() => (['compact', 'standard', 'full'] as const).map((scope) => normalizeToolScope(scope)));
  assert.deepEqual(before.result, ['compact', 'standard', 'full']);
  assert.equal(before.messages.length, 0, 'legal values must not warn');

  const { result, messages } = captureStderr(() => ({
    first: normalizeToolScope('warn-probe-a' as ResolvedToolScope),
    second: normalizeToolScope('warn-probe-a' as ResolvedToolScope),
    third: normalizeToolScope('warn-probe-b' as ResolvedToolScope),
  }));
  assert.deepEqual(result, { first: 'compact', second: 'compact', third: 'compact' });
  assert.equal(messages.length, 2, 'one warning per distinct raw value, not per call');
  assert.match(messages[0]!, /"warn-probe-a"/);
  assert.match(messages[1]!, /"warn-probe-b"/);
});

test('resolveToolScope rejects an unknown explicit request instead of passing it through', () => {
  // The pre-fix contract was "an explicit request reaches selectScopedTools
  // verbatim, whatever it is" (tests/tool-scope-matrix.test.ts pins that old
  // behaviour deliberately). Nothing between the config file and the filter
  // validated the value, so it reached the union branch.
  const { result, messages } = captureStderr(() =>
    resolveToolScope({ requested: 'request-probe' as never, prompt: 'x', shouldUseTaskBoard: false }),
  );
  assert.equal(result, 'compact');
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /"request-probe"/);

  // An empty string is falsy and used to be read as "no request", i.e. auto.
  // As a config value the user wrote, it is reported rather than reinterpreted.
  const empty = captureStderr(() =>
    resolveToolScope({ requested: '' as never, prompt: 'x', shouldUseTaskBoard: false }),
  );
  assert.equal(empty.result, 'compact');
  assert.equal(empty.messages.length, 1);

  for (const value of ['compact', 'standard', 'full'] as const) {
    const requested = resolveToolScope({ requested: value, prompt: '实现完整登录流程并补测试', shouldUseTaskBoard: true });
    assert.equal(requested, value, `${value} must still win outright`);
  }
});

test('a bogus previousScope cannot resurrect a wider floor', () => {
  const { result, messages } = captureStderr(() =>
    resolveToolScope({
      requested: 'auto',
      prompt: '读取 package.json',
      shouldUseTaskBoard: false,
      previousScope: 'floor-probe' as unknown as ResolvedToolScope,
    }),
  );
  assert.equal(result, 'compact');
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /"floor-probe"/);
});

test('legacy "auto" reaching selectScopedTools takes the same fail-closed fallback', () => {
  // ToolScope still contains 'auto' and a few callers pass it to
  // selectScopedTools unwidened (subagent/runner.ts:310 falls back to
  // parentRuntime.toolScope, whose default is 'auto'). Previously that selected
  // the 236-tool union; now it is compact, with a warning.
  const { result: names, messages } = captureStderr(() =>
    selectScopedTools(createDefaultToolRegistry(), 'auto' as unknown as ResolvedToolScope).map((tool) => tool.name).sort(),
  );
  assert.deepEqual(names, scopedNames('compact'));
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /"auto"/);
});

test('a ToolScope-typed "auto" is still resolved by phrase, not rejected', () => {
  // Normalisation must not turn the ordinary auto-mode path into compact
  // unconditionally: 'auto' is a legal ToolScope, only illegal as a *resolved*
  // scope.
  const asAuto: ToolScope = 'auto';
  const small = resolveToolScope({ requested: asAuto, prompt: '读取 package.json', shouldUseTaskBoard: false });
  const large = resolveToolScope({ requested: asAuto, prompt: '实现完整登录流程并补测试', shouldUseTaskBoard: false });
  assert.equal(small, 'compact');
  assert.equal(large, 'full');
});
