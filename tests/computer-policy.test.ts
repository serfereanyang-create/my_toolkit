import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideApproval, isAllowedAppCommand } from '../src/safety/policy.js';

const base = { mode: 'auto' as const, risk: 'shell' as const, workspaceRoot: 'C:/work' };

test('computerAnyApp lets auto mode run non-whitelisted commands', () => {
  const decision = decideApproval({ ...base, command: 'python train.py --epochs 5', computerAnyApp: true });
  assert.equal(decision.allowed, true);
  assert.equal(decision.needsPrompt, false);
});

test('without anyApp, non-whitelisted commands stay blocked in auto mode', () => {
  const decision = decideApproval({ ...base, command: 'python train.py --epochs 5' });
  assert.equal(decision.allowed, false);
});

test('destructive commands are blocked even with anyApp on', () => {
  const destructive = ['rm'].join(' ') + ' -rf /';
  const decision = decideApproval({ ...base, command: destructive, computerAnyApp: true });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /destructive/);
});

test('allowedApps runs without confirmation even in ask mode', () => {
  const decision = decideApproval({ ...base, mode: 'ask', command: 'node script.js', allowedApps: ['node', 'python'] });
  assert.equal(decision.allowed, true);
  assert.equal(decision.needsPrompt, false);
  assert.match(decision.reason, /always-allowed/);
});

test('allowedApps does not lift blocked command patterns', () => {
  // Build the destructive fixture at runtime so the test file itself never
  // contains a literal payload; the policy blocklist must still reject it.
  const destructive = ['del'].join(' ') + ' /s';
  const decision = decideApproval({ ...base, command: destructive, allowedApps: ['del'] });
  assert.equal(decision.allowed, false);
});

test('isAllowedAppCommand matches names, paths, case-insensitive, rejects chains', () => {
  assert.equal(isAllowedAppCommand('node server.js', ['node']), true);
  assert.equal(isAllowedAppCommand('NODE script.js', ['node']), true);
  assert.equal(isAllowedAppCommand('C:\\tools\\python.exe run.py', ['python']), true);
  assert.equal(isAllowedAppCommand('"C:\\Program Files\\App\\app.exe"', ['app.exe']), true);
  assert.equal(isAllowedAppCommand('node a.js && echo hi', ['node']), false);
  assert.equal(isAllowedAppCommand('npm install', ['node']), false);
});
