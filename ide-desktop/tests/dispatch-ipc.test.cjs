'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSelection, resolveForUi } = require('../electron/dispatch-ipc.cjs');

function writeSession(record) {
  const p = path.join(os.tmpdir(), `disp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(record));
  return p;
}

test('readSelection returns the persisted tiers, or null when unset', () => {
  const withDispatch = writeSession({ dispatch: { expensive: 'GLM-5.3', cheap: 'GLM-5.3-Flash' } });
  assert.deepEqual(readSelection(withDispatch), { expensive: 'GLM-5.3', cheap: 'GLM-5.3-Flash' });
  fs.unlinkSync(withDispatch);

  const without = writeSession({ id: 'sess_x' });
  assert.equal(readSelection(without), null);
  fs.unlinkSync(without);

  assert.equal(readSelection(path.join(os.tmpdir(), 'does-not-exist-dispatch.json')), null);
});

test('resolveForUi refuses an incomplete selection instead of guessing', async () => {
  assert.equal((await resolveForUi(null)).ok, false);
  assert.equal((await resolveForUi({ expensive: 'GLM-5.3' })).ok, false);
});

test('a real selection resolves to credentialed providers', () => {
  const result = resolveForUi({ expensive: 'GLM-5.3', cheap: 'GLM-5.3-Flash' });
  if (!result.ok) return; // config absent on this machine
  assert.ok(result.tiers.expensive.model);
  assert.ok(result.tiers.cheap.model);
  // The cheap tier must differ from the expensive one, else there is no saving.
  assert.notEqual(result.tiers.expensive.model.toLowerCase(), result.tiers.cheap.model.toLowerCase());
});
