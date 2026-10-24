import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicThinking, openaiReasoningEffort, isReasoningParamRejection } from '../src/providers/reasoning.js';
import { createOpenAIProvider } from '../src/providers/openai.js';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import type { ProviderToolSpec } from '../src/providers/types.js';

const tools: ProviderToolSpec[] = [
  { name: 'read_file', description: 'Read file', inputHint: '{ "path": "x" }', risk: 'read' },
];

function sseResponse(lines: string[]) {
  return new Response(`${lines.map((line) => `data: ${line}`).join('\n')}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('anthropicThinking maps tiers to real budget_tokens and disables for off/undefined', () => {
  assert.equal(anthropicThinking(undefined), undefined);
  assert.equal(anthropicThinking('off'), undefined);
  assert.deepEqual(anthropicThinking('low'), { type: 'enabled', budget_tokens: 2048 });
  assert.deepEqual(anthropicThinking('medium'), { type: 'enabled', budget_tokens: 6144 });
  assert.deepEqual(anthropicThinking('high'), { type: 'enabled', budget_tokens: 12288 });
  assert.deepEqual(anthropicThinking('max'), { type: 'enabled', budget_tokens: 24576 });
});

test('openaiReasoningEffort maps tiers and clamps max to high (no higher native tier)', () => {
  assert.equal(openaiReasoningEffort(undefined), undefined);
  assert.equal(openaiReasoningEffort('off'), undefined);
  assert.equal(openaiReasoningEffort('low'), 'low');
  assert.equal(openaiReasoningEffort('medium'), 'medium');
  assert.equal(openaiReasoningEffort('high'), 'high');
  assert.equal(openaiReasoningEffort('max'), 'high');
});

test('isReasoningParamRejection only fires on 4xx that names the field', () => {
  assert.equal(isReasoningParamRejection(400, 'unknown parameter: reasoning_effort'), true);
  assert.equal(isReasoningParamRejection(400, 'thinking not supported'), true);
  assert.equal(isReasoningParamRejection(400, 'budget_tokens too large'), true);
  assert.equal(isReasoningParamRejection(400, 'invalid api key'), false);
  assert.equal(isReasoningParamRejection(500, 'reasoning_effort'), false);
  assert.equal(isReasoningParamRejection(200, 'reasoning'), false);
});

test('OpenAI sends reasoning_effort in the request body when effort is set', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => {
    sentBody = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })]);
  };
  try {
    const provider = createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://openai.test/v1', model: 'm' });
    await provider.complete({
      messages: [{ role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
      tools,
      workspaceRoot: process.cwd(),
      reasoningEffort: 'high',
    });
    assert.equal(sentBody.reasoning_effort, 'high');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI omits reasoning_effort when effort is off', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => {
    sentBody = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })]);
  };
  try {
    const provider = createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://openai.test/v1', model: 'm' });
    await provider.complete({
      messages: [{ role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
      tools,
      workspaceRoot: process.cwd(),
      reasoningEffort: 'off',
    });
    assert.equal('reasoning_effort' in sentBody, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI downgrades (retries without reasoning_effort) when endpoint rejects it', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  let call = 0;
  globalThis.fetch = async (_url, init) => {
    call += 1;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    bodies.push(body);
    if (call === 1) {
      return new Response('unsupported parameter: reasoning_effort', { status: 400, headers: { 'content-type': 'text/plain' } });
    }
    return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })]);
  };
  try {
    const provider = createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://openai.test/v1', model: 'm' });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
      tools,
      workspaceRoot: process.cwd(),
      reasoningEffort: 'high',
    });
    // First attempt carried the param, second (retry) dropped it.
    assert.equal(bodies[0].reasoning_effort, 'high');
    assert.equal('reasoning_effort' in bodies[1], false);
    assert.deepEqual(result.actions, [{ type: 'message', content: 'ok' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic sends thinking budget and downgrades when the endpoint rejects it', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  let call = 0;
  globalThis.fetch = async (_url, init) => {
    call += 1;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    bodies.push(body);
    if (call === 1) {
      return new Response('thinking is not supported by this model', { status: 400, headers: { 'content-type': 'text/plain' } });
    }
    return sseResponse([
      JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } }),
      JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }),
    ]);
  };
  try {
    const provider = createAnthropicProvider({ apiKey: 'k', baseUrl: 'https://anthropic.test/v1', model: 'm' });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
      tools,
      workspaceRoot: process.cwd(),
      reasoningEffort: 'high',
    });
    assert.deepEqual(bodies[0].thinking, { type: 'enabled', budget_tokens: 12288 });
    assert.equal('thinking' in bodies[1], false);
    assert.deepEqual(result.actions, [{ type: 'message', content: 'hello' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic captures real cache_read_input_tokens into usage', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 80 } } }),
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }),
    JSON.stringify({ type: 'message_delta', usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 80 } }),
  ]);
  try {
    const provider = createAnthropicProvider({ apiKey: 'k', baseUrl: 'https://anthropic.test/v1', model: 'm' });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
      tools,
      workspaceRoot: process.cwd(),
    });
    assert.equal(result.usage?.inputTokens, 100);
    assert.equal(result.usage?.cacheReadTokens, 80);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI captures real cached_tokens from prompt_tokens_details', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 200, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 150 } } }),
  ]);
  try {
    const provider = createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://openai.test/v1', model: 'm' });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
      tools,
      workspaceRoot: process.cwd(),
    });
    // prompt_tokens is inclusive; the shared shape reports the fresh part.
    assert.equal(result.usage?.inputTokens, 50);
    assert.equal(result.usage?.cacheReadTokens, 150);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-responses capability is recognized (thinking tiers not stripped to off)', async () => {
  const { getReasoningCapability, clampReasoningEffort } = await import('../src/providers/capabilities.js');
  // gpt-5.x over the Responses wire format used to fall into the catch-all OFF
  // capability, silently stripping the desktop thinking tier.
  const capability = getReasoningCapability('openai-responses', 'gpt-5.5');
  assert.equal(capability.support, 'supported');
  assert.equal(clampReasoningEffort('high', capability), 'high');
  // Unknown custom models stay optimistic ('unknown' keeps the tier).
  const unknown = getReasoningCapability('openai-responses', 'my-relay-model');
  assert.equal(clampReasoningEffort('high', unknown), 'high');
  // Known non-reasoning models over Responses stay off.
  assert.equal(clampReasoningEffort('high', getReasoningCapability('openai-responses', 'gpt-4o')), 'off');
});

test('openai-responses retries once without reasoning when endpoint rejects the param', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'Unknown parameter: reasoning' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ output_text: 'ok', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { createOpenAIResponsesProvider } = await import('../src/providers/openai-responses.js');
    const provider = createOpenAIResponsesProvider({ apiKey: 'k', baseUrl: 'https://relay.example.test/v1', model: 'my-relay-model' });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
      tools: [], workspaceRoot: 'C:/work', reasoningEffort: 'high',
    });
    assert.equal(calls, 2);
    assert.deepEqual(bodies[0]?.reasoning, { effort: 'high' });
    assert.equal('reasoning' in bodies[1]!, false);
    assert.equal(result.actions[0]?.type, 'message');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
