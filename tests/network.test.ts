import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideApproval, evaluateNetworkTarget } from '../src/safety/policy.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { htmlToText } from '../src/tools/web.js';

const ALLOWLIST = ['wikipedia.org', 'api.github.com'];

test('evaluateNetworkTarget allows allowlisted host and subdomains', () => {
  assert.equal(evaluateNetworkTarget('https://api.github.com/repos/nodejs/node', ALLOWLIST).ok, true);
  assert.equal(evaluateNetworkTarget('https://zh.wikipedia.org/wiki/Node', ALLOWLIST).ok, true);
});

test('evaluateNetworkTarget rejects hosts outside the allowlist', () => {
  const verdict = evaluateNetworkTarget('https://evil.example.com/', ALLOWLIST);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /allowlist/);
});

test('evaluateNetworkTarget blocks SSRF targets (loopback, private, metadata)', () => {
  const ssrf = [
    'http://127.0.0.1/',
    'http://localhost/',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://[::1]/',
  ];
  for (const url of ssrf) {
    const verdict = evaluateNetworkTarget(url, ['127.0.0.1', 'localhost', '169.254.169.254', '10.0.0.5', '192.168.1.1', '172.16.0.1', '::1']);
    assert.equal(verdict.ok, false, `${url} should be blocked even if allowlisted`);
    assert.match(verdict.reason, /SSRF/);
  }
});

test('evaluateNetworkTarget rejects non-http protocols and bad URLs', () => {
  assert.equal(evaluateNetworkTarget('ftp://api.github.com/', ALLOWLIST).ok, false);
  assert.equal(evaluateNetworkTarget('file:///etc/passwd', ALLOWLIST).ok, false);
  assert.equal(evaluateNetworkTarget('not a url', ALLOWLIST).ok, false);
});

test('decideApproval gates network by mode and allowlist', () => {
  const base = { risk: 'network' as const, workspaceRoot: process.cwd(), networkAllowlist: ALLOWLIST };
  // auto + allowlisted host → runs without prompt
  const auto = decideApproval({ ...base, mode: 'auto', url: 'https://api.github.com/x' });
  assert.equal(auto.allowed, true);
  assert.equal(auto.needsPrompt, false);
  // ask + allowlisted host → prompts
  const ask = decideApproval({ ...base, mode: 'ask', url: 'https://api.github.com/x' });
  assert.equal(ask.allowed, true);
  assert.equal(ask.needsPrompt, true);
  // auto + non-allowlisted → blocked
  const blocked = decideApproval({ ...base, mode: 'auto', url: 'https://evil.example.com/' });
  assert.equal(blocked.allowed, false);
  // deny mode → blocked regardless
  const deny = decideApproval({ ...base, mode: 'deny', url: 'https://api.github.com/x' });
  assert.equal(deny.allowed, false);
});

test('fetch_url is blocked by the registry when host is not allowlisted', async () => {
  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    'fetch_url',
    { url: 'https://evil.example.com/' },
    { workspaceRoot: process.cwd(), approval: 'auto', networkAllowlist: ALLOWLIST },
  );
  assert.equal(result.ok, false);
  assert.match(result.output, /blocked|allowlist/i);
});

test('fetch_url is blocked by the registry for SSRF targets even if allowlisted', async () => {
  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    'fetch_url',
    { url: 'http://169.254.169.254/latest/meta-data/' },
    { workspaceRoot: process.cwd(), approval: 'auto', networkAllowlist: ['169.254.169.254'] },
  );
  assert.equal(result.ok, false);
  assert.match(result.output, /SSRF|blocked/i);
});

test('fetch_url rejects invalid input at validate', async () => {
  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    'fetch_url',
    { url: '' },
    { workspaceRoot: process.cwd(), approval: 'auto', networkAllowlist: ALLOWLIST },
  );
  assert.equal(result.ok, false);
});

test('download_file passes the same network gate as fetch_url', async () => {
  // download_file is now reachable from the compact scope, so the gate is the
  // only thing standing between a small prompt and an arbitrary outbound
  // request. It must refuse exactly as fetch_url does.
  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    'download_file',
    { url: 'https://evil.example.com/paper.pdf', to: 'downloads/paper.pdf' },
    { workspaceRoot: process.cwd(), approval: 'auto', networkAllowlist: ALLOWLIST },
  );
  assert.equal(result.ok, false);
  assert.match(result.output, /blocked|allowlist/i);
});

test('download_file refuses an SSRF target even when it is allowlisted', async () => {
  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    'download_file',
    { url: 'http://169.254.169.254/latest/meta-data/', to: 'downloads/meta.json' },
    { workspaceRoot: process.cwd(), approval: 'auto', networkAllowlist: ['169.254.169.254'] },
  );
  assert.equal(result.ok, false);
  assert.match(result.output, /SSRF|blocked/i);
});

test('htmlToText strips tags/scripts and decodes entities', () => {
  const html = '<html><head><style>.x{color:red}</style></head><body><h1>Title</h1><script>evil()</script><p>Hello&nbsp;&amp; welcome</p><ul><li>one</li><li>two</li></ul></body></html>';
  const text = htmlToText(html);
  assert.match(text, /Title/);
  assert.match(text, /Hello & welcome/);
  assert.match(text, /- one/);
  assert.match(text, /- two/);
  assert.doesNotMatch(text, /evil\(\)/); // script content removed
  assert.doesNotMatch(text, /color:red/); // style content removed
  assert.doesNotMatch(text, /</); // no residual tags
});
