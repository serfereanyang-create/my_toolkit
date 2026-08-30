/*
 * Provider connectivity test ("联通测试"). Sends one minimal request to the
 * configured provider endpoint using the exact same wire format the CLI uses
 * for real turns (OpenAI /chat/completions with Bearer, Anthropic /messages
 * with x-api-key). This isolates provider/network/auth problems from the
 * agent-bridge spawn path: if this passes but chat stays silent, the fault is
 * in the bridge, not the provider config.
 *
 * The fetch implementation is injectable so the logic (validation, HTTP-status
 * interpretation, sample extraction) is unit-testable without real network.
 */

const { cliProviderName, resolveBaseUrl } = require('./provider-map.cjs');

const DEFAULT_TIMEOUT_MS = 20000;

async function testProviderConnection({ providerConfig, apiKey }, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = deps.now ? deps.now() : Date.now();
  const elapsed = () => (deps.now ? deps.now() : Date.now()) - start;

  if (!providerConfig) return { ok: false, message: '未找到供应商配置' };

  const wire = cliProviderName(providerConfig); // mock | openai | anthropic
  if (wire === 'mock') {
    return { ok: true, status: 0, latencyMs: 0, message: 'Mock 供应商无需联通测试' };
  }

  const baseUrl = String(resolveBaseUrl(providerConfig) || '').trim().replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, message: 'Base URL 为空，请先填写。' };
  if (!apiKey) return { ok: false, message: '未配置 API Key，请先保存后再测试。' };
  const model = providerConfig.model;
  if (!model) return { ok: false, message: '未选择模型，请先在下方添加并设为默认。' };

  if (!fetchImpl) return { ok: false, message: '运行环境缺少 fetch，无法测试。' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const request = wire === 'anthropic'
      ? {
          url: `${baseUrl}/messages`,
          init: {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
            signal: controller.signal,
          },
        }
      : {
          url: `${baseUrl}/chat/completions`,
          init: {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ model, max_tokens: 16, stream: false, messages: [{ role: 'user', content: 'ping' }] }),
            signal: controller.signal,
          },
        };

    const response = await fetchImpl(request.url, request.init);
    return await interpret(response, elapsed(), wire, model);
  } catch (error) {
    return { ok: false, latencyMs: elapsed(), message: `请求失败：${networkHint(error, timeoutMs)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function interpret(response, latencyMs, wire, model) {
  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch {
    // Body may be unreadable on some errors; the status alone is still useful.
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      latencyMs,
      message: describeHttpError(response.status, bodyText, wire, model),
    };
  }

  // A 200 status alone does NOT mean the endpoint is a real API. A misconfigured
  // Base URL (classically missing the /v1 suffix) can land on a site's HTML
  // homepage, which also returns 200. That is exactly what makes chat silently
  // reply nothing: the agent parses no text from HTML. So require the body to be
  // a valid provider JSON response, otherwise report a config error.
  const contentType = readHeader(response, 'content-type');
  const json = safeJson(bodyText);
  if (!json) {
    const looksHtml = /text\/html/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(bodyText);
    const hint = looksHtml
      ? 'Base URL 可能不对：请求打到了网页而非 API（常见于缺少 /v1）。'
      : `端点返回了非 JSON 内容（content-type: ${contentType || '未知'}），检查 Base URL 是否正确。`;
    return { ok: false, status: response.status, latencyMs, message: hint };
  }

  const sample = extractSample(bodyText, wire);
  if (!sample) {
    // Valid JSON but no assistant text — real chat would also come back empty,
    // so treat it as a failure with a pointer at the likely culprit.
    return {
      ok: false,
      status: response.status,
      latencyMs,
      message: `端点返回了 JSON 但不含模型文本，检查模型名（${model}）或 Base URL 是否正确。`,
    };
  }

  return {
    ok: true,
    status: response.status,
    latencyMs,
    message: '连接成功，模型已响应。',
    sample: truncate(sample, 120),
  };
}

function readHeader(response, name) {
  try {
    if (response && response.headers && typeof response.headers.get === 'function') {
      return response.headers.get(name) || '';
    }
  } catch {
    // ignore
  }
  return '';
}

function describeHttpError(status, bodyText, wire, model) {
  const snippet = extractErrorSnippet(bodyText);
  const suffix = snippet ? `：${truncate(snippet, 200)}` : '';
  if (status === 401 || status === 403) return `认证失败 (${status})，API Key 无效或无权限${suffix}`;
  if (status === 404) {
    const hint = wire === 'anthropic'
      ? 'Base URL 是否正确（Anthropic 格式请求 {baseUrl}/messages），或模型名是否有误'
      : 'Base URL 是否应以 /v1 结尾，或模型名是否有误';
    return `未找到端点或模型 (404)。检查 ${hint}（当前模型：${model}）${suffix}`;
  }
  if (status === 429) return `触发速率限制 (429)，稍后再试${suffix}`;
  if (status >= 500) return `供应商服务错误 (${status})${suffix}`;
  if (status === 400) return `请求被拒绝 (400)，通常是模型名或参数不被接受${suffix}`;
  return `请求失败 (${status})${suffix}`;
}

function extractSample(bodyText, wire) {
  const json = safeJson(bodyText);
  if (!json) return '';
  if (wire === 'anthropic') {
    const block = Array.isArray(json.content) ? json.content.find((b) => b && b.type === 'text') : null;
    return block && typeof block.text === 'string' ? block.text : '';
  }
  const message = json.choices && json.choices[0] && json.choices[0].message;
  return message && typeof message.content === 'string' ? message.content : '';
}

function extractErrorSnippet(bodyText) {
  const json = safeJson(bodyText);
  if (json) {
    if (json.error) {
      if (typeof json.error === 'string') return json.error;
      if (typeof json.error.message === 'string') return json.error.message;
    }
    if (typeof json.message === 'string') return json.message;
  }
  return (bodyText || '').trim().slice(0, 200);
}

function networkHint(error, timeoutMs) {
  if (error && error.name === 'AbortError') return `请求超时（超过 ${Math.round(timeoutMs / 1000)}s），检查网络或 Base URL 是否可达`;
  const code = error && error.cause && error.cause.code ? error.cause.code : error && error.code;
  if (code === 'ENOTFOUND') return '域名解析失败，检查 Base URL 是否正确';
  if (code === 'ECONNREFUSED') return '连接被拒绝，目标端口未开放或地址错误';
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return '证书验证失败';
  return error instanceof Error ? error.message : String(error);
}

function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncate(value, max) {
  const str = String(value);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

module.exports = { testProviderConnection, describeHttpError, extractSample, networkHint };
