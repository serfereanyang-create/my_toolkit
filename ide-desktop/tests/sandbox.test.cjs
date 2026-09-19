const assert = require('node:assert/strict');
const { test } = require('node:test');

const { evaluate, normalizeMode, isInside, matchesDangerous } = require('../electron/sandbox.cjs');

const ROOT = 'C:/Users/dev/project';

function approval(overrides) {
  return { type: 'approval_needed', tool: 'edit_file', risk: 'write', input: {}, ...overrides };
}

test('mode off passes everything through', () => {
  const r = evaluate(approval({ input: { path: 'C:/Windows/system32/x.dll' } }), { mode: 'off', workspaceRoot: ROOT });
  assert.deepEqual(r, { decision: 'pass' });
});

test('normalizeMode clamps unknown values to off', () => {
  assert.equal(normalizeMode('strict'), 'strict');
  assert.equal(normalizeMode('workspace'), 'workspace');
  assert.equal(normalizeMode('nope'), 'off');
  assert.equal(normalizeMode(undefined), 'off');
});

test('workspace mode denies writes outside the root', () => {
  const r = evaluate(approval({ input: { path: 'C:/Windows/x.dll' } }), { mode: 'workspace', workspaceRoot: ROOT });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /工作区之外/);
});

test('workspace mode allows in-root writes (relative and absolute, mixed separators)', () => {
  const policy = { mode: 'workspace', workspaceRoot: ROOT };
  assert.equal(evaluate(approval({ input: { path: 'src/app.ts' } }), policy).decision, 'pass');
  assert.equal(evaluate(approval({ input: { path: 'C:\\Users\\dev\\project\\src\\a.ts' } }), policy).decision, 'pass');
  assert.equal(evaluate(approval({ input: { path: 'C:/Users/dev/project' } }), policy).decision, 'pass');
});

test('sibling-prefix escape is denied (project vs project-evil)', () => {
  const r = evaluate(approval({ input: { path: 'C:/Users/dev/project-evil/x' } }), { mode: 'workspace', workspaceRoot: ROOT });
  assert.equal(r.decision, 'deny');
});

test('diff path is used when input has none', () => {
  const r = evaluate(approval({ input: {}, diff: { path: 'D:/other/x.ts' } }), { mode: 'workspace', workspaceRoot: ROOT });
  assert.equal(r.decision, 'deny');
});

test('workspace mode denies dangerous shell but passes benign shell', () => {
  const policy = { mode: 'workspace', workspaceRoot: ROOT };
  const rm = evaluate(approval({ risk: 'shell', input: { command: 'sudo rm -rf / --no-preserve-root' } }), policy);
  assert.equal(rm.decision, 'deny');
  assert.match(rm.reason, /危险模式/);
  const ls = evaluate(approval({ risk: 'shell', input: { command: 'npm run build' } }), policy);
  assert.equal(ls.decision, 'pass');
});

test('strict mode denies all shell and network, auto-allows reads', () => {
  const policy = { mode: 'strict', workspaceRoot: ROOT };
  assert.equal(evaluate(approval({ risk: 'shell', input: { command: 'echo hi' } }), policy).decision, 'deny');
  assert.equal(evaluate(approval({ risk: 'network', input: { url: 'https://x' } }), policy).decision, 'deny');
  const read = evaluate(approval({ risk: 'read', tool: 'read_file', input: { path: 'C:/etc/passwd' } }), policy);
  assert.equal(read.decision, 'allow');
});

test('non-approval events always pass', () => {
  assert.deepEqual(evaluate({ type: 'turn_done' }, { mode: 'strict', workspaceRoot: ROOT }), { decision: 'pass' });
});

test('isInside handles trailing slashes and case', () => {
  assert.equal(isInside('C:/A/B/', 'c:/a/b/c.txt'), true);
  assert.equal(isInside('C:/A/B', 'C:/A/BC'), false);
  assert.equal(isInside('', 'anything'), false);
});

test('isInside refuses to be fooled by .. traversal', () => {
  // A naive prefix check reads `<root>/../../Windows/x` as "inside <root>"
  // because the string still starts with the root — the classic bypass.
  assert.equal(isInside('C:/Users/dev/project', 'C:/Users/dev/project/../../Windows/x'), false);
  assert.equal(isInside('C:/Users/dev/project', 'C:/Users/dev/project/src/../../secret'), false);
  // Legitimate inner traversal that stays inside must still pass.
  assert.equal(isInside('C:/Users/dev/project', 'C:/Users/dev/project/src/../app.ts'), true);
  assert.equal(isInside('C:/Users/dev/project', 'C:/Users/dev/project/./src/app.ts'), true);
});

test('workspace mode denies a traversal write that escapes the root', () => {
  const r = evaluate(
    approval({ input: { path: 'C:/Users/dev/project/../../../Windows/x.dll' } }),
    { mode: 'workspace', workspaceRoot: ROOT },
  );
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /工作区之外/);
});

test('copy_file destination is checked, not its outside source', () => {
  const policy = { mode: 'workspace', workspaceRoot: ROOT };
  // Reading a source outside the workspace is allowed; the write target decides.
  const inside = evaluate(
    approval({ tool: 'copy_file', input: { from: 'D:/templates/a.txt', to: 'src/a.txt' } }),
    policy,
  );
  assert.equal(inside.decision, 'pass');
  const outside = evaluate(
    approval({ tool: 'copy_file', input: { from: 'src/a.txt', to: 'D:/escape/a.txt' } }),
    policy,
  );
  assert.equal(outside.decision, 'deny');
});

test('matchesDangerous is case-insensitive and whitespace-normalised', () => {
  assert.ok(matchesDangerous('RM    -RF  /'));
  assert.equal(matchesDangerous('rm -rf ./build'), null); // scoped rm is not the bare pattern
  assert.equal(matchesDangerous(''), null);
});

test('raw physical-drive writes are recognised despite separators', () => {
  // The pattern previously read `physticaldrive`, so this never matched.
  assert.ok(matchesDangerous('echo x > \\.\\PhysicalDrive0'));
  assert.ok(matchesDangerous('dd if=/dev/zero of=/dev/sda'));
});

test('missing workspace root: writes pass (no root to compare against)', () => {
  const r = evaluate(approval({ input: { path: 'C:/Windows/x' } }), { mode: 'workspace', workspaceRoot: '' });
  assert.equal(r.decision, 'pass');
});
