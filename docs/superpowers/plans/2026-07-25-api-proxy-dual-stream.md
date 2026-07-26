# API Proxy Dual-Protocol Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local API gateway intercept ZCode probes and force all real Chat Completions and Responses requests to stream through protocol-correct `/v1` upstream routes.

**Architecture:** Add a pure protocol helper module that classifies probes, creates local probe responses, rewrites real request bodies, and maps local paths to upstream paths. Keep HTTP transport, logging, timeouts, and pass-through streaming in `api-proxy-dashboard.mjs`, adding one response-validation boundary before writing upstream headers to the client.

**Tech Stack:** Node.js ESM, built-in `node:test`, built-in HTTP server and Fetch API.

---

## File Structure

- Create `scripts/api-proxy-protocol.mjs`: protocol-specific probe detection, local probe response creation, request transformation, and endpoint routing.
- Create `scripts/api-proxy-protocol.test.mjs`: pure behavior tests for Chat and Responses requests.
- Modify `scripts/api-proxy-dashboard.mjs`: use protocol helpers, force real requests to stream, route both endpoints through `/v1`, and reject upstream HTML success pages.
- Keep `scripts/api-proxy-utils.mjs` and `scripts/api-proxy-utils.test.mjs`: generic model/header/retry helpers and their existing tests.

### Task 1: Protocol Probe Classification

**Files:**
- Create: `scripts/api-proxy-protocol.mjs`
- Create: `scripts/api-proxy-protocol.test.mjs`

- [ ] **Step 1: Write failing tests for exact Chat and Responses probes**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLocalProbeResponse,
  isLocalProbe,
} from './api-proxy-protocol.mjs';

const chatProbe = {
  model: 'provider/gpt-5.6-sol',
  stream: false,
  max_tokens: 1,
  messages: [{ role: 'user', content: 'hi' }],
};

const responsesProbe = {
  model: 'provider/gpt-5.6-sol',
  max_output_tokens: 1,
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
};

test('detects a tool-free Chat probe', () => {
  assert.equal(isLocalProbe('/chat/completions', chatProbe), true);
});

test('detects a tool-free Responses probe', () => {
  assert.equal(isLocalProbe('/responses', responsesProbe), true);
});

test('does not classify a real Responses conversation as a probe', () => {
  assert.equal(isLocalProbe('/responses', { ...responsesProbe, tools: [{ type: 'function', name: 'read_file' }] }), false);
});

test('creates protocol-correct Chat probe output', () => {
  const response = createLocalProbeResponse('/chat/completions', 'gpt-5.6-sol');
  assert.equal(response.object, 'chat.completion');
  assert.equal(response.choices[0].message.content, 'ok');
});

