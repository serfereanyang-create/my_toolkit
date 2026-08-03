import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUpstreamUrl,
  createLocalProbeResponse,
  isLocalProbe,
  transformRealRequest,
  upstreamPath,
} from './api-proxy-protocol.mjs';

const model = 'provider/gpt-5.6-sol';

const chatProbe = {
  model,
  stream: false,
  max_tokens: 1,
  messages: [{ role: 'user', content: 'hi' }],
};

const responsesProbe = {
  model,
  max_output_tokens: 1,
  input: [{
    role: 'user',
    content: [{ type: 'input_text', text: 'hi' }],
  }],
};

test('detects a Chat Completions local probe', () => {
  assert.equal(isLocalProbe('/chat/completions', chatProbe), true);
});

test('detects Responses local probes when stream is omitted or false', () => {
  assert.equal(isLocalProbe('/responses', responsesProbe), true);
  assert.equal(isLocalProbe('/responses', { ...responsesProbe, stream: false }), true);
  assert.equal(isLocalProbe('/responses', {
    ...responsesProbe,
    previous_response_id: null,
    instructions: '',
  }), true);
});

test('accepts absent or empty tool and legacy function arrays', () => {
  assert.equal(isLocalProbe('/chat/completions', {
    ...chatProbe,
    tools: [],
    functions: [],
  }), true);
  assert.equal(isLocalProbe('/responses', {
    ...responsesProbe,
    tools: [],
    functions: [],
  }), true);
});

test('does not classify a Responses request with tools as a probe', () => {
  assert.equal(isLocalProbe('/responses', {
    ...responsesProbe,
    tools: [{ type: 'function', function: { name: 'lookup' } }],
  }), false);
});

test('does not classify a continued Responses request as a probe', () => {
  assert.equal(isLocalProbe('/responses', {
    ...responsesProbe,
    previous_response_id: 'resp_previous',
  }), false);
});

test('does not classify a Responses request with instructions as a probe', () => {
  assert.equal(isLocalProbe('/responses', {
    ...responsesProbe,
    instructions: 'Answer concisely.',
  }), false);
});

test('does not classify a Responses request with a conversation as a probe', () => {
  assert.equal(isLocalProbe('/responses', {
    ...responsesProbe,
    conversation: 'conv_123',
  }), false);
});

test('does not classify a Responses request with a prompt as a probe', () => {
  assert.equal(isLocalProbe('/responses', {
    ...responsesProbe,
    prompt: { id: 'pmpt_123' },
  }), false);
});

test('does not classify a Chat request with legacy functions as a probe', () => {
  assert.equal(isLocalProbe('/chat/completions', {
    ...chatProbe,
    functions: [{ name: 'lookup' }],
  }), false);
});

test('only accepts an omitted or boolean false stream value', () => {
  assert.equal(isLocalProbe('/chat/completions', { ...chatProbe, stream: 'true' }), false);
  assert.equal(isLocalProbe('/responses', { ...responsesProbe, stream: 'true' }), false);
});

test('requires a non-empty trimmed model', () => {
  const { model: _chatModel, ...chatWithoutModel } = chatProbe;
  const { model: _responsesModel, ...responsesWithoutModel } = responsesProbe;

  assert.equal(isLocalProbe('/chat/completions', chatWithoutModel), false);
  assert.equal(isLocalProbe('/chat/completions', { ...chatProbe, model: '   ' }), false);
  assert.equal(isLocalProbe('/responses', responsesWithoutModel), false);
  assert.equal(isLocalProbe('/responses', { ...responsesProbe, model: '   ' }), false);
});

test('only classifies exact supported protocol paths', () => {
  assert.equal(isLocalProbe('/v1/chat/completions', chatProbe), false);
  assert.equal(isLocalProbe('/v1/responses', responsesProbe), false);
  assert.equal(isLocalProbe('/messages', chatProbe), false);
});

test('does not classify normal Chat Completions conversations', () => {
  assert.equal(isLocalProbe('/chat/completions', { ...chatProbe, stream: true }), false);
  assert.equal(isLocalProbe('/chat/completions', { ...chatProbe, max_tokens: 2 }), false);
  assert.equal(isLocalProbe('/chat/completions', {
    ...chatProbe,
    messages: [...chatProbe.messages, { role: 'assistant', content: 'hello' }],
  }), false);
  assert.equal(isLocalProbe('/chat/completions', {
    ...chatProbe,
    messages: [{ role: 'user', content: 'hello' }],
  }), false);
  assert.equal(isLocalProbe('/chat/completions', {
    ...chatProbe,
    tools: [{ type: 'function', function: { name: 'lookup' } }],
  }), false);
});

test('does not classify normal Responses conversations', () => {
  assert.equal(isLocalProbe('/responses', { ...responsesProbe, stream: true }), false);
  assert.equal(isLocalProbe('/responses', { ...responsesProbe, max_output_tokens: 2 }), false);
  assert.equal(isLocalProbe('/responses', {
    ...responsesProbe,
    input: [...responsesProbe.input, { role: 'assistant', content: [] }],
  }), false);
  assert.equal(isLocalProbe('/responses', {
    ...responsesProbe,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
  }), false);
  assert.equal(isLocalProbe('/responses', {
    ...responsesProbe,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'hi' },
        { type: 'input_text', text: 'again' },
      ],
    }],
  }), false);
});

