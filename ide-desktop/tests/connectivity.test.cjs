const test = require('node:test');
const assert = require('node:assert/strict');
const { testProviderConnection } = require('../electron/connectivity.cjs');

function jsonResponse(status, payload, contentType = 'application/json') {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    async text() {
      return body;
    },
  };
}

const openaiProvider = { id: 'p1', type: 'custom', label: 'X', model: 'gpt-4o', baseUrl: 'https://api.example.com/v1', apiFormat: 'openai' };
const anthropicProvider = { id: 'p2', type: 'custom', label: 'Y', model: 'claude-3-5-sonnet', baseUrl: 'https://api.example.com/v1', apiFormat: 'anthropic' };

test('mock provider needs no network call', async () => {
  const result = await testProviderConnection({ providerConfig: { id: 'm', type: 'mock', model: 'x', baseUrl: '' }, apiKey: '' });
  assert.equal(result.ok, true);
  assert.match(result.message, /Mock/);
});

test('missing base url fails fast without fetching', async () => {
  let called = false;
  const result = await testProviderConnection(
    { providerConfig: { ...openaiProvider, baseUrl: '' }, apiKey: 'sk-x' },
    { fetch: async () => { called = true; return jsonResponse(200, {}); } },
  );
  assert.equal(result.ok, false);
  assert.equal(called, false);
  assert.match(result.message, /Base URL/);
});

test('missing api key fails fast', async () => {
  const result = await testProviderConnection({ providerConfig: openaiProvider, apiKey: '' });
  assert.equal(result.ok, false);
  assert.match(result.message, /API Key/);
});

test('openai success extracts assistant sample and uses Bearer + /chat/completions', async () => {
  let seenUrl = '';
  let seenHeaders = {};
  const result = await testProviderConnection(
    { providerConfig: openaiProvider, apiKey: 'sk-test' },
    {
      fetch: async (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers;
        return jsonResponse(200, { choices: [{ message: { role: 'assistant', content: 'pong' } }] });
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(seenUrl, 'https://api.example.com/v1/chat/completions');
  assert.equal(seenHeaders.authorization, 'Bearer sk-test');
  assert.equal(result.sample, 'pong');
});

test('anthropic success uses x-api-key + /messages and extracts text block', async () => {
  let seenUrl = '';
  let seenHeaders = {};
  const result = await testProviderConnection(
    { providerConfig: anthropicProvider, apiKey: 'sk-ant' },
    {
      fetch: async (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers;
        return jsonResponse(200, { content: [{ type: 'text', text: 'hi there' }] });
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(seenUrl, 'https://api.example.com/v1/messages');
  assert.equal(seenHeaders['x-api-key'], 'sk-ant');
  assert.equal(seenHeaders['anthropic-version'], '2023-06-01');
  assert.equal(result.sample, 'hi there');
});

test('200 HTML homepage is reported as a Base URL error, not success', async () => {
  // Reproduces the real bug: Base URL missing /v1 lands on the site homepage,
  // which returns 200 text/html. Chat would silently reply nothing.
  const result = await testProviderConnection(
    { providerConfig: anthropicProvider, apiKey: 'sk-x' },
    { fetch: async () => jsonResponse(200, '<!doctype html><html><body>hi</body></html>', 'text/html; charset=utf-8') },
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /Base URL|网页/);
});

test('200 JSON without assistant text is a failure', async () => {
  const result = await testProviderConnection(
    { providerConfig: openaiProvider, apiKey: 'sk-x' },
    { fetch: async () => jsonResponse(200, { choices: [{ message: { content: '' } }] }) },
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /不含模型文本|gpt-4o/);
});

test('401 reported as auth failure with server snippet', async () => {
  const result = await testProviderConnection(
    { providerConfig: openaiProvider, apiKey: 'bad' },
    { fetch: async () => jsonResponse(401, { error: { message: 'invalid api key' } }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.message, /认证失败/);
  assert.match(result.message, /invalid api key/);
});

test('404 reported with endpoint/model hint', async () => {
  const result = await testProviderConnection(
    { providerConfig: openaiProvider, apiKey: 'sk-x' },
    { fetch: async () => jsonResponse(404, 'not found') },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.match(result.message, /404/);
  assert.match(result.message, /gpt-4o/);
});

test('trailing slash in base url is normalized', async () => {
  let seenUrl = '';
  await testProviderConnection(
    { providerConfig: { ...openaiProvider, baseUrl: 'https://api.example.com/v1/' }, apiKey: 'sk-x' },
    { fetch: async (url) => { seenUrl = url; return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }); } },
  );
  assert.equal(seenUrl, 'https://api.example.com/v1/chat/completions');
});

test('network DNS error is translated to a readable hint', async () => {
  const result = await testProviderConnection(
    { providerConfig: openaiProvider, apiKey: 'sk-x' },
    {
      fetch: async () => {
        const err = new Error('fetch failed');
        err.cause = { code: 'ENOTFOUND' };
        throw err;
      },
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /域名解析失败/);
});

test('timeout via abort produces a timeout message', async () => {
  const result = await testProviderConnection(
    { providerConfig: openaiProvider, apiKey: 'sk-x' },
    {
      timeoutMs: 5,
      fetch: async (_url, init) => {
        return await new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      },
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /超时/);
});
