'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createResourceSampler, parseCpuTimeText } = require('../electron/resource-sampler.cjs');

test('parseCpuTimeText handles the documented shapes', () => {
  assert.equal(parseCpuTimeText('01:02'), 62_000);
  assert.equal(parseCpuTimeText('01:02.50'), 62_500);
  assert.equal(parseCpuTimeText('1:01:02'), 3_662_000);
  assert.equal(parseCpuTimeText('1-01:02:03'), 90_123_000);
  assert.equal(parseCpuTimeText(''), undefined);
  assert.equal(parseCpuTimeText('garbage'), undefined);
});

test('sampler reports rss for a live child and deltas cpu on the second sample', async () => {
  const busy = spawn(process.execPath, ['-e', 'let x=0; setInterval(()=>{for(let i=0;i<1e6;i++)x+=i;},20);'], { stdio: 'ignore' });
  const sampler = createResourceSampler({ rootPid: busy.pid });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const first = await sampler.sample();
    assert.equal(first.pid, busy.pid);
    assert.ok(first.rssKb > 0, 'rss observed');
    assert.ok(first.processCount >= 1);
    assert.equal(first.cpuPercent, null, 'first sample establishes the baseline only');

    await new Promise((r) => setTimeout(r, 700));
    const second = await sampler.sample();
    assert.ok(second.cpuPercent !== null);
    assert.ok(second.cpuPercent >= 0);
    assert.ok(second.rssKb > 0);
  } finally {
    busy.kill('SIGKILL');
  }
});

test('sampler loses the baseline after the TTL so recycled pids start fresh', async () => {
  const idle = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);'], { stdio: 'ignore' });
  const sampler = createResourceSampler({ rootPid: idle.pid, baselineTtlMs: 50 });
  try {
    await new Promise((r) => setTimeout(r, 200));
    await sampler.sample();
    await new Promise((r) => setTimeout(r, 200));
    const afterTtl = await sampler.sample();
    assert.equal(afterTtl.cpuPercent, null, 'expired baseline re-anchors instead of extrapolating');
    sampler.reset();
  } finally {
    idle.kill('SIGKILL');
  }
});
