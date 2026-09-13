const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { searchSessions } = require('../electron/session-search.cjs');

async function fixture(sessions) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zcode-ssearch-'));
  const sessionsDir = path.join(dir, '.aicode', 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  for (const [id, record] of Object.entries(sessions)) {
    await writeFile(path.join(sessionsDir, `${id}.json`), JSON.stringify(record), 'utf8');
  }
  return { dir, sessionsDir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function rec(messages, extra = {}) {
  return {
    id: 'x',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
    model: 'mock-v1',
    messages,
    ...extra,
  };
}

test('empty sessions directory yields an empty result set', async () => {
  const fx = await fixture({});
  try {
    const out = await searchSessions(fx.sessionsDir, 'anything');
    assert.equal(out.results.length, 0);
    assert.equal(out.sessionsScanned, 0);
  } finally { await fx.cleanup(); }
});

test('missing directory resolves to zero (never throws)', async () => {
  const out = await searchSessions('/definitely/not/here', 'x');
  assert.deepEqual(out.results, []);
});

test('finds literal matches in user and assistant roles', async () => {
  const fx = await fixture({
    hit: rec([
      { role: 'user', content: '帮我修复登录 bug' },
      { role: 'assistant', content: '先看登录日志再改' },
    ]),
    miss: rec([{ role: 'user', content: '无关内容' }]),
  });
  try {
    const out = await searchSessions(fx.sessionsDir, '登录');
    assert.equal(out.results.length, 1);
    const found = out.results[0];
    assert.equal(found.sessionId, 'hit');
    assert.equal(found.hitCount, 2);
    assert.equal(found.hits[0].role, 'user');
    assert.ok(found.hits[0].context.some((l) => l.matched));
  } finally { await fx.cleanup(); }
});

test('role filter restricts which messages count', async () => {
  const fx = await fixture({
    s: rec([
      { role: 'user', content: 'deploy the app' },
      { role: 'assistant', content: 'deploying now' },
    ]),
  });
  try {
    const onlyUser = await searchSessions(fx.sessionsDir, 'deploy', { roles: ['user'] });
    assert.equal(onlyUser.results[0].hitCount, 1);
    const onlyAssistant = await searchSessions(fx.sessionsDir, 'deploy', { roles: ['assistant'] });
    assert.equal(onlyAssistant.results[0].hits[0].role, 'assistant');
  } finally { await fx.cleanup(); }
});

test('case-insensitive by default; caseSensitive tightens it', async () => {
  const fx = await fixture({ s: rec([{ role: 'user', content: 'TODO todo Todo' }]) });
  try {
    assert.equal((await searchSessions(fx.sessionsDir, 'todo')).results[0].hitCount, 1); // one matched LINE (per-message dedupe counts lines)
    const strict = await searchSessions(fx.sessionsDir, 'TODO', { caseSensitive: true });
    assert.equal(strict.results[0].hits[0].matchedText, 'TODO');
  } finally { await fx.cleanup(); }
});

test('whole-word mode skips substrings', async () => {
  const fx = await fixture({ s: rec([{ role: 'user', content: 'catalog cat' }]) });
  try {
    const loose = await searchSessions(fx.sessionsDir, 'cat');
    assert.equal(loose.results.length, 1); // one matched line either way
    const whole = await searchSessions(fx.sessionsDir, 'cat', { wholeWord: true });
    assert.equal(whole.results[0].hits[0].matchedText, 'cat');
    const none = await searchSessions(fx.sessionsDir, 'catalogg', { wholeWord: true });
    assert.equal(none.results.length, 0);
  } finally { await fx.cleanup(); }
});

test('regex mode works and rejects invalid patterns', async () => {
  const fx = await fixture({ s: rec([{ role: 'user', content: 'code 42 and 7' }]) });
  try {
    const out = await searchSessions(fx.sessionsDir, '\\d+', { regex: true });
    assert.equal(out.results[0].hits[0].matchedText, '42');
    await assert.rejects(() => searchSessions(fx.sessionsDir, '(', { regex: true }), /无效的正则表达式/);
  } finally { await fx.cleanup(); }
});

test('multi-line messages expose surrounding context lines', async () => {
  const content = ['line1', 'line2', 'target here', 'line4', 'line5'].join('\n');
  const fx = await fixture({ s: rec([{ role: 'assistant', content }]) });
  try {
    const out = await searchSessions(fx.sessionsDir, 'target');
    const hit = out.results[0].hits[0];
    assert.equal(hit.lineNo ?? hit.context.find((l) => l.matched).line, 3);
    assert.equal(hit.context.length, 3); // lines 2..4
  } finally { await fx.cleanup(); }
});

test('results rank by hit count then recency', async () => {
  const fx = await fixture({
    few: rec([{ role: 'user', content: 'needle one' }], { updatedAt: '2026-09-20T00:00:00Z' }),
    many: rec([
      { role: 'user', content: 'needle one' },
      { role: 'user', content: 'needle two' },
      { role: 'user', content: 'needle three' },
    ], { updatedAt: '2026-09-05T00:00:00Z' }),
  });
  try {
    const out = await searchSessions(fx.sessionsDir, 'needle');
    assert.deepEqual(out.results.map((r) => r.sessionId), ['many', 'few']);
  } finally { await fx.cleanup(); }
});

test('corrupt session files are skipped and counted', async () => {
  const fx = await fixture({ good: rec([{ role: 'user', content: 'needle' }]) });
  try {
    await writeFile(path.join(fx.sessionsDir, 'bad.json'), '{{{ not json', 'utf8');
    const out = await searchSessions(fx.sessionsDir, 'needle');
    assert.equal(out.results.length, 1);
    assert.equal(out.corrupted, 1);
  } finally { await fx.cleanup(); }
});

test('maxResults truncates the scan', async () => {
  const many = {};
  for (let i = 0; i < 6; i += 1) many[`s${i}`] = rec([{ role: 'user', content: `hit ${i} needle` }]);
  const fx = await fixture(many);
  try {
    const out = await searchSessions(fx.sessionsDir, 'needle', { maxResults: 3 });
    assert.equal(out.results.length, 3);
    assert.equal(out.truncated, true);
  } finally { await fx.cleanup(); }
});

test('system and tool roles excluded by default', async () => {
  const fx = await fixture({
    s: rec([
      { role: 'system', content: 'needle in system prompt' },
      { role: 'tool', content: 'needle in tool output' },
      { role: 'user', content: 'real needle' },
    ]),
  });
  try {
    const out = await searchSessions(fx.sessionsDir, 'needle');
    assert.equal(out.results[0].hitCount, 1);
    assert.equal(out.results[0].hits[0].role, 'user');
  } finally { await fx.cleanup(); }
});

test('oversized messages are skipped (scan budget)', async () => {
  const huge = 'needle ' + 'x'.repeat(401_000);
  const fx = await fixture({ big: rec([{ role: 'user', content: huge }]) });
  try {
    const out = await searchSessions(fx.sessionsDir, 'needle');
    assert.equal(out.results.length, 0);
  } finally { await fx.cleanup(); }
});
