const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AgentBridge } = require('../electron/agent-bridge.cjs');

/*
 * The CLI argv the desktop spawns.
 *
 * A preference that reaches the bridge but not the argv is invisible: the CLI
 * silently applies its own default and nothing reports the mismatch. So these
 * assert on the actual flag list rather than on the bridge's fields.
 */

function bridge(options = {}) {
  return new AgentBridge({
    cliRoot: 'C:/cli',
    workspaceRoot: 'C:/workspace',
    sessionDir: 'C:/workspace/.aicode/sessions',
    provider: 'mock',
    model: 'mock',
    ...options,
  });
}

test('a delegation level becomes --delegation', () => {
  for (const level of ['off', 'balanced', 'eager']) {
    const args = bridge({ delegation: level }).buildArgs();
    const at = args.indexOf('--delegation');
    assert.ok(at >= 0, `${level} must be passed to the CLI`);
    assert.equal(args[at + 1], level);
  }
});

test('no delegation preference means no flag, so the CLI default applies', () => {
  // Omitting it is deliberate: the CLI owns the default, so the two sides
  // cannot disagree about what "unset" means.
  assert.ok(!bridge().buildArgs().includes('--delegation'));
  assert.ok(!bridge({ delegation: undefined }).buildArgs().includes('--delegation'));
  assert.ok(!bridge({ delegation: null }).buildArgs().includes('--delegation'));
});

test('a corrupted preference is dropped rather than forwarded', () => {
  // The CLI's arg parser rejects an unknown value outright, which would stop
  // the agent from starting at all. A bad preference must degrade to "unset".
  for (const bad of ['aggressive', 'EAGER', '', 42, {}, true]) {
    const args = bridge({ delegation: bad }).buildArgs();
    assert.ok(!args.includes('--delegation'), `${JSON.stringify(bad)} must not reach the CLI`);
  }
});

test('the delegation flag does not disturb the other flags', () => {
  const args = bridge({
    delegation: 'balanced',
    approval: 'auto',
    toolScope: 'full',
    autoReview: true,
    confirmPlan: true,
  }).buildArgs();
  // Every one of these must still be present and correctly paired.
  const pairs = [['--approval', 'auto'], ['--tool-scope', 'full'], ['--delegation', 'balanced']];
  for (const [flag, value] of pairs) {
    const at = args.indexOf(flag);
    assert.ok(at >= 0, `${flag} missing`);
    assert.equal(args[at + 1], value, `${flag} value`);
  }
  assert.ok(args.includes('--auto-review'));
  assert.ok(args.includes('--confirm-plan'));
  // The positional entry point must stay first.
  assert.match(args[0], /index\.js$/);
  assert.equal(args[1], '--desktop-bridge');
});
