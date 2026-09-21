const assert = require('node:assert/strict');
const { test } = require('node:test');
const { BridgeRegistry } = require('../electron/bridge-registry.cjs');

/*
 * The registry is what makes several conversations run at once. Its predecessor
 * was a single `bridge` variable that `startNow` disposed before spawning the
 * next, which is why opening another conversation killed the running task.
 */

function fakeBridge(id = 'bridge') {
  return { id, child: { pid: 1 }, dispose() {} };
}

test('adopts a pending bridge under the session it announces', () => {
  const registry = new BridgeRegistry();
  const bridge = fakeBridge();
  registry.addPending(bridge);
  assert.equal(registry.get('sess_a'), undefined, 'a pending bridge has no session yet');

  assert.equal(registry.adopt(bridge, 'sess_a'), true);
  assert.equal(registry.get('sess_a'), bridge);
  assert.equal(registry.sessionOf(bridge), 'sess_a');
  assert.equal(registry.size, 1);
});

test('keeps several sessions apart', () => {
  const registry = new BridgeRegistry();
  const a = registry.addPending(fakeBridge('a'));
  const b = registry.addPending(fakeBridge('b'));
  registry.adopt(a, 'sess_a');
  registry.adopt(b, 'sess_b');

  assert.equal(registry.get('sess_a'), a);
  assert.equal(registry.get('sess_b'), b);
  assert.equal(registry.size, 2);
});

test('refuses to adopt a bridge that was not pending', () => {
  // A duplicate bridge_ready, or one arriving after disposal, must not be able
  // to replace a live bridge with a dead child.
  const registry = new BridgeRegistry();
  const live = registry.addPending(fakeBridge('live'));
  registry.adopt(live, 'sess_a');

  const impostor = fakeBridge('impostor');
  assert.equal(registry.adopt(impostor, 'sess_a'), false);
  assert.equal(registry.get('sess_a'), live, 'the live bridge must survive');
});

test('get without an id returns the sole bridge and nothing when ambiguous', () => {
  const registry = new BridgeRegistry();
  const a = registry.addPending(fakeBridge('a'));
  registry.adopt(a, 'sess_a');
  // One bridge: an un-addressed caller still works (pre-existing behaviour).
  assert.equal(registry.get(), a);
  assert.equal(registry.get(undefined), a);

  const b = registry.addPending(fakeBridge('b'));
  registry.adopt(b, 'sess_b');
  // Two bridges: guessing would address the wrong conversation, so refuse.
  assert.equal(registry.get(), undefined);
  assert.equal(registry.get('sess_a'), a);
});

test('has() reports whether a session already has a bridge', () => {
  const registry = new BridgeRegistry();
  assert.equal(registry.has('sess_a'), false);
  const a = registry.addPending(fakeBridge('a'));
  registry.adopt(a, 'sess_a');
  assert.equal(registry.has('sess_a'), true);
  assert.equal(registry.has('sess_b'), false);
});

test('remove() forgets one session and leaves the rest', () => {
  const registry = new BridgeRegistry();
  const a = registry.addPending(fakeBridge('a'));
  const b = registry.addPending(fakeBridge('b'));
  registry.adopt(a, 'sess_a');
  registry.adopt(b, 'sess_b');

  assert.equal(registry.remove('sess_a'), a);
  assert.equal(registry.get('sess_a'), undefined);
  assert.equal(registry.get('sess_b'), b, 'removing one must not disturb another');
});

test('removeBridge() forgets by instance, including a pending one', () => {
  const registry = new BridgeRegistry();
  const a = registry.addPending(fakeBridge('a'));
  registry.adopt(a, 'sess_a');
  assert.equal(registry.removeBridge(a), 'sess_a');
  assert.equal(registry.size, 0);

  // A bridge that died before announcing its session is still tracked.
  const pending = registry.addPending(fakeBridge('p'));
  assert.equal(registry.removeBridge(pending), undefined);
  assert.equal(registry.all().includes(pending), false, 'a dead pending bridge must not linger');
});

test('all() covers live and pending bridges, for a bulk dispose', () => {
  const registry = new BridgeRegistry();
  const a = registry.addPending(fakeBridge('a'));
  registry.adopt(a, 'sess_a');
  const pending = registry.addPending(fakeBridge('p'));

  const all = registry.all();
  assert.equal(all.length, 2);
  assert.ok(all.includes(a));
  assert.ok(all.includes(pending));

  registry.clear();
  assert.equal(registry.all().length, 0);
  assert.equal(registry.size, 0);
});
