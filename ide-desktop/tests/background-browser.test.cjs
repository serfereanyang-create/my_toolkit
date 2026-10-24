'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createBackgroundBrowserService,
  buildInspectScript,
  buildClickScript,
  buildFillScript,
  buildKeyScript,
  buildLinksScript,
  sanitizeDownloadName,
} = require('../electron/background-browser.cjs');

/*
 * The hidden-browser host has two halves. Its Electron half (a real offscreen
 * window) is exercised end to end by scripts/, because loading Electron inside
 * `node --test` is not possible. What is covered here is everything that must
 * hold *before* a page is ever created: the security boundary and the page-side
 * scripts. Those are the parts where a mistake is a real vulnerability rather
 * than a mis-rendered page, and they are pure functions, so they can be pinned
 * in the default test run.
 */

async function workspace() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'bg-browser-'));
}

test('refuses a non-http(s) url rather than loading it', async () => {
  const svc = createBackgroundBrowserService();
  const ws = await workspace();
  try {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<h1>x</h1>']) {
      const result = await svc.execute({ sessionId: 's', workspaceRoot: ws, tool: 'background_browser_open', input: { url } });
      assert.equal(result.ok, false, `${url} must not be opened`);
      assert.match(result.output, /http/);
    }
  } finally {
    await svc.disposeAll();
  }
});

test('refuses a url carrying credentials', async () => {
  const svc = createBackgroundBrowserService();
  try {
    const result = await svc.execute({
      sessionId: 's', workspaceRoot: await workspace(),
      tool: 'background_browser_open',
      input: { url: 'https://user:secret@example.com/' },
    });
    assert.equal(result.ok, false);
    assert.match(result.output, /凭据/);
  } finally {
    await svc.disposeAll();
  }
});

test('refuses a malformed url', async () => {
  const svc = createBackgroundBrowserService();
  try {
    const result = await svc.execute({
      sessionId: 's', workspaceRoot: await workspace(),
      tool: 'background_browser_open', input: { url: 'not a url' },
    });
    assert.equal(result.ok, false);
    assert.match(result.output, /无效|网址/);
  } finally {
    await svc.disposeAll();
  }
});

test('only opens workspace .html/.htm files, never other files', async () => {
  const svc = createBackgroundBrowserService();
  const ws = await workspace();
  try {
    await fs.writeFile(path.join(ws, 'notes.txt'), 'plain text');
    await fs.writeFile(path.join(ws, 'app.js'), 'console.log(1)');
    for (const name of ['notes.txt', 'app.js']) {
      const result = await svc.execute({ sessionId: 's', workspaceRoot: ws, tool: 'background_browser_open', input: { path: name } });
      assert.equal(result.ok, false, `${name} must not be opened`);
      assert.match(result.output, /html/);
    }
  } finally {
    await svc.disposeAll();
  }
});

test('refuses paths that escape the workspace', async () => {
  const svc = createBackgroundBrowserService();
  const ws = await workspace();
  try {
    for (const candidate of ['../outside.html', '../../etc/passwd', 'a/../../b.html']) {
      const result = await svc.execute({ sessionId: 's', workspaceRoot: ws, tool: 'background_browser_open', input: { path: candidate } });
      assert.equal(result.ok, false, `${candidate} must not be opened`);
    }
  } finally {
    await svc.disposeAll();
  }
});

test('refuses absolute paths outside the workspace', async () => {
  const svc = createBackgroundBrowserService();
  const ws = await workspace();
  try {
    const outside = path.join(os.tmpdir(), 'bg-outside.html');
    await fs.writeFile(outside, '<h1>outside</h1>');
    const result = await svc.execute({ sessionId: 's', workspaceRoot: ws, tool: 'background_browser_open', input: { path: outside } });
    assert.equal(result.ok, false);
  } finally {
    await svc.disposeAll();
  }
});

test('refuses an unknown tool instead of silently doing nothing', async () => {
  const svc = createBackgroundBrowserService();
  try {
    const result = await svc.execute({
      sessionId: 's', workspaceRoot: await workspace(),
      tool: 'background_browser_eval', input: { code: 'process.exit(1)' },
    });
    assert.equal(result.ok, false);
    assert.match(result.output, /不支持/);
  } finally {
    await svc.disposeAll();
  }
});

test('a browser id from another conversation is never usable', async () => {
  const svc = createBackgroundBrowserService();
  try {
    // No page was ever opened, so the id cannot belong to this conversation.
    const result = await svc.execute({
      sessionId: 'sess-A', workspaceRoot: await workspace(),
      tool: 'background_browser_inspect', input: { browserId: 'browser_deadbeef' },
    });
    assert.equal(result.ok, false);
    assert.match(result.output, /不属于该会话|已关闭/);
  } finally {
    await svc.disposeAll();
  }
});

