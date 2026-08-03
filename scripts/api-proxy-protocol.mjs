import { normalizeModelNameForUpstream } from './api-proxy-utils.mjs';

function isAbsentOrEmptyArray(value) {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

function hasValidCommonProbeFields(payload) {
  return typeof payload?.model === 'string'
    && payload.model.trim().length > 0
    && (payload.stream === undefined || payload.stream === false)
    && isAbsentOrEmptyArray(payload.tools)
    && isAbsentOrEmptyArray(payload.functions);
}

function isEmptyOptionalValue(value) {
  return value === undefined || value === null || value === '';
}

function isChatProbe(payload) {
  return hasValidCommonProbeFields(payload)
    && payload?.max_tokens === 1
    && Array.isArray(payload?.messages)
    && payload.messages.length === 1
    && payload.messages[0]?.role === 'user'
    && payload.messages[0]?.content === 'hi';
}

function isResponsesProbe(payload) {
  const item = payload?.input?.[0];
  const content = item?.content?.[0];

  return hasValidCommonProbeFields(payload)
    && payload?.max_output_tokens === 1
    && isEmptyOptionalValue(payload.previous_response_id)
    && isEmptyOptionalValue(payload.instructions)
    && isEmptyOptionalValue(payload.conversation)
    && isEmptyOptionalValue(payload.prompt)
    && Array.isArray(payload?.input)
    && payload.input.length === 1
    && item?.role === 'user'
    && Array.isArray(item?.content)
    && item.content.length === 1
    && content?.type === 'input_text'
    && content?.text === 'hi';
}

export function isLocalProbe(pathname, payload) {
  if (pathname === '/chat/completions') return isChatProbe(payload);
  if (pathname === '/responses') return isResponsesProbe(payload);
  return false;
}

function createChatProbeResponse(model, createdAt) {
  return {
    id: 'chatcmpl-local-gateway-health',
    object: 'chat.completion',
    created: createdAt,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  };
}

function createResponsesProbeResponse(model, createdAt) {
  return {
    id: 'resp_local_gateway_health',
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    model,
    output: [{
      id: 'msg_local_gateway_health',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: 'ok',
        annotations: [],
      }],
    }],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    },
  };
}

export function createLocalProbeResponse(pathname, model) {
  const createdAt = Math.floor(Date.now() / 1000);

  if (pathname === '/chat/completions') {
    return createChatProbeResponse(model, createdAt);
  }
  if (pathname === '/responses') {
    return createResponsesProbeResponse(model, createdAt);
  }
  return null;
}

function isGrokModel(model) {
  return typeof model === 'string' && /(^|[^a-z0-9])grok([^a-z0-9]|$)/i.test(model);
}

// Some Grok upstreams hang or stall indefinitely on chat/response requests
// that omit an output-length cap. Default one in for Grok only, and only
// when the caller did not specify their own limit.
const GROK_DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export function transformRealRequest(pathname, payload) {
  if (pathname !== '/chat/completions' && pathname !== '/responses') {
    return payload;
  }

  const normalizedModel = normalizeModelNameForUpstream(payload.model);
  const transformed = {
    ...payload,
    model: normalizedModel,
  };

  if (isGrokModel(normalizedModel)) {
    transformed.stream = true;

    if (pathname === '/chat/completions' && !Object.hasOwn(payload, 'max_tokens')) {
      transformed.max_tokens = GROK_DEFAULT_MAX_OUTPUT_TOKENS;
    }
    if (pathname === '/responses' && !Object.hasOwn(payload, 'max_output_tokens')) {
      transformed.max_output_tokens = GROK_DEFAULT_MAX_OUTPUT_TOKENS;
    }
  }

  return transformed;
}

export function upstreamPath(pathname) {
  if (pathname === '/models'
    || pathname === '/chat/completions'
    || pathname === '/responses') {
    return `/v1${pathname}`;
  }
  return pathname;
}

export function buildUpstreamUrl(baseUrl, pathname, search) {
  // Normalize base: drop trailing slash, then drop a trailing bare `/v1`
  // segment so a base like `https://host/v1` does not become `/v1/v1/...`.
  // A base like `https://host/api/v1` keeps the earlier segments intact.
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (base.endsWith('/v1')) {
    base = base.slice(0, -3);
  }
  return `${base}${upstreamPath(pathname)}${search || ''}`;
}
