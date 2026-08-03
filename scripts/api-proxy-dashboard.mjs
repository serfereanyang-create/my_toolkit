import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildUpstreamUrl,
  createLocalProbeResponse,
  isLocalProbe,
  transformRealRequest,
} from './api-proxy-protocol.mjs';
import {
  headerValueToByteString,
  isRetryableFetchError,
  normalizeModelNameForUpstream,
} from './api-proxy-utils.mjs';
import { inspectSseFrames, parseSseFrames } from './api-proxy-sse-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = process.env.STATE_FILE
  ? path.resolve(process.env.STATE_FILE)
  : path.join(__dirname, 'api-proxy-state.json');
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 8790);
const HOST = '127.0.0.1';
const UPSTREAM_RESPONSE_TIMEOUT_MS = 120000;
const UPSTREAM_STREAM_IDLE_TIMEOUT_MS = 45000;

const DEFAULT_STATE = {
  proxyPort: 8788,
  targetBaseUrl: '',
  apiKey: '',
  model: 'grok-4.5',
  mode: 'chat-auto-v1',
  shimZcodeProbe: true,
  forceStream: false,
  stripReasoning: false,
  updatedAt: null,
};

let state = { ...DEFAULT_STATE };
let proxyServer = null;
let proxyPort = null;
let recentLogs = [];
let controlMutationQueue = Promise.resolve();

