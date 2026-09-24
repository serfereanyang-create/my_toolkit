'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { analyzeSessionsDir, deleteSessionFiles, hasRealUserMessage } = require('../electron/session-cleanup.cjs');

async function makeSessionsDir(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sessclean-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content), 'utf-8');
  }
  return dir;
}

const emptySession = { id: 'sess_a', messages: [] };
const systemOnlySession = { id: 'sess_b', messages: [{ role: 'system', content: 'you are an agent' }] };
const forkMarkerSession = { id: 'sess_c', messages: [{ role: 'user', content: '[forked from x] 以上是继承自原会话的历史记录，请在此基础上继续。' }] };
const realSession = { id: 'sess_d', messages: [{ role: 'user', content: '你好' }] };
const pinnedEmpty = { id: 'sess_e', messages: [], pinned: true };

test('hasRealUserMessage requires non-empty user text', () => {
  assert.equal(hasRealUserMessage(emptySession), false);
  assert.equal(hasRealUserMessage(forkMarkerSession), true, 'a user message is a user message — plan says keep');
  assert.equal(hasRealUserMessage(realSession), true);
});

test('analysis classifies sessions and never candidates pinned or broken files', async () => {
  const dir = await makeSessionsDir({
    'sess_a.json': emptySession,
    'sess_b.json': systemOnlySession,
    'sess_c.json': forkMarkerSession,
    'sess_d.json': realSession,
    'sess_e.json': pinnedEmpty,
    'sess_broken.json': '{not json',
    'other.json': { id: 'nope' },
  });
  try {
    const analysis = await analyzeSessionsDir(dir);
    assert.equal(analysis.total, 6, 'sess_* files counted, other.json ignored');
    assert.equal(analysis.empty, 1);
    assert.equal(analysis.systemOnly, 1, 'system-only sessions count as system-only');
    assert.equal(analysis.withContent, 2, 'real session and the fork-marker session');
    assert.equal(analysis.parseFailed, 1, 'broken file kept and counted');
    assert.equal(analysis.pinnedEmpty, 1);
    const candidateIds = analysis.candidates.map((c) => c.id).sort();
    assert.deepEqual(candidateIds, ['sess_a', 'sess_b']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deletion only removes files that are still safe candidates', async () => {
  const dir = await makeSessionsDir({
    'sess_a.json': emptySession,
    'sess_d.json': realSession,
    'sess_e.json': pinnedEmpty,
    'sess_broken.json': '{not json',
    'sess_f.json': { id: 'sess_f', messages: [] },
  });
  try {
    const result = await deleteSessionFiles(dir, ['sess_a', 'sess_d', 'sess_e', 'sess_broken', 'sess_f', 'junk-id']);
    assert.deepEqual(result.deleted.sort(), ['sess_a', 'sess_f']);
    assert.equal(result.skipped.find((s) => s.id === 'sess_d').reason, 'has-content');
    assert.equal(result.skipped.find((s) => s.id === 'sess_e').reason, 'pinned');
    assert.equal(result.skipped.find((s) => s.id === 'sess_broken').reason, 'parse-failed');
    assert.equal(result.skipped.find((s) => s.id === 'junk-id').reason, 'invalid-id');
    const remaining = (await fs.readdir(dir)).filter((f) => f.startsWith('sess_')).sort();
    assert.deepEqual(remaining, ['sess_broken.json', 'sess_d.json', 'sess_e.json']);
    assert.ok(result.freedBytes > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a session that gained content between analysis and deletion is skipped', async () => {
  const dir = await makeSessionsDir({ 'sess_a.json': emptySession });
  try {
    // Analyze, then the user sends a message before deletion happens.
    const analysis = await analyzeSessionsDir(dir);
    assert.equal(analysis.candidates.length, 1);
    await fs.writeFile(path.join(dir, 'sess_a.json'), JSON.stringify(realSession), 'utf-8');
    const result = await deleteSessionFiles(dir, ['sess_a']);
    assert.deepEqual(result.deleted, []);
    assert.equal(result.skipped[0].reason, 'has-content');
    assert.ok(await fs.stat(path.join(dir, 'sess_a.json')), 'file survives');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
