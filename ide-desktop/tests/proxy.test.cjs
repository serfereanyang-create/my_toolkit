const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const proxy = require('../electron/proxy.cjs');

/*
 * 代理是"联网功能缺失"的根因：Chromium 只认 --proxy-server，Node 的 fetch 不认
 * HTTPS_PROXY，而 CLI 子进程只继承 process.env。这三条路都从这里接出去，所以
 * 解析顺序、绕过规则、开关注入都得钉死。
 */

function fakeApp() {
  const switches = [];
  return {
    switches,
    getPath: () => fakeApp.userDataDir,
    commandLine: { appendSwitch: (name, value) => switches.push([name, value]) },
  };
}

function tempSettings(network) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-proxy-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ network }), 'utf8');
  return dir;
}

test('normalizeProxyUrl: 常见写法都认，socks 和 off 不认', () => {
  assert.equal(proxy.normalizeProxyUrl('127.0.0.1:7897'), 'http://127.0.0.1:7897');
  assert.equal(proxy.normalizeProxyUrl('http://127.0.0.1:7897/'), 'http://127.0.0.1:7897');
  assert.equal(proxy.normalizeProxyUrl(' https://corp-proxy:8443 '), 'https://corp-proxy:8443');
  assert.equal(proxy.normalizeProxyUrl('socks5://127.0.0.1:1080'), null);
  assert.equal(proxy.normalizeProxyUrl('off'), null);
  assert.equal(proxy.normalizeProxyUrl(''), null);
});

test('proxyFromEnv: 优先级 AICODE_PROXY → HTTPS_PROXY → HTTP_PROXY → ALL_PROXY', () => {
  assert.deepEqual(proxy.proxyFromEnv({ AICODE_PROXY: 'http://a:1', HTTPS_PROXY: 'http://b:2' }), {
    url: 'http://a:1',
    source: 'AICODE_PROXY',
  });
  assert.deepEqual(proxy.proxyFromEnv({ HTTPS_PROXY: 'http://b:2', HTTP_PROXY: 'http://c:3' }), {
    url: 'http://b:2',
    source: 'HTTPS_PROXY',
  });
  assert.deepEqual(proxy.proxyFromEnv({ http_proxy: 'c:3' }), { url: 'http://c:3', source: 'HTTP_PROXY' });
  assert.equal(proxy.proxyFromEnv({}), null);
  assert.equal(proxy.proxyFromEnv({ AICODE_PROXY: 'off', HTTPS_PROXY: 'http://b:2' }), null);
});

test('applyEarly: 注入 Chromium 开关，并把代理写进 process.env 给 CLI 子进程', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:7897' };
  const app = fakeApp();
  const state = proxy.applyEarly(app, { env, userDataDir: null });

  assert.deepEqual(
    app.switches.find(([name]) => name === 'proxy-server'),
    ['proxy-server', 'http://127.0.0.1:7897'],
  );
  const bypass = app.switches.find(([name]) => name === 'proxy-bypass-list');
  assert.ok(bypass, '必须写 proxy-bypass-list');
  assert.match(bypass[1], /<local>/);
  assert.match(bypass[1], /127\.0\.0\.1/);
  assert.equal(state.hostPort, '127.0.0.1:7897');
  assert.equal(state.proxyRules, 'http=127.0.0.1:7897;https=127.0.0.1:7897');
  // CLI 子进程靠这一条：agent bridge 用 {...process.env} 拉起 cli/dist。
  assert.equal(env.AICODE_PROXY, 'http://127.0.0.1:7897');
});

test('applyEarly: 没有代理时一个开关都不动，环境变量也不伪造', () => {
  const env = {};
  const app = fakeApp();
  const state = proxy.applyEarly(app, { env, userDataDir: null });

  assert.deepEqual(app.switches, []);
  assert.equal(state.url, null);
  assert.equal(env.AICODE_PROXY, undefined);
});

test('applyEarly: NO_PROXY 转成 Chromium 的 *. 形式一并绕过', () => {
  const app = fakeApp();
  proxy.applyEarly(app, { env: { HTTPS_PROXY: 'b:2', NO_PROXY: 'corp.example,.internal' }, userDataDir: null });
  const bypass = app.switches.find(([name]) => name === 'proxy-bypass-list');
  assert.match(bypass[1], /corp\.example/);
  assert.match(bypass[1], /\*\.internal/);
});

test('proxyFromSettings: settings.json 的 network.proxy 是兜底，环境变量优先', () => {
  const userDataDir = tempSettings({ proxy: '127.0.0.1:7897' });

  const fromSettings = proxy.applyEarly(fakeApp(), { env: {}, userDataDir });
  assert.equal(fromSettings.url, 'http://127.0.0.1:7897');
  assert.equal(fromSettings.source, 'settings.network.proxy');

  const envWins = proxy.applyEarly(fakeApp(), { env: { AICODE_PROXY: 'http://env:1' }, userDataDir });
  assert.equal(envWins.url, 'http://env:1');
  assert.equal(envWins.source, 'AICODE_PROXY');
});

test('applyToSession: 后台浏览器分区显式走同一个代理', async () => {
  proxy.applyEarly(fakeApp(), { env: { HTTPS_PROXY: '127.0.0.1:7897' }, userDataDir: null });
  const calls = [];
  const ses = {
    setProxy: async (config) => {
      calls.push(config);
      return true;
    },
  };
  await proxy.applyToSession(ses);
  assert.deepEqual(calls[0], {
    mode: 'fixed_servers',
    proxyRules: 'http=127.0.0.1:7897;https=127.0.0.1:7897',
    proxyBypassRules: proxy.getProxyState().bypassRules,
  });
});

test('applyToSession: 没配代理时退回系统设置，而不是留着旧代理', async () => {
  proxy.applyEarly(fakeApp(), { env: {}, userDataDir: null });
  const calls = [];
  await proxy.applyToSession({
    setProxy: async (config) => {
      calls.push(config);
      return true;
    },
  });
  assert.deepEqual(calls, [{ mode: 'system' }]);
});
