'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectSystemInfo } = require('../electron/system-info.cjs');

test('collectSystemInfo returns a coherent diagnostics snapshot', async () => {
  const info = await collectSystemInfo({ electronVersion: '32.2.5' });
  assert.equal(info.platform, process.platform);
  assert.ok(info.cpuCores >= 1);
  assert.ok(info.totalMemBytes > 0);
  assert.ok(info.hostname.length > 0);
  assert.equal(info.nodeVersion, process.versions.node);
  assert.equal(info.electronVersion, '32.2.5');
  assert.match(info.gitVersion ?? '', /git version/i, 'git binary present on dev machines');
  if (process.platform === 'win32') {
    assert.ok(info.driveFreeBytes === null || info.driveFreeBytes > 0);
  }
});
