import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeEnvProxy,
  hostBypassesProxy,
  normalizeProxyUrl,
  proxyFromEnv,
  resolveProxy,
} from '../src/utils/proxy.js';
import { explainNetworkFailure } from '../src/utils/net.js';
import { DEFAULT_NETWORK_ALLOWLIST } from '../src/config/config.js';

/*
 * The bug these cover: fetch() in Node ignores HTTPS_PROXY unless node was
 * started with --use-env-proxy, so every web tool went direct and failed with
 * UND_ERR_CONNECT_TIMEOUT on machines that need a proxy. Proxy resolution is
 * now ours, and it has to behave the way the ecosystem expects.
 */

test('normalizeProxyUrl accepts the shapes people actually type', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:7897'), 'http://127.0.0.1:7897');
  assert.equal(normalizeProxyUrl('http://127.0.0.1:7897/'), 'http://127.0.0.1:7897');
  assert.equal(normalizeProxyUrl('  https://proxy.corp:8443 '), 'https://proxy.corp:8443');
  assert.equal(normalizeProxyUrl('http://user:pass@10.0.0.1:3128'), 'http://user:pass@10.0.0.1:3128');
  // Not proxied: junk, an unusable scheme, and the "direct" words.
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:1080'), null);
  assert.equal(normalizeProxyUrl('off'), null);
  assert.equal(normalizeProxyUrl(''), null);
  assert.equal(normalizeProxyUrl(undefined), null);
});

test('proxyFromEnv walks AICODE_PROXY → HTTPS_PROXY → HTTP_PROXY → ALL_PROXY', () => {
  assert.deepEqual(proxyFromEnv({ AICODE_PROXY: 'http://a:1', HTTPS_PROXY: 'http://b:2' }), {
    url: 'http://a:1',
    source: 'AICODE_PROXY',
  });
  assert.deepEqual(proxyFromEnv({ HTTPS_PROXY: 'http://b:2', HTTP_PROXY: 'http://c:3' }), {
    url: 'http://b:2',
    source: 'HTTPS_PROXY',
  });
  assert.deepEqual(proxyFromEnv({ http_proxy: 'c:3' }), { url: 'http://c:3', source: 'HTTP_PROXY' });
  assert.deepEqual(proxyFromEnv({ ALL_PROXY: 'd:4' }), { url: 'http://d:4', source: 'ALL_PROXY' });
  assert.equal(proxyFromEnv({}), null);
  // An explicit "direct" beats an inherited proxy.
  assert.equal(proxyFromEnv({ AICODE_PROXY: 'off', HTTPS_PROXY: 'http://b:2' }), null);
  // Set but unusable is reported as "no proxy", never silently swapped.
  assert.deepEqual(proxyFromEnv({ HTTPS_PROXY: 'socks5://127.0.0.1:1080' }), { url: '', source: 'HTTPS_PROXY' });
});

test('hostBypassesProxy handles the NO_PROXY shapes that matter', () => {
  assert.equal(hostBypassesProxy('localhost', 'localhost'), true);
  assert.equal(hostBypassesProxy('api.internal', '.internal'), true);
  assert.equal(hostBypassesProxy('internal', '.internal'), true);
  assert.equal(hostBypassesProxy('api.internal', 'internal'), true);
  assert.equal(hostBypassesProxy('api.example.com', 'localhost, .corp.example'), false);
  assert.equal(hostBypassesProxy('anything.example', '*'), true);
  // Port-specific entries only match that port.
  assert.equal(hostBypassesProxy('svc.example', 'svc.example:8080', '8080'), true);
  assert.equal(hostBypassesProxy('svc.example', 'svc.example:8080', '443'), false);
  assert.equal(hostBypassesProxy('example.com', undefined), false);
});

test('resolveProxy: env wins, settings is the fallback, NO_PROXY still wins', () => {
  assert.deepEqual(resolveProxy('https://example.com', { HTTPS_PROXY: 'http://b:2' }, 'http://settings:9'), {
    url: 'http://b:2',
    source: 'HTTPS_PROXY',
  });
  assert.deepEqual(resolveProxy('https://example.com', {}, 'settings:9'), {
    url: 'http://settings:9',
    source: 'settings',
  });
  assert.equal(resolveProxy('https://example.com', {}, undefined), null);
  assert.equal(resolveProxy('https://localhost:5173', { HTTPS_PROXY: 'http://b:2' }, undefined), null);
  assert.equal(resolveProxy('https://internal.example', { HTTPS_PROXY: 'http://b:2', NO_PROXY: '.example' }), null);
  // Env says "direct": the settings value must not sneak back in.
  assert.equal(resolveProxy('https://example.com', { AICODE_PROXY: 'off' }, 'http://settings:9'), null);
});

test('describeEnvProxy names the variable and exposes an unusable value', () => {
  assert.match(describeEnvProxy({ HTTPS_PROXY: '127.0.0.1:7897' }), /HTTPS_PROXY=http:\/\/127\.0\.0\.1:7897/);
  assert.match(describeEnvProxy({ HTTPS_PROXY: 'socks5://x:1' }), /unusable/);
  assert.match(describeEnvProxy({ AICODE_PROXY: 'off' }), /direct/);
  assert.equal(describeEnvProxy({}), '');
});

test('explainNetworkFailure: connect timeout names the host and the missing proxy', () => {
  const saved = { ...process.env };
  delete process.env.AICODE_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;
  try {
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' },
    });
    const message = explainNetworkFailure(error, 'https://html.duckduckgo.com/html/?q=x');
    assert.match(message, /connect timed out/);
    assert.match(message, /html\.duckduckgo\.com/);
    assert.match(message, /UND_ERR_CONNECT_TIMEOUT/);
    assert.match(message, /no proxy is configured/);
    assert.match(message, /AICODE_PROXY/);
  } finally {
    process.env = saved;
  }
});

test('explainNetworkFailure names the proxy that was actually used', () => {
  const saved = { ...process.env };
  delete process.env.http_proxy;
  delete process.env.HTTP_PROXY;
  process.env.AICODE_PROXY = 'http://127.0.0.1:7897';
  try {
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' },
    });
    const message = explainNetworkFailure(error, 'https://api.openai.com/v1/models');
    assert.match(message, /http:\/\/127\.0\.0\.1:7897/);
    assert.match(message, /AICODE_PROXY/);
    assert.match(message, /api\.openai\.com/);
  } finally {
    process.env = saved;
  }
});

test('the default allowlist covers the hosts that were blocked in practice', () => {
  for (const host of ['github.com', 'api.github.com', 'openai.com', 'nodejs.org', 'duckduckgo.com']) {
    assert.ok(DEFAULT_NETWORK_ALLOWLIST.includes(host), `${host} should be allowlisted by default`);
  }
});