function log(message, data = undefined) {
  const item = {
    at: new Date().toISOString(),
    message,
    data,
  };
  recentLogs.unshift(item);
  recentLogs = recentLogs.slice(0, 200);
  console.log(`[${item.at}] ${message}`, data || '');
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

function requestId() {
  return Math.random().toString(36).slice(2, 10);
}

function elapsedMs(startedAt) {
  return Math.round(performance.now() - startedAt);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function loadState() {
  try {
    const text = await fs.readFile(STATE_FILE, 'utf8');
    state = { ...DEFAULT_STATE, ...JSON.parse(text) };
  } catch {
    state = { ...DEFAULT_STATE };
  }
}

function validateApiKey(apiKey) {
  if (!apiKey) return;
  if (/^https?:\/\//i.test(apiKey)) {
    throw new Error('API Key 看起来像 URL，已拒绝保存。请把 Base URL 填到 URL 输入框，把 API Key 填到 API Key 输入框。');
  }
  if (!/^[\x21-\x7E]+$/.test(apiKey)) {
    throw new Error('API Key 只能包含无空格的 ASCII 可见字符；当前值像是粘贴了报错文本或多余内容。');
  }
}

async function saveState(next) {
  const patch = { ...next };
  const candidateKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : undefined;

  // Empty key means "keep existing key". This prevents the UI placeholder/masked value
  // or a partial edit from erasing a working token.
  if (!candidateKey) {
    delete patch.apiKey;
  } else {
    validateApiKey(candidateKey);
    patch.apiKey = candidateKey;
  }

  if (typeof patch.targetBaseUrl === 'string') patch.targetBaseUrl = patch.targetBaseUrl.trim();
  if (typeof patch.model === 'string') patch.model = patch.model.trim();

  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
  await fs.writeFile(STATE_FILE, JSON.stringify({ ...state, apiKey: state.apiKey }, null, 2), 'utf8');
}

function defaultPathForMode(mode) {
  if (mode.startsWith('responses')) return '/responses';
  if (mode === 'anthropic') return '/v1/messages';
  return '/chat/completions';
}

async function fetchUpstreamWithRetry(targetUrl, options, retryable) {
  const maxAttempts = retryable ? 3 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('upstream response timeout')), UPSTREAM_RESPONSE_TIMEOUT_MS);
    try {
      return await fetch(targetUrl, { ...options, signal: controller.signal });
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableFetchError(error)) throw error;
      log('retrying upstream request', { attempt, nextAttempt: attempt + 1, message: error?.message || String(error), cause: error?.cause?.message || error?.cause?.code || null });
      await new Promise(resolve => setTimeout(resolve, 300 * attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('unreachable upstream retry state');
}

async function proxyRequest(req, res) {
  const id = requestId();
  const startedAt = performance.now();
  const inputUrl = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${state.proxyPort}`}`);

  if (req.method === 'GET' && inputUrl.pathname === '/health') {
    sendJson(res, 200, { ok: true, state: publicState() });
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = Buffer.concat(chunks);
  let isStreamingRequest = false;

  if ((inputUrl.pathname === '/chat/completions' || inputUrl.pathname === '/responses') && body.length) {
    try {
      const payload = JSON.parse(body.toString('utf8'));
      const normalizedModel = normalizeModelNameForUpstream(payload.model);
      if (payload.model !== normalizedModel) {
        log('normalized model name', { id, from: payload.model, to: normalizedModel });
      }
      if (state.shimZcodeProbe && isLocalProbe(inputUrl.pathname, payload)) {
        sendJson(res, 200, createLocalProbeResponse(inputUrl.pathname, normalizedModel || state.model || 'model'));
        return;
      }
      const transformed = transformRealRequest(inputUrl.pathname, payload);
      isStreamingRequest = transformed.stream === true;
      body = Buffer.from(JSON.stringify(transformed));
    } catch {
      // Keep malformed body unchanged and let upstream return its own error.
    }
  }

  const targetUrl = buildUpstreamUrl(state.targetBaseUrl, inputUrl.pathname, inputUrl.search);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    const lower = name.toLowerCase();
    if (['host', 'connection', 'content-length', 'accept-encoding'].includes(lower)) continue;
    const headerValue = headerValueToByteString(Array.isArray(value) ? value.join(', ') : value);
    if (headerValue == null) {
      log('skipped non-byte header', { id, name });
      continue;
    }
    headers.set(name, headerValue);
  }
  try {
    if (state.apiKey) {
      validateApiKey(state.apiKey);
      headers.set('authorization', `Bearer ${state.apiKey}`);
    }
    if (!headers.has('content-type') && body.length) headers.set('content-type', 'application/json');
  } catch (error) {
    sendJson(res, 400, { error: { message: error?.message || String(error), type: 'invalid_local_gateway_config' } });
    return;
  }

  log('proxy request', { id, method: req.method, incomingPath: inputUrl.pathname, targetUrl, isStreamingRequest });

  try {
    const upstream = await fetchUpstreamWithRetry(targetUrl, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      duplex: req.method === 'GET' || req.method === 'HEAD' ? undefined : 'half',
    }, !isStreamingRequest);

    const responseHeaders = Object.fromEntries(upstream.headers.entries());
    log('upstream response', { id, status: upstream.status, ok: upstream.ok, contentType: upstream.headers.get('content-type') || '', durationMs: elapsedMs(startedAt) });
    delete responseHeaders['content-encoding'];
    delete responseHeaders['content-length'];
    res.writeHead(upstream.status, responseHeaders);

    if (!upstream.body) {
      res.end();
      log('proxy response completed', { id, status: upstream.status, durationMs: elapsedMs(startedAt), bytesWritten: 0 });
      return;
    }

    let bytesWritten = 0;
    let idleTimeout = null;
    const resetIdleTimeout = () => {
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => {
        log('upstream stream idle timeout', { id, durationMs: elapsedMs(startedAt), bytesWritten });
        if (!res.destroyed) res.destroy(new Error('upstream stream idle timeout'));
      }, UPSTREAM_STREAM_IDLE_TIMEOUT_MS);
    };

    try {
      resetIdleTimeout();
      for await (const chunk of upstream.body) {
        if (res.destroyed || res.writableEnded) break;
        const buffer = Buffer.from(chunk);
        bytesWritten += buffer.length;
        res.write(buffer);
        resetIdleTimeout();
      }
      if (idleTimeout) clearTimeout(idleTimeout);
      if (!res.destroyed && !res.writableEnded) res.end();
      log('proxy response completed', { id, status: upstream.status, durationMs: elapsedMs(startedAt), bytesWritten });
    } catch (error) {
      if (idleTimeout) clearTimeout(idleTimeout);
      log('upstream stream interrupted', { id, message: error?.message || String(error), durationMs: elapsedMs(startedAt), bytesWritten });
      if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
    }
  } catch (error) {
    const message = error?.message || String(error);
    const cause = error?.cause?.message || error?.cause?.code || null;
    log('proxy error', { id, message, cause, durationMs: elapsedMs(startedAt) });
    if (!res.headersSent) {
      const isTimeout = /timeout/i.test(`${message} ${cause || ''}`);
      sendJson(res, isTimeout ? 504 : 502, { error: { message, cause, type: isTimeout ? 'upstream_timeout' : 'local_gateway_error' } });
    } else if (!res.destroyed) {
      res.destroy(error instanceof Error ? error : undefined);
    }
  }
}

