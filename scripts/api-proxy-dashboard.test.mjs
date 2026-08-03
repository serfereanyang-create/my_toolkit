import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, 'api-proxy-dashboard.mjs');
const host = '127.0.0.1';

const defaultTestState = {
  proxyPort: 8788,
  targetBaseUrl: '',
  apiKey: '',
  model: 'grok-4.5',
  mode: 'chat-auto-v1',
  shimZcodeProbe: true,
  forceStream: false,
  stripReasoning: false,
};

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function getFreePort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function waitFor(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Keep waiting while the child binds its control listener.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

async function startDashboard(initialState) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'api-proxy-dashboard-test-'));
  const stateFile = path.join(tempDir, 'state.json');
  const controlPort = await getFreePort();
  await fs.writeFile(stateFile, JSON.stringify({ ...defaultTestState, ...initialState }), 'utf8');

  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      CONTROL_PORT: String(controlPort),
      STATE_FILE: stateFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  try {
    await waitFor(`http://${host}:${controlPort}/api/state`);
  } catch (error) {
    await stopChild(child);
    await fs.rm(tempDir, { recursive: true, force: true });
    throw new Error(`${error.message}\nDashboard output:\n${output}`);
  }

  return {
    child,
    controlPort,
    stateFile,
    output: () => output,
    async cleanup() {
      await stopChild(child);
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('bad api key is rejected without crashing the dashboard', async () => {
  const proxyPort = await getFreePort();
  const dashboard = await startDashboard({
    proxyPort,
    targetBaseUrl: 'https://yunqiaoai.duckdns.org',
    apiKey: 'sk-test-placeholder',
  });

  try {
    const response = await postJson(`http://${host}:${dashboard.controlPort}/api/start`, {
      apiKey: 'ZCode error Invalid token',
      proxyPort,
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.match(body.error.message, /API Key/);

    const health = await fetch(`http://${host}:${dashboard.controlPort}/api/state`);
    assert.equal(health.status, 200);
    assert.equal(dashboard.child.exitCode, null);
  } finally {
    await dashboard.cleanup();
  }
});

test('supported protocol requests use the shared protocol behavior', async () => {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await getFreePort();
  const providerPrefix = '123e4567-e89b-12d3-a456-426614174000/';
  const dashboard = await startDashboard({
    proxyPort,
    targetBaseUrl: `http://${host}:${upstreamPort}`,
    model: 'fallback-model',
    mode: 'responses-raw',
  });

  try {
    const startResponse = await postJson(`http://${host}:${dashboard.controlPort}/api/start`, { proxyPort });
    assert.equal(startResponse.status, 200);

    const responsesProbe = await fetch(`http://${host}:${proxyPort}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${providerPrefix}probe-model`,
        max_output_tokens: 1,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      }),
    });
    assert.equal(responsesProbe.status, 200);
    const probeBody = await responsesProbe.json();
    assert.equal(typeof probeBody.created_at, 'number');
    delete probeBody.created_at;
    assert.deepEqual(probeBody, {
      id: 'resp_local_gateway_health',
      object: 'response',
      status: 'completed',
      model: 'probe-model',
      output: [{
        id: 'msg_local_gateway_health',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    assert.equal(requests.length, 0);

    await fetch(`http://${host}:${proxyPort}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${providerPrefix}responses-model`,
        stream: false,
        max_output_tokens: 32,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        metadata: { source: 'integration-test' },
      }),
    });
    assert.equal(requests[0].path, '/v1/responses');
    // Non-Grok models keep the caller's streaming preference unchanged.
    assert.deepEqual(JSON.parse(requests[0].body), {
      model: 'responses-model',
      stream: false,
      max_output_tokens: 32,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      metadata: { source: 'integration-test' },
    });

    await fetch(`http://${host}:${proxyPort}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${providerPrefix}chat-model`,
        stream: false,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    assert.equal(requests[1].path, '/v1/chat/completions');
    // Non-Grok models keep the caller's streaming preference unchanged.
    assert.deepEqual(JSON.parse(requests[1].body), {
      model: 'chat-model',
      stream: false,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
    });

    const malformedBody = '{"model":';
    await fetch(`http://${host}:${proxyPort}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: malformedBody,
    });
    assert.equal(requests[2].path, '/v1/responses');
    assert.equal(requests[2].body, malformedBody);

    const dashboardState = await fetch(`http://${host}:${dashboard.controlPort}/api/state`).then(response => response.json());
    assert.ok(dashboardState.logs.some(item => item.message === 'normalized model name'
      && item.data?.from === `${providerPrefix}probe-model`
      && item.data?.to === 'probe-model'));
  } finally {
    await dashboard.cleanup();
    await closeServer(upstream);
  }
});

test('failed proxy listen resets public state and allows a later start', async () => {
  const occupiedServer = http.createServer();
  const occupiedPort = await listen(occupiedServer);
  const validPort = await getFreePort();
  const dashboard = await startDashboard({ proxyPort: validPort });

  try {
    const failedResponse = await postJson(`http://${host}:${dashboard.controlPort}/api/start`, {
      proxyPort: occupiedPort,
    });
    assert.equal(failedResponse.status, 500);
    const failedBody = await failedResponse.json();
    assert.equal(failedBody.state.proxyRunning, false);

    const startedResponse = await postJson(`http://${host}:${dashboard.controlPort}/api/start`, {
      proxyPort: validPort,
    });
    assert.equal(startedResponse.status, 200);
    const startedBody = await startedResponse.json();
    assert.equal(startedBody.state.proxyRunning, true);
    assert.equal(startedBody.state.proxyPort, validPort);

    const health = await fetch(`http://${host}:${validPort}/health`);
    assert.equal(health.status, 200);
  } finally {
    await dashboard.cleanup();
    await closeServer(occupiedServer);
  }
});

test('concurrent starts serialize saved state and proxy lifecycle mutations', async () => {
  const proxyPort = await getFreePort();
  const dashboard = await startDashboard({ proxyPort });
  const models = Array.from({ length: 6 }, (_, index) => `concurrent-model-${index}`);

  try {
    const results = await Promise.all(models.map(async model => {
      const response = await postJson(`http://${host}:${dashboard.controlPort}/api/start`, {
        proxyPort,
        model,
      });
      return { response, body: await response.json(), model };
    }));

    for (const result of results) {
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.state.model, result.model);
      assert.equal(result.body.state.proxyPort, proxyPort);
      assert.equal(result.body.state.proxyRunning, true);
    }

    const diskState = JSON.parse(await fs.readFile(dashboard.stateFile, 'utf8'));
    const currentState = await fetch(`http://${host}:${dashboard.controlPort}/api/state`).then(response => response.json());
    assert.equal(diskState.model, currentState.state.model);
    assert.equal(diskState.proxyPort, currentState.state.proxyPort);
  } finally {
    await dashboard.cleanup();
  }
});
