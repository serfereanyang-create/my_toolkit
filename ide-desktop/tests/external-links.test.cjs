'use strict';

/** The URL gate used by every path that hands a link to the OS.
 *
 *  Transcript content — model output, tool output, file names — can put
 *  arbitrary links in front of the user. shell.openExternal launches whatever
 *  handler a scheme is registered to, so a `file:///` link opens a local file
 *  in its default app and a custom scheme launches the registered program.
 *  Both the will-navigate and window-open paths must allow only http(s).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isExternalWebUrl } = require('../electron/external-links.cjs');

test('allows ordinary web URLs', () => {
  assert.equal(isExternalWebUrl('https://example.com/a?b=1'), true);
  assert.equal(isExternalWebUrl('http://127.0.0.1:5174'), true);
  assert.equal(isExternalWebUrl('HTTPS://Example.com'), true);
});

test('refuses local files and custom schemes', () => {
  assert.equal(isExternalWebUrl('file:///C:/Windows/System32/calc.exe'), false);
  assert.equal(isExternalWebUrl('file:///etc/passwd'), false);
  assert.equal(isExternalWebUrl('ms-settings:privacy'), false);
  assert.equal(isExternalWebUrl('javascript:alert(1)'), false);
  assert.equal(isExternalWebUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isExternalWebUrl('shell:startup'), false);
  assert.equal(isExternalWebUrl('smb://host/share'), false);
});

test('refuses empty and unparseable input', () => {
  assert.equal(isExternalWebUrl(''), false);
  assert.equal(isExternalWebUrl(undefined), false);
  assert.equal(isExternalWebUrl(null), false);
  assert.equal(isExternalWebUrl(42), false);
  assert.equal(isExternalWebUrl('not a url'), false);
});

test('main.cjs uses the shared gate on both URL paths', () => {
  // A second inline /^https?:/ test would drift from this rule again; the
  // regression is a helper that exists but is not actually wired up.
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  assert.equal(source.includes("require('./external-links.cjs')"), true);
  assert.equal(source.includes('if (isExternalWebUrl(target))'), true);
  assert.equal(source.includes('if (isExternalWebUrl(url))'), true);
  assert.equal(/shell\.openExternal\(target/.test(source), true);
});
