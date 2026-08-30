'use strict';

// 主进程 AI 服务：OpenAI 兼容配置存取（safeStorage 加密 key）、连接测试、SSE 流式生成与取消。
// 不在顶层 require('electron')：safeStorage 由 configureAiService 注入，fetch 可注入便于纯 Node 测试。

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILENAME = 'ai-config.json';
const DEFAULT_TEMPERATURE = 0.4;
const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;
const CONNECTION_TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 120_000; // spec §9：120s 无响应中断
const ERROR_SLICE = 200;

const NOT_CONFIGURED_MESSAGE = 'AI 服务尚未配置完整';
const RATE_LIMIT_MESSAGE = '请求被限流（429），请稍后重试';
const ENCRYPTION_UNAVAILABLE_MESSAGE = '系统不支持密钥加密存储，无法启用 AI 功能';

let state = {
  userDataPath: null,
  safeStorageApi: null,
  fetchImpl: null,
  streamTimeoutMs: STREAM_TIMEOUT_MS,
};

let inFlightController = null;

function normalizeStreamTimeout(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : STREAM_TIMEOUT_MS;
}

function configureAiService({ userDataPath, safeStorageApi, fetchImpl, streamTimeoutMs } = {}) {
  if (typeof userDataPath !== 'string' || userDataPath.trim() === '') {
    throw new Error('configureAiService 需要 userDataPath');
  }
  state = {
    userDataPath,
    safeStorageApi: safeStorageApi || null,
    fetchImpl: typeof fetchImpl === 'function' ? fetchImpl : null,
    streamTimeoutMs: normalizeStreamTimeout(streamTimeoutMs),
  };
}

function resetAiService() {
  state = {
    userDataPath: null,
    safeStorageApi: null,
    fetchImpl: null,
    streamTimeoutMs: STREAM_TIMEOUT_MS,
  };
}

function validateBaseUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('Base URL 必填');
  }
  const trimmed = url.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Base URL 无法解析，请检查格式（例如 https://api.example.com/v1）');
  }
  const isHttps = parsed.protocol === 'https:';
  const isLocalHttp = parsed.protocol === 'http:'
    && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (!isHttps && !isLocalHttp) {
    throw new Error('外网地址必须使用 https://（仅 http://localhost 或 http://127.0.0.1 允许 http）');
  }
  return trimmed;
}

// SSE 解析器：从文本中提取 delta.content；[DONE] 停止；非 data 行 / 坏 JSON 容错跳过。
function* parseSseStream(text) {
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const event of normalized.split('\n\n')) {
    for (const line of event.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      if (payload === '') continue;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
      const content = choice && choice.delta && typeof choice.delta.content === 'string'
        ? choice.delta.content
        : '';
      if (content) yield content;
    }
  }
}

function getConfigPath() {
  return path.join(state.userDataPath, CONFIG_FILENAME);
}

