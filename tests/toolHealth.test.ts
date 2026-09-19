import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolHealthTracker } from '../src/agent/toolHealth.js';

test('consecutive failures trip the breaker and cooldown expires', () => {
  const tracker = new ToolHealthTracker({ threshold: 3, cooldownMs: 1000 });
  const t0 = Date.now();
  tracker.observe('read_file', false);
  tracker.observe('read_file', false);
  assert.equal(tracker.inCooldown('read_file', t0), false, '2 次失败不熔断');
  tracker.observe('read_file', false);
  assert.equal(tracker.inCooldown('read_file', Date.now()), true, '第 3 次连败触发');
  // 冷却到期（注入未来时点）自动恢复
  assert.equal(tracker.inCooldown('read_file', Date.now() + 5_000), false);
});

test('a success resets the consecutive counter', () => {
  const tracker = new ToolHealthTracker({ threshold: 3, cooldownMs: 1000 });
  tracker.observe('tool_x', false);
  tracker.observe('tool_x', false);
  tracker.observe('tool_x', true);
  tracker.observe('tool_x', false);
  tracker.observe('tool_x', false);
  assert.equal(tracker.inCooldown('tool_x', Date.now()), false, '成功清零后需要再连败 3 次');
  tracker.observe('tool_x', false);
  assert.equal(tracker.inCooldown('tool_x', Date.now()), true);
});

test('snapshot and hints reflect aggregate health', () => {
  const tracker = new ToolHealthTracker({ threshold: 2, cooldownMs: 60_000 });
  tracker.observe('bad_tool', false);
  tracker.observe('bad_tool', false);
  tracker.observe('good_tool', true);
  const snap = tracker.snapshot(Date.now());
  const bad = snap.find((s) => s.tool === 'bad_tool')!;
  assert.equal(bad.failures, 2);
  assert.equal(bad.calls, 2);
  assert.equal(bad.failureRate, 1);
  assert.ok(bad.cooldownRemainingMs > 0);
  const good = snap.find((s) => s.tool === 'good_tool')!;
  assert.equal(good.failureRate, 0);
  const hints = tracker.failureHints();
  assert.equal(hints.length, 1);
  assert.match(hints[0]!, /bad_tool.*2\/2/);
  assert.match(hints[0]!, /冷却中/);
});

test('cooldownMessage names the tool and advises rerouting', () => {
  const tracker = new ToolHealthTracker({ threshold: 1, cooldownMs: 5_000 });
  tracker.observe('run_command', false);
  const message = tracker.cooldownMessage('run_command', Date.now());
  assert.match(message, /run_command/);
  assert.match(message, /熔断/);
  assert.match(message, /不要重复调用/);
});