function publicState() {
  return {
    proxyPort: state.proxyPort,
    targetBaseUrl: state.targetBaseUrl,
    hasApiKey: Boolean(state.apiKey),
    apiKeyMasked: state.apiKey ? `${state.apiKey.slice(0, 6)}...${state.apiKey.slice(-4)}` : '',
    model: state.model,
    mode: state.mode,
    shimZcodeProbe: state.shimZcodeProbe,
    forceStream: state.forceStream,
    stripReasoning: state.stripReasoning,
    proxyRunning: Boolean(proxyServer),
    gatewayBaseUrl: `http://${HOST}:${state.proxyPort}`,
    updatedAt: state.updatedAt,
  };
}

async function startProxy(port = state.proxyPort) {
  const candidatePort = Number(port);
  if (proxyServer && proxyPort === candidatePort) return;
  if (proxyServer) await stopProxy();

  const candidateServer = http.createServer(proxyRequest);
  candidateServer.on('clientError', (error, socket) => {
    log('proxy client error', { message: error.message });
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    candidateServer.once('error', reject);
    candidateServer.listen(candidatePort, HOST, () => {
      candidateServer.off('error', reject);
      resolve();
    });
  });

  proxyServer = candidateServer;
  proxyPort = candidatePort;
  log('proxy started', { port: proxyPort });
}

async function stopProxy() {
  if (!proxyServer) return;
  const server = proxyServer;
  proxyServer = null;
  await new Promise(resolve => server.close(resolve));
  log('proxy stopped', { port: proxyPort });
  proxyPort = null;
}

function serializeControlMutation(mutation) {
  const result = controlMutationQueue.then(mutation);
  controlMutationQueue = result.catch(() => {});
  return result;
}