test('status starts empty and reports no pages for an unknown conversation', async () => {
  const svc = createBackgroundBrowserService();
  try {
    assert.deepEqual(svc.status(), []);
    await svc.closeSession('never-opened'); // must not throw
    assert.deepEqual(svc.status(), []);
  } finally {
    await svc.disposeAll();
  }
});

test('a disposed service refuses further work', async () => {
  const svc = createBackgroundBrowserService();
  svc.dispose();
  const result = await svc.execute({
    sessionId: 's', workspaceRoot: await workspace(),
    tool: 'background_browser_open', input: { url: 'https://example.com/' },
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /退出/);
});

test('an error is reported as output, never thrown across the bridge', async () => {
  const svc = createBackgroundBrowserService();
  try {
    // Every failure path must resolve to { ok: false, output } — a rejected
    // promise here would leave the CLI waiting out its host-tool timeout.
    const result = await svc.execute({ sessionId: 's', workspaceRoot: 'C:/definitely/not/a/workspace', tool: 'background_browser_open', input: { path: 'page.html' } });
    assert.equal(result.ok, false);
    assert.equal(typeof result.output, 'string');
    assert.ok(result.output.length > 0);
  } finally {
    await svc.disposeAll();
  }
});

test('page-side scripts embed caller strings as JSON, never as code', () => {
  // A selector that would break out of a naive quoted interpolation.
  const hostile = "'; require('child_process').execSync('calc'); //";
  const scripts = [
    buildClickScript(hostile, 'left', false),
    buildFillScript(hostile, hostile),
    buildKeyScript('Enter', hostile),
  ];
  for (const script of scripts) {
    // The value appears JSON-encoded, so its quotes are escaped rather than
    // terminating the string literal.
    assert.ok(script.includes(JSON.stringify(hostile)), 'selector must be JSON-encoded');
    assert.ok(!script.includes(`'${hostile}'`), 'selector must not be raw-quoted');
  }
});

test('the inspect script clamps its element limit to a safe integer', () => {
  assert.ok(buildInspectScript(5).includes('const limit = 5;'));
  // A non-integer falls back to the default rather than being interpolated.
  assert.ok(!buildInspectScript(Number.NaN).includes('NaN'));
  assert.ok(!buildInspectScript('999').includes('999;'));
});

test('the key script only describes a DOM event, never a native shortcut', () => {
  const script = buildKeyScript('Control+A', '#field');
  assert.ok(script.includes('KeyboardEvent'));
  assert.ok(!/sendInputEvent|robotjs|child_process/.test(script));
});

/*
 * Downloads and navigation — the "browse a site, get the file, analyse it"
 * path. What is pinned here is the part a mistake would turn into a security
 * bug or a silent data loss: where a downloaded file may be written and under
 * what name. The transfer itself needs a real offscreen window, so it is
 * covered by scripts/bg-download-smoke.cjs.
 */

test('a download name can never escape the downloads directory', () => {
  // `getFilename()` comes from the server's Content-Disposition, so it is
  // attacker-controlled. A traversal segment here would write a file the agent
  // chose the path of — e.g. a session record.
  const backslash = String.fromCharCode(92);
  for (const hostile of ['../../.aicode/sessions/x.json', `..${backslash}..${backslash}secret.txt`, '/etc/passwd', `C:${backslash}evil${backslash}a.pdf`]) {
    const name = sanitizeDownloadName(hostile);
    assert.ok(!name.includes('/'), `${hostile} -> ${name}`);
    assert.ok(!name.includes(backslash), `${hostile} -> ${name}`);
    assert.ok(!name.startsWith('.'), `${hostile} -> ${name}`);
    assert.ok(!path.isAbsolute(name), `${hostile} -> ${name}`);
  }
});

test('a download keeps an ordinary filename intact', () => {
  assert.equal(sanitizeDownloadName('paper.pdf'), 'paper.pdf');
  assert.equal(sanitizeDownloadName('2024 年报 (final).pdf'), '2024 年报 (final).pdf');
});

test('an unusable download name falls back to a generated one', () => {
  for (const empty of ['', '   ', '..', '/']) {
    const name = sanitizeDownloadName(empty);
    assert.match(name, /^download-\d+-[0-9a-f]+$/);
  }
});

test('a caller-suggested name is used but is still sanitised', () => {
  assert.equal(sanitizeDownloadName('91-1706.03762v7.pdf', 'attention.pdf'), 'attention.pdf');
  assert.equal(sanitizeDownloadName('x', '../escape.pdf'), 'escape.pdf');
});

test('the links script resolves absolute hrefs and drops other schemes', () => {
  const script = buildLinksScript(10);
  // The href comes from the page, so only http(s) may be reported back and the
  // limit must be a validated integer rather than an interpolated string.
  assert.ok(script.includes('https?:'));
  assert.ok(script.includes('>= 10'));
  assert.ok(!buildLinksScript(Number.NaN).includes('NaN'));
  assert.ok(!script.includes('document.write'));
});
