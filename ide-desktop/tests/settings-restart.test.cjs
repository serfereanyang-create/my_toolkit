const assert = require('node:assert/strict');
const { test } = require('node:test');
const { settingsNeedAgentRestart } = require('../electron/settings-restart.cjs');

const base = () => ({
  approval: 'ask',
  activeProviderId: 'custom_a',
  providers: [
    { id: 'mock', type: 'mock', label: 'Mock', model: 'mock-code-agent-v1' },
    { id: 'custom_a', type: 'custom', label: 'A', model: 'a-1', baseUrl: 'https://a.example/v1' },
  ],
  preferences: { autoReview: false, computerExecutionMode: 'ask' },
});

test('an unchanged config does not restart the agent', () => {
  assert.equal(settingsNeedAgentRestart(base(), base()), false);
});

test('request deadline changes restart the future child while the default remains equivalent', () => {
  const next = base(); next.preferences.requestTimeoutMs = 900000;
  assert.equal(settingsNeedAgentRestart(base(), next), true);
  next.preferences.requestTimeoutMs = 300000;
  assert.equal(settingsNeedAgentRestart(base(), next), false);
});

test('switching the active provider restarts it', () => {
  // The real failure: 设置 → 模型 switched to a new supplier, the app kept
  // answering from the previous model because the child was never respawned.
  const next = base();
  next.activeProviderId = 'mock';
  assert.equal(settingsNeedAgentRestart(base(), next), true);
});

test('editing a provider restart it', () => {
  const next = base();
  next.providers[1].baseUrl = 'https://b.example/v1';
  assert.equal(settingsNeedAgentRestart(base(), next), true);
});

test('adding or removing a provider restarts it', () => {
  const added = base();
  added.providers.push({ id: 'custom_b', type: 'custom', label: 'B', model: 'b-1', baseUrl: 'https://b.example/v1' });
  assert.equal(settingsNeedAgentRestart(base(), added), true);

  const removed = base();
  removed.providers = removed.providers.filter((p) => p.id !== 'custom_a');
  assert.equal(settingsNeedAgentRestart(base(), removed), true);
});

test('the spawn-time flags still restart it', () => {
  for (const mutate of [
    (s) => { s.approval = 'auto'; },
    (s) => { s.preferences.autoReview = true; },
    (s) => { s.preferences.computerExecutionMode = 'auto'; },
    // Computer-control toggles are argv on the CLI child too. Changing one
    // used to leave the open session running with the previous flags, so the
    // switch looked applied while the tools stayed unavailable.
    (s) => { s.preferences.computerAnyApp = true; },
    (s) => { s.preferences.computerExcel = true; },
    (s) => { s.preferences.computerAllowedApps = ['notepad.exe']; },
  ]) {
    const next = base();
    mutate(next);
    assert.equal(settingsNeedAgentRestart(base(), next), true);
  }
});

test('reordering the allowed apps restarts but the same list does not', () => {
  const withApps = (apps) => {
    const s = base();
    s.preferences.computerAllowedApps = apps;
    return s;
  };
  assert.equal(settingsNeedAgentRestart(withApps(['a.exe', 'b.exe']), withApps(['a.exe', 'b.exe'])), false);
  assert.equal(settingsNeedAgentRestart(withApps(['a.exe', 'b.exe']), withApps(['b.exe', 'a.exe'])), true);
});

test('an unrelated preference change does not restart it', () => {
  const next = base();
  next.preferences.theme = 'dark';
  assert.equal(settingsNeedAgentRestart(base(), next), false);
});