async function runTest(kind) {
  const base = `http://${HOST}:${state.proxyPort}`;
  const headers = { 'content-type': 'application/json' };
  if (state.apiKey) headers.authorization = `Bearer ${state.apiKey}`;

  let url = `${base}${defaultPathForMode(state.mode)}`;
  let body;

  if (kind === 'models') {
    const res = await fetch(`${base}/models`, { headers });
    const text = await res.text();
    return summarizeResponse(res, text);
  }

  if (kind === 'probe') {
    body = { model: state.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
  } else if (kind === 'chat') {
    body = { model: state.model, stream: false, max_tokens: 32, messages: [{ role: 'user', content: '只回复 ok' }] };
  } else if (kind === 'stream') {
    body = { model: state.model, stream: true, max_tokens: 64, messages: [{ role: 'user', content: '只回复 ok' }] };
  } else if (kind === 'tools') {
    body = {
      model: state.model,
      stream: true,
      max_tokens: 256,
      messages: [{ role: 'user', content: '必须调用 get_time 工具，不要直接回答。' }],
      tools: [{ type: 'function', function: { name: 'get_time', description: '获取当前时间', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'required',
    };
  } else {
    throw new Error(`unknown test: ${kind}`);
  }

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  return summarizeResponse(res, text);
}

function summarizeResponse(res, text) {
  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    ok: res.ok,
    isHtml: /<html/i.test(text) || /^\s*<!doctype html/i.test(text),
    hasContent: text.includes('"content"'),
    hasToolCalls: text.includes('"tool_calls"'),
    hasReasoning: text.includes('"reasoning_content"'),
    hasDone: text.includes('[DONE]'),
    preview: text.slice(0, 5000),
  };
}

const CONTROL_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Local API Gateway</title>
  <style>
    :root { color-scheme: light dark; --bg:#0f172a; --panel:#111827; --muted:#94a3b8; --text:#e5e7eb; --accent:#38bdf8; --ok:#22c55e; --bad:#ef4444; --border:#334155; }
    *{box-sizing:border-box} body{margin:0;font-family:Inter,Segoe UI,Arial,sans-serif;background:linear-gradient(135deg,#0f172a,#111827);color:var(--text)}
    .wrap{max-width:1120px;margin:0 auto;padding:28px} .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px} .card{background:rgba(17,24,39,.92);border:1px solid var(--border);border-radius:16px;padding:18px;box-shadow:0 16px 48px rgba(0,0,0,.25)}
    h1{margin:0 0 8px;font-size:28px} h2{margin:0 0 14px;font-size:18px} p{color:var(--muted);line-height:1.55} label{display:block;margin:12px 0 6px;color:#cbd5e1;font-size:13px} input,select{width:100%;border:1px solid var(--border);border-radius:10px;background:#020617;color:var(--text);padding:10px 12px;font-size:14px} input[type=checkbox]{width:auto;margin-right:8px}
    .row{display:grid;grid-template-columns:1fr 130px;gap:10px}.buttons{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}button{border:0;border-radius:10px;padding:10px 14px;background:#1e293b;color:var(--text);cursor:pointer}button.primary{background:var(--accent);color:#001018;font-weight:700}button.danger{background:#7f1d1d}.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:999px;padding:6px 10px;color:#cbd5e1}.dot{width:9px;height:9px;border-radius:99px;background:var(--bad)}.dot.ok{background:var(--ok)}pre{white-space:pre-wrap;word-break:break-word;background:#020617;border:1px solid var(--border);border-radius:12px;padding:12px;max-height:420px;overflow:auto}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.small{font-size:12px;color:var(--muted)}
    @media(max-width:900px){.grid{grid-template-columns:1fr}.row{grid-template-columns:1fr}}
  </style>
</head>
<body><div class="wrap">
  <h1>Local API Gateway</h1>
  <p>给 ZCode/Cline 用的本地网关。只监听 127.0.0.1，不自动修改 ZCode 配置。ZCode 的 Base URL 手动填右侧网关地址。</p>
  <div class="grid">
    <div class="card">
      <h2>配置</h2>
      <label>目标 API Base URL</label><input id="targetBaseUrl" placeholder="https://example.com 或 https://example.com/v1" />
      <label>API Key</label><input id="apiKey" type="password" placeholder="sk-..." />
      <div class="row"><div><label>模型</label><input id="model" placeholder="grok-4.5" /></div><div><label>代理端口</label><input id="proxyPort" type="number" min="1024" max="65535" /></div></div>
      <label>请求模式</label><select id="mode"><option value="chat-auto-v1">Chat Completions：自动补 /v1</option><option value="chat-raw">Chat Completions：原样路径</option><option value="responses-auto-v1">Responses：自动补 /v1</option><option value="responses-raw">Responses：原样路径</option><option value="anthropic">Anthropic Messages：/v1/messages</option></select>
      <label><input id="shimZcodeProbe" type="checkbox" />兼容 ZCode 非流式连接探测（推荐开）</label>
      <label><input id="forceStream" type="checkbox" />把非流式请求强制转 stream=true（谨慎）</label>
      <div class="buttons"><button class="primary" onclick="saveAndStart()">保存并启动/热更新</button><button onclick="refresh()">刷新状态</button><button class="danger" onclick="stopProxy()">停止代理</button></div>
      <p class="small">不需要点停止；要换站点/Key/模式，改完点“保存并启动/热更新”。</p>
    </div>
    <div class="card">
      <h2>状态</h2>
      <div class="pill"><span id="dot" class="dot"></span><span id="status">加载中</span></div>
      <label>ZCode/Cline 里填写的 Base URL</label><input id="gateway" readonly class="mono" /><div class="buttons"><button onclick="copyGateway()">复制 Base URL</button></div>
      <p class="small">ZCode 类型选 Chat Completions 时填这个地址；不要在 ZCode 里填目标站地址。</p>
      <h2>测试</h2>
      <div class="buttons"><button onclick="runTest('models')">测 models</button><button onclick="runTest('probe')">测 ZCode 探测</button><button onclick="runTest('chat')">测非流式</button><button onclick="runTest('stream')">测 stream</button><button onclick="runTest('tools')">测 tools</button></div>
    </div>
  </div>
  <div class="card" style="margin-top:18px"><h2>输出</h2><pre id="output">等待操作...</pre></div>
</div>
<script>
async function api(path, body){ const r=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined}); const t=await r.text(); try{return JSON.parse(t)}catch{return {raw:t,status:r.status}} }
function form(){ return { targetBaseUrl: targetBaseUrl.value.trim(), apiKey: apiKey.value.trim(), model: model.value.trim(), proxyPort: Number(proxyPort.value), mode: mode.value, shimZcodeProbe: shimZcodeProbe.checked, forceStream: forceStream.checked }; }
function fill(s){ targetBaseUrl.value=s.targetBaseUrl||''; if(s.apiKeyMasked&&!apiKey.value) apiKey.placeholder=s.apiKeyMasked; model.value=s.model||''; proxyPort.value=s.proxyPort||8788; mode.value=s.mode||'chat-auto-v1'; shimZcodeProbe.checked=!!s.shimZcodeProbe; forceStream.checked=!!s.forceStream; gateway.value=s.gatewayBaseUrl||''; dot.className='dot '+(s.proxyRunning?'ok':''); status.textContent=s.proxyRunning?'运行中':'已停止'; }
async function refresh(){ const d=await api('/api/state'); fill(d.state); output.textContent=JSON.stringify(d,null,2); }
async function saveAndStart(){ const d=await api('/api/start', form()); fill(d.state); output.textContent=JSON.stringify(d,null,2); }
async function stopProxy(){ const d=await api('/api/stop', {}); fill(d.state); output.textContent=JSON.stringify(d,null,2); }
async function runTest(kind){ output.textContent='测试中...'; const d=await api('/api/test/'+kind, {}); output.textContent=JSON.stringify(d,null,2); }
async function copyGateway(){ await navigator.clipboard.writeText(gateway.value); output.textContent='已复制：'+gateway.value; }
refresh();
</script></body></html>`;

async function controlRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${CONTROL_PORT}`}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      sendHtml(res, CONTROL_HTML);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, { state: publicState(), logs: recentLogs });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/start') {
      const body = await readJson(req);
      const responseState = await serializeControlMutation(async () => {
        await saveState(body);
        const savedPort = state.proxyPort;
        await startProxy(savedPort);
        return publicState();
      });
      sendJson(res, 200, { ok: true, state: responseState });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const responseState = await serializeControlMutation(async () => {
        await stopProxy();
        return publicState();
      });
      sendJson(res, 200, { ok: true, state: responseState });
      return;
    }
    const testMatch = url.pathname.match(/^\/api\/test\/(models|probe|chat|stream|tools)$/);
    if (req.method === 'POST' && testMatch) {
      await serializeControlMutation(async () => {
        if (!proxyServer) await startProxy(state.proxyPort);
      });
      const result = await runTest(testMatch[1]);
      sendJson(res, 200, { ok: true, test: testMatch[1], result, state: publicState() });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    log('control error', { message: error?.message || String(error) });
    sendJson(res, 500, { error: { message: error?.message || String(error) }, state: publicState() });
  }
}

await loadState();
const controlServer = http.createServer(controlRequest);
controlServer.listen(CONTROL_PORT, HOST, () => {
  log('control dashboard started', { url: `http://${HOST}:${CONTROL_PORT}` });
});