test('creates protocol-correct Responses probe output', () => {
  const response = createLocalProbeResponse('/responses', 'gpt-5.6-sol');
  assert.equal(response.object, 'response');
  assert.equal(response.output[0].content[0].type, 'output_text');
  assert.equal(response.output[0].content[0].text, 'ok');
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `node --test scripts/api-proxy-protocol.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `api-proxy-protocol.mjs`.

- [ ] **Step 3: Implement exact probe detection and local responses**

```js
function hasTools(payload) {
  return Array.isArray(payload?.tools) && payload.tools.length > 0;
}

function chatPrompt(payload) {
  if (!Array.isArray(payload?.messages) || payload.messages.length !== 1) return null;
  const message = payload.messages[0];
  return message?.role === 'user' && typeof message.content === 'string' ? message.content : null;
}

function responsesPrompt(payload) {
  if (!Array.isArray(payload?.input) || payload.input.length !== 1) return null;
  const item = payload.input[0];
  if (item?.role !== 'user' || !Array.isArray(item.content) || item.content.length !== 1) return null;
  const content = item.content[0];
  return content?.type === 'input_text' && typeof content.text === 'string' ? content.text : null;
}

export function isLocalProbe(pathname, payload) {
  if (hasTools(payload)) return false;
  if (pathname === '/chat/completions') {
    return payload?.stream !== true && payload?.max_tokens === 1 && chatPrompt(payload) === 'hi';
  }
  if (pathname === '/responses') {
    return payload?.stream !== true && payload?.max_output_tokens === 1 && responsesPrompt(payload) === 'hi';
  }
  return false;
}

export function createLocalProbeResponse(pathname, model) {
  const created = Math.floor(Date.now() / 1000);
  if (pathname === '/chat/completions') {
    return {
      id: 'chatcmpl-local-gateway-health',
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
  return {
    id: 'resp-local-gateway-health',
    object: 'response',
    created_at: created,
    status: 'completed',
    model,
    output: [{ id: 'msg-local-gateway-health', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}
```

- [ ] **Step 4: Run the protocol tests**

Run: `node --test scripts/api-proxy-protocol.test.mjs`

Expected: 5 tests pass.

### Task 2: Real Request Transformation and Routing

**Files:**
- Modify: `scripts/api-proxy-protocol.mjs`
- Modify: `scripts/api-proxy-protocol.test.mjs`

- [ ] **Step 1: Add failing tests for forced streaming, model normalization, and routing**

```js
import {
  createLocalProbeResponse,
  isLocalProbe,
  transformRealRequest,
  upstreamPath,
} from './api-proxy-protocol.mjs';

test('forces a real Chat request to stream and normalizes its model', () => {
  const result = transformRealRequest('/chat/completions', {
    model: '03351671-c6eb-47c4-84b7-72d2c60a8947/gpt-5.6-sol',
    stream: false,
    messages: [{ role: 'user', content: 'write code' }],
  });
  assert.equal(result.model, 'gpt-5.6-sol');
  assert.equal(result.stream, true);
  assert.equal(result.messages[0].content, 'write code');
});

test('forces a real Responses request to stream and preserves tools', () => {
  const tools = [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }];
  const result = transformRealRequest('/responses', {
    model: '03351671-c6eb-47c4-84b7-72d2c60a8947/gpt-5.6-sol',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'write code' }] }],
    tools,
  });
  assert.equal(result.model, 'gpt-5.6-sol');
  assert.equal(result.stream, true);
  assert.deepEqual(result.tools, tools);
});

test('routes supported endpoints to versioned upstream paths', () => {
  assert.equal(upstreamPath('/models'), '/v1/models');
  assert.equal(upstreamPath('/chat/completions'), '/v1/chat/completions');
  assert.equal(upstreamPath('/responses'), '/v1/responses');
});
```

- [ ] **Step 2: Run tests and verify missing-export failures**

Run: `node --test scripts/api-proxy-protocol.test.mjs`

Expected: FAIL because `transformRealRequest` and `upstreamPath` are not exported.

- [ ] **Step 3: Implement transformation and endpoint-specific routing**

```js
import { normalizeModelNameForUpstream } from './api-proxy-utils.mjs';

export function transformRealRequest(pathname, payload) {
  if (!['/chat/completions', '/responses'].includes(pathname)) return payload;
  return {
    ...payload,
    model: normalizeModelNameForUpstream(payload?.model),
    stream: true,
  };
}

export function upstreamPath(pathname) {
  if (pathname === '/models') return '/v1/models';
  if (pathname === '/chat/completions') return '/v1/chat/completions';
  if (pathname === '/responses') return '/v1/responses';
  return pathname;
}
```

- [ ] **Step 4: Run all helper tests**

Run: `node --test scripts/api-proxy-protocol.test.mjs scripts/api-proxy-utils.test.mjs`

Expected: all protocol and utility tests pass.

### Task 3: Integrate Dual-Protocol Handling into the Gateway

**Files:**
- Modify: `scripts/api-proxy-dashboard.mjs:117-248`

- [ ] **Step 1: Import the protocol helpers**

```js
import {
  createLocalProbeResponse,
  isLocalProbe,
  transformRealRequest,
  upstreamPath,
} from './api-proxy-protocol.mjs';
```

Remove the local `upstreamPath`, `isZcodeProbe`, and `zcodeProbeResponse` functions. Keep `defaultPathForMode` only for dashboard test-button selection.

- [ ] **Step 2: Replace Chat-only body handling with dual-protocol handling**

```js
const supportedModelPath = ['/chat/completions', '/responses'].includes(inputUrl.pathname);

if (supportedModelPath && body.length) {
  try {
    const payload = JSON.parse(body.toString('utf8'));
    if (state.shimZcodeProbe && isLocalProbe(inputUrl.pathname, payload)) {
      sendJson(res, 200, createLocalProbeResponse(inputUrl.pathname, normalizeModelNameForUpstream(payload.model) || state.model || 'model'));
      return;
    }
    const transformed = transformRealRequest(inputUrl.pathname, payload);
    if (payload.model !== transformed.model) {
      log('normalized model name', { id, from: payload.model, to: transformed.model });
    }
    isStreamingRequest = transformed.stream === true;
    body = Buffer.from(JSON.stringify(transformed));
  } catch {
    // Keep malformed body unchanged and let upstream return its own error.
  }
}
```

This intentionally forces streaming for both endpoints without depending on the persisted `forceStream` toggle.

- [ ] **Step 3: Switch routing to endpoint-specific versioned paths**

```js
const targetUrl = `${base}${upstreamPath(inputUrl.pathname)}${inputUrl.search}`;
```

- [ ] **Step 4: Run helper tests and syntax-check the dashboard**

Run: `node --test scripts/api-proxy-protocol.test.mjs scripts/api-proxy-utils.test.mjs`

Expected: all tests pass.

Run: `node --check scripts/api-proxy-dashboard.mjs`

Expected: exit code 0 with no output.

### Task 4: Reject HTML Success Pages Before Streaming

**Files:**
- Modify: `scripts/api-proxy-dashboard.mjs:244-253`

- [ ] **Step 1: Add a pure content-type helper and failing tests**

Add to `scripts/api-proxy-protocol.test.mjs`:

```js
import { isInvalidModelResponse } from './api-proxy-protocol.mjs';

test('rejects HTML returned with a successful status', () => {
  assert.equal(isInvalidModelResponse(200, 'text/html; charset=utf-8'), true);
});

test('keeps JSON errors for pass-through', () => {
  assert.equal(isInvalidModelResponse(503, 'application/json; charset=utf-8'), false);
});

test('accepts an SSE model response', () => {
  assert.equal(isInvalidModelResponse(200, 'text/event-stream'), false);
});
```

- [ ] **Step 2: Run tests and verify the missing-export failure**

Run: `node --test scripts/api-proxy-protocol.test.mjs`

Expected: FAIL because `isInvalidModelResponse` is not exported.

- [ ] **Step 3: Implement response validation**

Add to `scripts/api-proxy-protocol.mjs`:

```js
export function isInvalidModelResponse(status, contentType) {
  return status >= 200 && status < 300 && /^text\/html(?:;|$)/i.test(String(contentType || ''));
}
```

Before `res.writeHead(upstream.status, responseHeaders)` in `api-proxy-dashboard.mjs`:

```js
const contentType = upstream.headers.get('content-type') || '';
if (isInvalidModelResponse(upstream.status, contentType)) {
  await upstream.body?.cancel();
  sendJson(res, 502, {
    error: {
      type: 'invalid_upstream_response',
      message: 'Upstream returned HTML instead of a model response.',
      status: upstream.status,
      contentType,
    },
  });
  log('invalid upstream response', { id, status: upstream.status, contentType, durationMs: elapsedMs(startedAt) });
  return;
}
```

Import `isInvalidModelResponse` with the other protocol helpers.

- [ ] **Step 4: Run all tests and syntax checks**

Run: `node --test scripts/api-proxy-protocol.test.mjs scripts/api-proxy-utils.test.mjs`

Expected: all tests pass.

Run: `node --check scripts/api-proxy-dashboard.mjs`

Expected: exit code 0 with no output.

### Task 5: Restart and Live Verification

**Files:**
- Persisted runtime state: `scripts/api-proxy-state.json`

- [ ] **Step 1: Restart the dashboard and reload saved state**

Run:

```powershell
$ports = 8788,8790
$pids = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $ports -contains $_.LocalPort } |
  Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($pidValue in $pids) {
  Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
}
& 'C:\Users\34516\ZCodeProject\scripts\start-api-proxy-dashboard.ps1'
Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/start' -Method Post -ContentType 'application/json' -Body '{}'
```

Expected: ports `8788` and `8790` listen under one Node PID; state reports model `gpt-5.6-sol` and an existing API key.

- [ ] **Step 2: Verify both local probes**

Send a Chat probe and a Responses probe to the local gateway.

Expected: both return HTTP 200 with local IDs (`chatcmpl-local-gateway-health` and `resp-local-gateway-health`), without new `proxy request` log entries for the probe request IDs.

- [ ] **Step 3: Verify Chat and Responses real-request transformation from logs**

Send one non-probe request to each endpoint with `stream: false` and a provider-prefixed model.

Expected logs:

```text
incomingPath: /chat/completions
isStreamingRequest: true
targetUrl: https://yunqiaoai.dpdns.org/v1/chat/completions
```

```text
incomingPath: /responses
isStreamingRequest: true
targetUrl: https://yunqiaoai.dpdns.org/v1/responses
```

Expected upstream outcome under the retained cloud bridge: either a valid SSE response or a JSON `model_not_found`/channel error. HTML 200 must become structured HTTP 502.

- [ ] **Step 4: Run final regression verification**

Run: `node --test scripts/api-proxy-protocol.test.mjs scripts/api-proxy-utils.test.mjs`

Expected: all tests pass with zero failures.

Run: `node --check scripts/api-proxy-dashboard.mjs`

Expected: exit code 0.

Check: `GET http://127.0.0.1:8788/health`

Expected: `ok=true`, `proxyRunning=true`, model `gpt-5.6-sol`.

## Constraints

This workspace is not a Git repository. Skip commit steps and do not initialize Git. Do not expose the saved API key in command output or logs.