function readConfigFile() {
  if (!state.userDataPath) return null;
  let raw;
  try {
    raw = fs.readFileSync(getConfigPath(), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeConfigFile(config) {
  fs.mkdirSync(state.userDataPath, { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8');
}

function clampTemperature(value) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_TEMPERATURE;
  return Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, num));
}

function decryptCipher(cipher) {
  const safeStorage = state.safeStorageApi;
  if (!cipher || !safeStorage || typeof safeStorage.decryptString !== 'function') return '';
  try {
    const plain = safeStorage.decryptString(Buffer.from(cipher, 'base64'));
    return typeof plain === 'string' ? plain : '';
  } catch {
    return ''; // 解密失败（换机 / 密钥环变化）视为未配置
  }
}

function saveConfig(input = {}) {
  try {
    if (!state.userDataPath) return { ok: false, error: 'AI 服务尚未初始化' };
    const safeStorage = state.safeStorageApi;
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function'
      || safeStorage.isEncryptionAvailable() !== true) {
      return { ok: false, error: ENCRYPTION_UNAVAILABLE_MESSAGE };
    }
    const baseUrl = validateBaseUrl(input.baseUrl);
    const model = typeof input.model === 'string' ? input.model.trim() : '';
    if (!model) throw new Error('模型名称必填');

    const existing = readConfigFile();
    const previousCipher = existing && typeof existing.apiKeyCipher === 'string'
      ? existing.apiKeyCipher
      : '';
    let apiKeyCipher = previousCipher;
    if (input.apiKey === undefined || input.apiKey === null) {
      // 未传 key 字段：保留已存密文
    } else if (String(input.apiKey) === '') {
      apiKeyCipher = ''; // 空字符串 = 清除已存 key
    } else {
      apiKeyCipher = safeStorage.encryptString(String(input.apiKey)).toString('base64');
    }

    writeConfigFile({
      baseUrl,
      model,
      temperature: clampTemperature(input.temperature),
      apiKeyCipher,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// 渲染层可见配置：永不含明文 key
function getPublicConfig() {
  const config = readConfigFile();
  if (!config) {
    return { baseUrl: '', model: '', temperature: DEFAULT_TEMPERATURE, hasKey: false };
  }
  return {
    baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
    model: typeof config.model === 'string' ? config.model : '',
    temperature: clampTemperature(config.temperature),
    hasKey: decryptCipher(config.apiKeyCipher) !== '',
  };
}

function getRuntimeConfig() {
  const config = readConfigFile();
  if (!config) return null;
  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
  const model = typeof config.model === 'string' ? config.model.trim() : '';
  const apiKey = decryptCipher(config.apiKeyCipher);
  if (!baseUrl || !model || !apiKey) return null;
  return { baseUrl, model, apiKey, temperature: clampTemperature(config.temperature) };
}

function joinChatCompletions(baseUrl) {
  return String(baseUrl).trim().replace(/\/+$/, '') + '/chat/completions';
}

function requestHeaders(apiKey) {
  return apiKey
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
    : { 'Content-Type': 'application/json' };
}

function doFetch(url, init) {
  const impl = state.fetchImpl || globalThis.fetch;
  if (typeof impl !== 'function') throw new Error('当前环境没有可用的 fetch 实现');
  return impl(url, init);
}

function describeHttpError(status, bodyText) {
  if (status === 429) return RATE_LIMIT_MESSAGE;
  return `HTTP ${status}: ${String(bodyText || '').slice(0, ERROR_SLICE)}`;
}

function describeNetworkError(err) {
  return String((err && err.message) || err).slice(0, ERROR_SLICE);
}

function isAbortLike(err) {
  if (!err) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR';
}

function createStreamSignal(controller) {
  const timeoutSignal = AbortSignal.timeout(state.streamTimeoutMs);
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([controller.signal, timeoutSignal]);
  }
  // 回退：手动 setTimeout 触发 abort（与取消共用同一 controller）
  const timer = setTimeout(() => {
    controller.abort(new Error('生成请求超时'));
  }, state.streamTimeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}

async function testConnection() {
  const config = getRuntimeConfig();
  if (!config) return { ok: false, error: NOT_CONFIGURED_MESSAGE };
  try {
    const response = await doFetch(joinChatCompletions(config.baseUrl), {
      method: 'POST',
      headers: requestHeaders(config.apiKey),
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) return { ok: false, error: describeHttpError(response.status, text) };
    return { ok: true };
  } catch (err) {
    if (isAbortLike(err)) return { ok: false, error: `连接超时（${CONNECTION_TIMEOUT_MS / 1000} 秒）` };
    return { ok: false, error: describeNetworkError(err) };
  }
}

async function generateReviewStream({ messages, onDelta, onDone, onError } = {}) {
  const config = getRuntimeConfig();
  if (!config) {
    if (typeof onError === 'function') onError(NOT_CONFIGURED_MESSAGE);
    return { ok: false, error: NOT_CONFIGURED_MESSAGE };
  }

  // 单一在途请求：新请求开始前先中止旧的
  if (inFlightController) inFlightController.abort(new Error('新的生成请求开始'));
  const controller = new AbortController();
  inFlightController = controller;
  const streamSignal = createStreamSignal(controller);

  const decoder = new TextDecoder('utf8');
  let fullText = '';
  let buffer = '';
  let stopped = false;

  const emitEvent = (rawEvent) => {
    for (const piece of parseSseStream(rawEvent)) {
      fullText += piece;
      if (typeof onDelta === 'function') onDelta(piece);
    }
  };

  try {
    const response = await doFetch(joinChatCompletions(config.baseUrl), {
      method: 'POST',
      headers: requestHeaders(config.apiKey),
      body: JSON.stringify({
        model: config.model,
        messages: Array.isArray(messages) ? messages : [],
        stream: true,
        temperature: config.temperature,
      }),
      signal: streamSignal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const error = describeHttpError(response.status, text);
      if (typeof onError === 'function') onError(error);
      return { ok: false, error };
    }

    if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      try {
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const event = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            emitEvent(event);
          }
        }
        buffer += decoder.decode();
      } catch (err) {
        if (!isAbortLike(err) && !streamSignal.aborted && !controller.signal.aborted) throw err;
        stopped = true; // 中断 / 取消 / 超时：保留已收内容
      }
    } else {
      emitEvent(await response.text());
    }
  } catch (err) {
    if (!isAbortLike(err) && !streamSignal.aborted && !controller.signal.aborted) {
      const error = describeNetworkError(err);
      if (typeof onError === 'function') onError(error);
      return { ok: false, error };
    }
    stopped = true;
  }

  if (!stopped) emitEvent(buffer); // 冲刷未以空行结尾的残留事件
  if (inFlightController === controller) inFlightController = null;
  if (typeof onDone === 'function') onDone(fullText, { stopped });
  return { ok: true, stopped, text: fullText };
}

function cancelReview() {
  if (inFlightController) {
    inFlightController.abort(new Error('用户取消'));
    return true;
  }
  return false;
}

module.exports = {
  configureAiService,
  resetAiService,
  validateBaseUrl,
  parseSseStream,
  saveConfig,
  getPublicConfig,
  testConnection,
  generateReviewStream,
  cancelReview,
};
