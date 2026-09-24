'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readdir, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createFileLogger, formatPrefix, formatArgs } = require('../electron/logger.cjs');

test('formatPrefix mirrors the upstream scope/trace/pid shape', () => {
  assert.equal(formatPrefix('git', undefined, 42), '[git] [42]');
  assert.equal(formatPrefix('git', 'abc', 42), '[git][trace:abc] [42]');
});

test('formatArgs renders strings, errors with stack, and serializable values', () => {
  assert.equal(formatArgs(['hello', 1]), 'hello 1');
  assert.ok(formatArgs([new Error('boom')]).includes('Error: boom'));
  assert.equal(formatArgs([{ a: 1 }]), '{"a":1}');
});

test('writes JSONL lines and tail() returns them in order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'log-'));
  try {
    const logger = createFileLogger({ dir, name: 'main', scope: 'ckpt', mirrorToConsole: false });
    logger.info('t1', 'creating checkpoint', { id: 7 });
    logger.warn(undefined, 'slow git op');
    logger.error('t2', new Error('failed'));
    // Writes are async; give them a beat.
    await new Promise((r) => setTimeout(r, 100));
    const lines = await logger.tail();
    assert.equal(lines.length, 3);
    const parsed = lines.map((line) => JSON.parse(line));
    assert.equal(parsed[0].level, 'info');
    assert.equal(parsed[0].traceId, 't1');
    assert.equal(parsed[0].scope, 'ckpt');
    assert.equal(parsed[0].msg, 'creating checkpoint {"id":7}');
    assert.equal(parsed[2].level, 'error');
    assert.ok(parsed[2].msg.includes('Error: failed'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotates when the active log exceeds maxBytes and prunes old rotations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'log-rot-'));
  try {
    const logger = createFileLogger({ dir, name: 'main', maxBytes: 400, keep: 2, mirrorToConsole: false });
    for (let i = 0; i < 40; i += 1) {
      logger.info(undefined, `line-${i}-${'x'.repeat(40)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.log')).sort();
    const rotations = files.filter((f) => f.startsWith('main-'));
    assert.ok(files.includes('main.log'), 'active log exists');
    assert.ok(rotations.length <= 2, `keeps at most 2 rotations, saw ${rotations.length}`);
    const active = await readFile(join(dir, 'main.log'), 'utf-8');
    assert.ok(active.length < 400 + 200, 'active log restarted after rotation');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