test('creates a Chat Completions local probe response', () => {
  const response = createLocalProbeResponse('/chat/completions', model);

  assert.equal(response.id, 'chatcmpl-local-gateway-health');
  assert.equal(response.object, 'chat.completion');
  assert.equal(Number.isInteger(response.created), true);
  assert.equal(response.model, model);
  assert.equal(response.choices[0].index, 0);
  assert.equal(response.choices[0].message.role, 'assistant');
  assert.equal(response.choices[0].message.content, 'ok');
  assert.equal(response.choices[0].finish_reason, 'stop');
  assert.deepEqual(response.usage, {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
  });
});

test('creates a completed Responses local probe response', () => {
  const response = createLocalProbeResponse('/responses', model);

  assert.equal(response.id, 'resp_local_gateway_health');
  assert.equal(response.object, 'response');
  assert.equal(Number.isInteger(response.created_at), true);
  assert.equal(response.status, 'completed');
  assert.equal(response.model, model);
  assert.equal(response.output[0].id, 'msg_local_gateway_health');
  assert.equal(response.output[0].type, 'message');
  assert.equal(response.output[0].role, 'assistant');
  assert.equal(response.output[0].status, 'completed');
  assert.deepEqual(response.output[0].content[0], {
    type: 'output_text',
    text: 'ok',
    annotations: [],
  });
  assert.deepEqual(response.usage, {
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
  });
});

test('preserves Chat Completions streaming preference for non-Grok models', () => {
  const messages = [{ role: 'user', content: 'Hello' }];
  const payload = {
    model: '03351671-c6eb-47c4-84b7-72d2c60a8947/gpt-5.6-sol',
    stream: false,
    messages,
    temperature: 0.4,
    metadata: { request: 'chat' },
  };

  const transformed = transformRealRequest('/chat/completions', payload);

  assert.notStrictEqual(transformed, payload);
  assert.deepEqual(transformed, {
    ...payload,
    model: 'gpt-5.6-sol',
    stream: false,
  });
  assert.strictEqual(transformed.messages, messages);
  assert.equal(payload.model, '03351671-c6eb-47c4-84b7-72d2c60a8947/gpt-5.6-sol');
  assert.equal(payload.stream, false);

  const payloadWithoutStream = { ...payload };
  delete payloadWithoutStream.stream;
  const transformedWithoutStream = transformRealRequest('/chat/completions', payloadWithoutStream);
  assert.equal(Object.hasOwn(transformedWithoutStream, 'stream'), false);
  assert.equal(Object.hasOwn(payloadWithoutStream, 'stream'), false);
});

test('forces Grok Chat Completions requests to stream automatically', () => {
  assert.equal(transformRealRequest('/chat/completions', {
    model: '03351671-c6eb-47c4-84b7-72d2c60a8947/grok-4.5',
    stream: false,
    messages: [{ role: 'user', content: 'Hello' }],
  }).stream, true);

  assert.equal(transformRealRequest('/chat/completions', {
    model: 'grok-4.5',
    messages: [{ role: 'user', content: 'Hello' }],
  }).stream, true);
});

test('defaults max_tokens for Grok Chat Completions requests that omit it', () => {
  const transformed = transformRealRequest('/chat/completions', {
    model: 'grok-4.5',
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(transformed.max_tokens, 4096);
});

test('does not override an explicit max_tokens for Grok Chat Completions requests', () => {
  const transformed = transformRealRequest('/chat/completions', {
    model: 'grok-4.5',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(transformed.max_tokens, 32);
});

test('does not default max_tokens for non-Grok Chat Completions requests', () => {
  const transformed = transformRealRequest('/chat/completions', {
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(Object.hasOwn(transformed, 'max_tokens'), false);
});

test('defaults max_output_tokens for Grok Responses requests that omit it', () => {
  const transformed = transformRealRequest('/responses', {
    model: 'grok-4.5',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
  });
  assert.equal(transformed.max_output_tokens, 4096);
});

test('does not override an explicit max_output_tokens for Grok Responses requests', () => {
  const transformed = transformRealRequest('/responses', {
    model: 'grok-4.5',
    max_output_tokens: 64,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
  });
  assert.equal(transformed.max_output_tokens, 64);
});

test('does not default max_output_tokens for non-Grok Responses requests', () => {
  const transformed = transformRealRequest('/responses', {
    model: 'gpt-5.6-sol',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
  });
  assert.equal(Object.hasOwn(transformed, 'max_output_tokens'), false);
});

test('preserves Responses streaming preference for non-Grok models', () => {
  const input = [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }];
  const tools = [{ type: 'function', name: 'lookup' }];
  const toolChoice = { type: 'function', name: 'lookup' };
  const reasoning = { effort: 'high', summary: 'auto' };
  const payload = {
    model: '03351671-c6eb-47c4-84b7-72d2c60a8947/gpt-5.6-sol',
    stream: false,
    input,
    tools,
    tool_choice: toolChoice,
    reasoning,
    max_output_tokens: 400,
    metadata: { request: 'responses' },
  };

  const transformed = transformRealRequest('/responses', payload);

  assert.notStrictEqual(transformed, payload);
  assert.deepEqual(transformed, {
    ...payload,
    model: 'gpt-5.6-sol',
    stream: false,
  });
  assert.strictEqual(transformed.input, input);
  assert.strictEqual(transformed.tools, tools);
  assert.strictEqual(transformed.tool_choice, toolChoice);
  assert.strictEqual(transformed.reasoning, reasoning);
  assert.equal(payload.model, '03351671-c6eb-47c4-84b7-72d2c60a8947/gpt-5.6-sol');
  assert.equal(payload.stream, false);
});

test('forces Grok Responses requests to stream automatically', () => {
  assert.equal(transformRealRequest('/responses', {
    model: '03351671-c6eb-47c4-84b7-72d2c60a8947/grok-4.5',
    stream: false,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
  }).stream, true);

  assert.equal(transformRealRequest('/responses', {
    model: 'grok-4.5',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
  }).stream, true);
});

test('leaves payloads for unsupported paths unchanged', () => {
  const payload = { model, stream: false, messages: [] };

  assert.strictEqual(transformRealRequest('/messages', payload), payload);
});

test('maps supported protocol paths to upstream v1 paths', () => {
  assert.equal(upstreamPath('/models'), '/v1/models');
  assert.equal(upstreamPath('/chat/completions'), '/v1/chat/completions');
  assert.equal(upstreamPath('/responses'), '/v1/responses');
  assert.equal(upstreamPath('/health'), '/health');
});

test('buildUpstreamUrl builds a single /v1 prefix when base URL has no /v1 suffix', () => {
  const base = 'https://yunqiaoai.dpdns.org';
  assert.equal(buildUpstreamUrl(base, '/responses', ''), 'https://yunqiaoai.dpdns.org/v1/responses');
  assert.equal(buildUpstreamUrl(base, '/chat/completions', ''), 'https://yunqiaoai.dpdns.org/v1/chat/completions');
  assert.equal(buildUpstreamUrl(base, '/models', ''), 'https://yunqiaoai.dpdns.org/v1/models');
});

test('buildUpstreamUrl strips trailing slash from base URL', () => {
  const base = 'https://yunqiaoai.dpdns.org/';
  assert.equal(buildUpstreamUrl(base, '/responses', ''), 'https://yunqiaoai.dpdns.org/v1/responses');
  assert.equal(buildUpstreamUrl(base, '/chat/completions', ''), 'https://yunqiaoai.dpdns.org/v1/chat/completions');
});

test('buildUpstreamUrl does not duplicate /v1 when base URL already ends in /v1', () => {
  const base = 'https://yunqiaoai.dpdns.org/v1';
  assert.equal(buildUpstreamUrl(base, '/responses', ''), 'https://yunqiaoai.dpdns.org/v1/responses');
  assert.equal(buildUpstreamUrl(base, '/chat/completions', ''), 'https://yunqiaoai.dpdns.org/v1/chat/completions');
  assert.equal(buildUpstreamUrl(base, '/models', ''), 'https://yunqiaoai.dpdns.org/v1/models');
});

test('buildUpstreamUrl does not duplicate /v1 when base URL ends in /v1/', () => {
  const base = 'https://yunqiaoai.dpdns.org/v1/';
  assert.equal(buildUpstreamUrl(base, '/responses', ''), 'https://yunqiaoai.dpdns.org/v1/responses');
  assert.equal(buildUpstreamUrl(base, '/chat/completions', ''), 'https://yunqiaoai.dpdns.org/v1/chat/completions');
});

test('buildUpstreamUrl preserves search string', () => {
  assert.equal(
    buildUpstreamUrl('https://yunqiaoai.dpdns.org', '/models', '?limit=10'),
    'https://yunqiaoai.dpdns.org/v1/models?limit=10',
  );
  assert.equal(
    buildUpstreamUrl('https://yunqiaoai.dpdns.org/v1', '/models', '?limit=10'),
    'https://yunqiaoai.dpdns.org/v1/models?limit=10',
  );
});

test('buildUpstreamUrl leaves unsupported paths unchanged and does not add /v1', () => {
  assert.equal(
    buildUpstreamUrl('https://yunqiaoai.dpdns.org', '/health', ''),
    'https://yunqiaoai.dpdns.org/health',
  );
  assert.equal(
    buildUpstreamUrl('https://yunqiaoai.dpdns.org/v1', '/health', ''),
    'https://yunqiaoai.dpdns.org/health',
  );
  assert.equal(
    buildUpstreamUrl('https://yunqiaoai.dpdns.org', '/messages', ''),
    'https://yunqiaoai.dpdns.org/messages',
  );
});

test('buildUpstreamUrl preserves /v1 inside a sub-path base URL', () => {
  // A base that includes /v1 as part of a longer path should not be stripped.
  assert.equal(
    buildUpstreamUrl('https://example.com/api/v1', '/responses', ''),
    'https://example.com/api/v1/responses',
  );
});
