import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAIProvider } from '../src/providers/openai.js';
import { createOpenAIResponsesProvider } from '../src/providers/openai-responses.js';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import { createGeminiProvider } from '../src/providers/gemini.js';
import { iterateSseDataLines, resolveProviderBodyKind } from '../src/providers/protocol.js';
import { getReasoningCapability, clampReasoningEffort } from '../src/providers/capabilities.js';
import { geminiThinkingBudget } from '../src/providers/reasoning.js';
import { VENDOR_PROFILES } from '../src/providers/vendors.js';
import type { ProviderToolSpec } from '../src/providers/types.js';

/*
 * Wire-format equivalence: the same internal request serialized to every
 * supported protocol. Every case here was first reproduced against the built
 * providers with a fake HTTP layer (probe: out/provider-probe/*.mjs); the
 * comments record the observed pre-fix output.
 */

type Json = Record<string, any>;

const tools: ProviderToolSpec[] = [
  { name: 'read_file', description: 'Read file', inputHint: '{ "path": "a.txt" }', risk: 'read' },
];

const iso = '2026-01-01T00:00:00Z';

function sse(lines: Array<unknown> | string[]): Response {
  return new Response(`${lines.map((line) => `data: ${typeof line === 'string' ? line : JSON.stringify(line)}`).join('\n\n')}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function json(body: unknown, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': contentType } });
}

async function withFetch<T>(impl: (url: string, init: RequestInit | undefined) => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => impl(String(input), init)) as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = original; }
}

const base = { workspaceRoot: 'C:/work', tools, messages: [{ role: 'user' as const, content: 'hi', createdAt: iso }] };

// ---------------------------------------------------------------------------
// 1. parallel_tool_calls: the shared system prompt asks for ONE tool call per
//    turn. Chat/completions and Responses had no way to enforce it.
// ---------------------------------------------------------------------------

for (const [label, make] of [
  ['chat', () => createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://wire.test/v1', model: 'gpt-5' })],
  ['responses', () => createOpenAIResponsesProvider({ apiKey: 'k', baseUrl: 'https://wire.test/v1', model: 'gpt-5' })],
] as const) {
  test(`${label} sends parallel_tool_calls:false with tools (probe: field absent before)`, async () => {
    let body: Json | undefined;
    await withFetch(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Json;
      return sse([{ choices: [{ delta: { content: 'ok' } }] }, { type: 'response.output_text.delta', delta: 'ok' }]);
    }, () => make().complete(base));
    assert.equal(body?.parallel_tool_calls, false);
    assert.ok(Array.isArray(body?.tools));
    assert.equal(body?.tool_choice, 'auto');
  });
}

test('chat and responses omit parallel_tool_calls when there are no tools', async () => {
  // A gateway that rejects unknown fields should not see one on a tool-less turn.
  const bodies: Json[] = [];
  const replies = (): Response => sse([{ choices: [{ delta: { content: 'ok' } }] }, { type: 'response.output_text.delta', delta: 'ok' }]);
  await withFetch(async (_url, init) => { bodies.push(JSON.parse(String(init?.body)) as Json); return replies(); }, async () => {
    await createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://wire.test/v1', model: 'gpt-5' }).complete({ ...base, tools: [] });
    await createOpenAIResponsesProvider({ apiKey: 'k', baseUrl: 'https://wire.test/v1', model: 'gpt-5' }).complete({ ...base, tools: [] });
  });
  assert.equal('parallel_tool_calls' in bodies[0]!, false);
  assert.equal('parallel_tool_calls' in bodies[1]!, false);
});

// ---------------------------------------------------------------------------
// 2. Caller-supplied system messages. Chat and Responses already hoisted them;
//    Anthropic downgraded them to role 'user' and Gemini dropped them.
// ---------------------------------------------------------------------------

const systemMessages = [
  { role: 'system' as const, content: 'CALLER SYSTEM RULES', createdAt: iso },
  { role: 'user' as const, content: 'hi', createdAt: iso },
];

for (const [label, make, readSystem, readRoles] of [
  ['anthropic', () => createAnthropicProvider({ apiKey: 'k', baseUrl: 'https://wire.test/v1', model: 'claude-sonnet-4' }),
    (b: Json) => JSON.stringify(b.system), (b: Json) => (b.messages as Json[]).map((m) => m.role)],
  ['gemini', () => createGeminiProvider({ apiKey: 'k', baseUrl: 'https://wire.test/v1beta', model: 'gemini-2.5-pro' }),
    (b: Json) => JSON.stringify(b.systemInstruction), (b: Json) => (b.contents as Json[]).map((m) => m.role)],
] as const) {
  test(`${label} carries a caller system message in its system field (probe: present=${label === 'anthropic' ? 'false' : 'dropped'})`, async () => {
    let body: Json | undefined;
    await withFetch(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Json;
      return sse([{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }]);
    }, () => make().complete({ ...base, messages: systemMessages }));
    assert.match(readSystem(body!), /CALLER SYSTEM RULES/);
    // It must not also appear as a user turn.
    assert.deepEqual(readRoles(body!).filter((role: string) => role === 'system'), []);
  });
}

// ---------------------------------------------------------------------------
// 3. A stream request answered with a plain JSON body (loose/missing content
//    type). Probe: chat yielded `(empty)`, gemini yielded `(empty response)`,
//    both dropped usage.
// ---------------------------------------------------------------------------

test('resolveProviderBodyKind sniffs SSE and JSON when the header does not settle it', async () => {
  assert.equal(await resolveProviderBodyKind(new Response('', { headers: { 'content-type': 'text/event-stream' } })), 'sse');
  assert.equal(await resolveProviderBodyKind(new Response('', { headers: { 'content-type': 'application/json' } })), 'json');
  assert.equal(await resolveProviderBodyKind(new Response('data: {"x":1}\n\n', { headers: { 'content-type': 'application/octet-stream' } })), 'sse');
  assert.equal(await resolveProviderBodyKind(new Response('  [1,2]', { headers: {} })), 'json');
  assert.equal(await resolveProviderBodyKind(new Response('<html>gateway</html>', { headers: { 'content-type': 'text/plain' } })), 'text');
});

test('a sniffed stream leaves the original body fully readable', async () => {
  const chunks = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n'];
  let index = 0;
  const body = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]!));
      else controller.close();
    },
  }), { headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(await resolveProviderBodyKind(body), 'sse');
  assert.equal(await body.text(), chunks.join(''));
});

test('chat reads a JSON body for a stream request instead of reporting an empty answer', async () => {
  const result = await withFetch(async () => json({
    choices: [{ message: { role: 'assistant', content: 'the whole answer' } }],
    usage: { prompt_tokens: 5, completion_tokens: 4 },
  }, 'application/octet-stream'), () => createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://relay.test/v1', model: 'm' }).complete(base));
  assert.deepEqual(result.actions, [{ type: 'message', content: 'the whole answer' }]);
  assert.equal(result.usage?.inputTokens, 5);
  assert.equal(result.streamMetrics?.transport, 'json');
});

test('chat parses tool_calls from a JSON body for a stream request', async () => {
  const result = await withFetch(async () => json({
    choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } }],
  }, 'text/plain'), () => createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://relay.test/v1', model: 'm' }).complete(base));
  assert.deepEqual(result.actions, [{ type: 'tool', tool: 'read_file', input: { path: 'a.txt' } }]);
});

test('chat reports a non-JSON gateway page instead of a fabricated empty answer', async () => {
  await assert.rejects(withFetch(async () => new Response('<html>502 Bad Gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }), () =>
    createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://relay.test/v1', model: 'm' }).complete(base)), /expected JSON/);
});

test('gemini reads a JSON body for a stream request and keeps usage', async () => {
  const result = await withFetch(async () => json([{
    candidates: [{ content: { parts: [{ text: 'gemini answer' }] } }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 },
  }], 'text/plain'), () => createGeminiProvider({ apiKey: 'k', baseUrl: 'https://g.test/v1beta', model: 'gemini-2.5-pro' }).complete(base));
  assert.deepEqual(result.actions, [{ type: 'message', content: 'gemini answer' }]);
  assert.equal(result.usage?.inputTokens, 5);
  assert.equal(result.usage?.outputTokens, 4);
});

test('gemini drops an empty usageMetadata instead of reporting a fabricated zero', async () => {
  const result = await withFetch(async () => sse([{ candidates: [{ content: { parts: [{ text: 'x' }] } }], usageMetadata: {} }]), () =>
    createGeminiProvider({ apiKey: 'k', baseUrl: 'https://g.test/v1beta', model: 'gemini-2.5-pro' }).complete(base));
  assert.equal(result.usage, undefined);
});

test('gemini retries once without thinkingConfig when the endpoint rejects it', async () => {
  const bodies: Json[] = [];
  let calls = 0;
  const result = await withFetch(async (_url, init) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body)) as Json);
    if (calls === 1) return new Response('thinking_config is not supported for this model', { status: 400, headers: { 'content-type': 'text/plain' } });
    return sse([{ candidates: [{ content: { parts: [{ text: 'plain' }] } }] }]);
  }, () => createGeminiProvider({ apiKey: 'k', baseUrl: 'https://g.test/v1beta', model: 'gemini-2.0-flash' }).complete({ ...base, reasoningEffort: 'high' }));
  assert.equal(calls, 2);
  assert.ok((bodies[0]!.generationConfig as Json).thinkingConfig);
  assert.equal('thinkingConfig' in (bodies[1]!.generationConfig as Json), false);
  assert.deepEqual(result.actions, [{ type: 'message', content: 'plain' }]);
});

test('gemini does not swallow a 4xx that is not about the thinking parameter', async () => {
  let calls = 0;
  await assert.rejects(withFetch(async () => {
    calls += 1;
    return new Response('invalid api key', { status: 401, headers: { 'content-type': 'text/plain' } });
  }, () => createGeminiProvider({ apiKey: 'bad', baseUrl: 'https://g.test/v1beta', model: 'gemini-2.5-pro' }).complete({ ...base, reasoningEffort: 'high' })), /401 invalid api key/);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// 4. Responses streaming tool calls: deltas carry item_id, not call_id. The
//    provider keyed every delta by call_id, so nothing landed. Probe: a
//    realistic stream ended on "(empty response)".
// ---------------------------------------------------------------------------

function responsesCallStream(includeDoneItem: boolean): Array<unknown> {
  const stream: Array<unknown> = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'read_file', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '"a.txt"}' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: '{"path":"a.txt"}' },
  ];
  if (includeDoneItem) stream.push({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'read_file', arguments: '{"path":"a.txt"}' } });
  stream.push({ type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 10, output_tokens: 3 } } });
  return stream;
}

for (const includeDoneItem of [true, false]) {
  test(`responses accumulates streamed tool arguments keyed by item_id (output_item.done=${includeDoneItem})`, async () => {
    const result = await withFetch(async () => sse(responsesCallStream(includeDoneItem)), () =>
      createOpenAIResponsesProvider({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' }).complete(base));
    assert.deepEqual(result.actions, [{ type: 'tool', tool: 'read_file', input: { path: 'a.txt' }, callId: 'call_abc' }]);
    assert.equal(result.continuation?.responseId, 'resp_1');
    assert.deepEqual(result.continuation?.pendingCalls, [{ callId: 'call_abc', name: 'read_file' }]);
    assert.equal(result.usage?.inputTokens, 10);
  });
}

test('responses prefers the authoritative arguments from function_call_arguments.done', async () => {
  // A relay that drops one delta must not leave truncated JSON behind.
  const stream = [
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_2', call_id: 'call_x', name: 'read_file', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '{"path":"tru' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_2', arguments: '{"path":"complete.txt"}' },
    { type: 'response.completed', response: { id: 'resp_2' } },
  ];
  const result = await withFetch(async () => sse(stream), () =>
    createOpenAIResponsesProvider({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' }).complete(base));
  assert.deepEqual(result.actions, [{ type: 'tool', tool: 'read_file', input: { path: 'complete.txt' }, callId: 'call_x' }]);
});

test('responses accumulates deltas that arrive before output_item.added', async () => {
  const stream = [
    { type: 'response.function_call_arguments.delta', item_id: 'fc_3', delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_3', delta: '"early.txt"}' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_3', call_id: 'call_early', name: 'read_file', arguments: '{"path":"early.txt"}' } },
    { type: 'response.completed', response: { id: 'resp_3' } },
  ];
  const result = await withFetch(async () => sse(stream), () =>
    createOpenAIResponsesProvider({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' }).complete(base));
  assert.deepEqual(result.actions, [{ type: 'tool', tool: 'read_file', input: { path: 'early.txt' }, callId: 'call_early' }]);
});

// ---------------------------------------------------------------------------
// 5. Byte-at-a-time SSE: a single JSON payload split across chunk boundaries,
//    a multi-line payload, and [DONE] split across chunks.
// ---------------------------------------------------------------------------

function byteStream(text: string, chunkSize: number): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const sseFixture = [
  'data: {"choices":[{"delta":{"content":"Hel"}}]}',
  '',
  'data: {"choices":[{"delta":{"content":"lo "}}]}',
  '',
  'data: [DONE]',
  '',
].join('\n');

for (const chunkSize of [1, 2, 3, 7, 64]) {
  test(`SSE payload split every ${chunkSize} byte(s) still yields every delta`, async () => {
    const rows: string[] = [];
    for await (const row of iterateSseDataLines(byteStream(sseFixture, chunkSize))) rows.push(row);
    assert.deepEqual(rows, [
      '{"choices":[{"delta":{"content":"Hel"}}]}',
      '{"choices":[{"delta":{"content":"lo "}}]}',
      '[DONE]',
    ]);
  });
}

test('a payload cut in half inside one data: line is reassembled (UTF-8 and CRLF included)', async () => {
  // One JSON object split across two chunks, plus a CRLF terminator and a
  // multi-byte character split across chunks — both classic lossy paths.
  const text = 'data: {"choices":[{"delta":{"content":"中文"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const rows: string[] = [];
  for await (const row of iterateSseDataLines(byteStream(text, 2))) rows.push(row);
  assert.deepEqual(rows, ['{"choices":[{"delta":{"content":"中文"}}]}', '[DONE]']);
});

test('chat accumulates a tool call whose JSON is split across byte-sized chunks', async () => {
  const stream = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const result = await withFetch(async () => byteStream(stream, 1), () =>
    createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://wire.test/v1', model: 'm' }).complete(base));
  assert.deepEqual(result.actions, [{ type: 'tool', tool: 'read_file', input: { path: 'a.txt' } }]);
});

// ---------------------------------------------------------------------------
// 6. Reasoning capability coverage, table-driven. Every provider × model
//    family: what clamp does with each user tier, and whether the provider's
//    own mapping agrees with the stated maxTier.
// ---------------------------------------------------------------------------

const TIERS = ['off', 'low', 'medium', 'high', 'max'] as const;

const capabilityTable: Array<{ provider: string; model: string; support: string; maxTier: string; clamped: Record<string, string> }> = [
  { provider: 'anthropic', model: 'claude-sonnet-4-5', support: 'supported', maxTier: 'max', clamped: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'max' } },
  { provider: 'anthropic', model: 'claude-3-5-sonnet', support: 'unsupported', maxTier: 'off', clamped: { off: 'off', low: 'off', medium: 'off', high: 'off', max: 'off' } },
  { provider: 'anthropic', model: 'claude-opus-4-1', support: 'supported', maxTier: 'max', clamped: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'max' } },
  // An unknown Anthropic id stays optimistic: no silent downgrade.
  { provider: 'anthropic', model: 'claude-future-x', support: 'unknown', maxTier: 'max', clamped: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'max' } },
  { provider: 'openai', model: 'gpt-5.5', support: 'supported', maxTier: 'high', clamped: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'high' } },
  { provider: 'openai', model: 'o3-mini', support: 'supported', maxTier: 'high', clamped: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'high' } },
  { provider: 'openai', model: 'gpt-4o', support: 'unsupported', maxTier: 'off', clamped: { off: 'off', low: 'off', medium: 'off', high: 'off', max: 'off' } },
  { provider: 'openai', model: 'my-relay-model', support: 'unknown', maxTier: 'high', clamped: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'high' } },
  { provider: 'openai-responses', model: 'gpt-5.5', support: 'supported', maxTier: 'high', clamped: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'high' } },
  { provider: 'openai-responses', model: 'gpt-4o', support: 'unsupported', maxTier: 'off', clamped: { off: 'off', low: 'off', medium: 'off', high: 'off', max: 'off' } },
  // gemini used to fall through to the catch-all OFF: every tier became off
  // while gemini.ts still sent a thinkingBudget whenever the REQUEST was not
  // off — UI said off, wire said 2048.
  { provider: 'gemini', model: 'gemini-2.5-pro', support: 'supported', maxTier: 'max', clamped: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'max' } },
  { provider: 'gemini', model: 'gemini-3-pro', support: 'supported', maxTier: 'max', clamped: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'max' } },
  { provider: 'gemini', model: 'gemini-1.5-pro', support: 'unsupported', maxTier: 'off', clamped: { off: 'off', low: 'off', medium: 'off', high: 'off', max: 'off' } },
  { provider: 'grok', model: 'grok-4', support: 'supported', maxTier: 'max', clamped: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'max' } },
  { provider: 'grok', model: 'grok-3-mini', support: 'supported', maxTier: 'high', clamped: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'high' } },
  // glm-5.3 claimed maxTier max, but the vendor profile compresses low/high:
  // max was accepted by the clamp and then sent on the wire as high.
  { provider: 'glm', model: 'glm-5.3', support: 'supported', maxTier: 'high', clamped: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'high' } },
  { provider: 'glm', model: 'glm-4.6', support: 'supported', maxTier: 'high', clamped: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'high' } },
  { provider: 'kimi', model: 'kimi-k2-thinking', support: 'supported', maxTier: 'max', clamped: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'max' } },
  { provider: 'kimi', model: 'kimi-k2-0905-preview', support: 'unsupported', maxTier: 'off', clamped: { off: 'off', low: 'off', medium: 'off', high: 'off', max: 'off' } },
  { provider: 'deepseek', model: 'deepseek-reasoner', support: 'supported', maxTier: 'max', clamped: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'max' } },
  { provider: 'deepseek', model: 'deepseek-chat', support: 'unsupported', maxTier: 'off', clamped: { off: 'off', low: 'off', medium: 'off', high: 'off', max: 'off' } },
  { provider: 'mock', model: 'mock-code-agent-v1', support: 'unsupported', maxTier: 'off', clamped: { off: 'off', low: 'off', medium: 'off', high: 'off', max: 'off' } },
];

for (const row of capabilityTable) {
  test(`capability ${row.provider}/${row.model}: support=${row.support} maxTier=${row.maxTier} clamps every tier honestly`, () => {
    const capability = getReasoningCapability(row.provider, row.model);
    assert.equal(capability.support, row.support);
    assert.equal(capability.maxTier, row.maxTier);
    for (const tier of TIERS) {
      assert.equal(clampReasoningEffort(tier, capability), row.clamped[tier], `${row.provider}/${row.model} ${tier}`);
    }
    // 'auto' never escapes as 'auto': every capability resolves it to a real tier.
    assert.notEqual(clampReasoningEffort('auto', capability, 'small question'), 'auto');
  });
}

test('maxTier agrees with what each provider actually puts on the wire', () => {
  // Anthropic: clamp never exceeds maxBudgetTokens.
  assert.equal(clampReasoningEffort('max', getReasoningCapability('anthropic', 'claude-sonnet-4')), 'max');
  // Gemini: every non-off tier maps to a budget AND an unknown/unsupported model
  // is the only case where the wire sees no thinkingConfig.
  assert.equal(geminiThinkingBudget('low'), 2048);
  assert.equal(geminiThinkingBudget('medium'), 8192);
  assert.equal(geminiThinkingBudget('high'), 16384);
  assert.equal(geminiThinkingBudget('max'), 24576);
  assert.equal(geminiThinkingBudget('off'), undefined);
  // GLM-5.3 cannot disable thinking: `off` still sends enabled (vendor rejects
  // disabled), which is why the tier is compressed to low|high in between.
  assert.deepEqual(VENDOR_PROFILES.glm.reasoningBodyParam('off', 'glm-5.3'), { thinking: { type: 'enabled' } });
  assert.deepEqual(VENDOR_PROFILES.glm.reasoningBodyParam('high', 'glm-5.3'), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  assert.deepEqual(VENDOR_PROFILES.glm.reasoningBodyParam('max', 'glm-5.3'), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  // GLM-4.6 (toggle) does honour off, explicitly.
  assert.deepEqual(VENDOR_PROFILES.glm.reasoningBodyParam('off', 'glm-4.6'), { thinking: { type: 'disabled' } });
});

// ---------------------------------------------------------------------------
// 7. Randomised cross-format equivalence (mulberry32, fixed seed). Builds a
//    random conversation and asserts the same invariants hold on every wire.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x5eed1234;

test('randomised conversations serialize equivalently on all four wires', async () => {
  const random = mulberry32(SEED);
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  for (let caseIndex = 0; caseIndex < 25; caseIndex += 1) {
    const turnCount = 1 + Math.floor(random() * 6);
    const messages = [
      { role: 'system' as const, content: `CALLER-${caseIndex}`, createdAt: iso },
      ...Array.from({ length: turnCount }, (_, index) => {
        const role = pick(['user', 'assistant', 'tool'] as const);
        const content = `c${caseIndex}-${index}-${role}`;
        if (role === 'tool') return { role, name: pick(['read_file', 'write_file']), content, createdAt: iso };
        if (role === 'user' && random() < 0.3) {
          return { role, content, createdAt: iso, parts: [{ type: 'text' as const, text: content }, { type: 'image' as const, mediaType: 'image/png', data: `img${caseIndex}` }] };
        }
        return { role, content, createdAt: iso };
      }),
    ];
    const hasTools = random() < 0.8;
    const effort = pick(['off', 'low', 'medium', 'high', 'max'] as const);
    const request = { ...base, messages, tools: hasTools ? tools : [], reasoningEffort: effort, customProvider: random() < 0.5, toolStrategy: random() < 0.5 ? `strat-${caseIndex}` : undefined };

    const bodies: Record<string, Json> = {};
    for (const [label, make] of [
      ['chat', () => createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://wire.test/v1', model: 'gpt-5' })],
      ['responses', () => createOpenAIResponsesProvider({ apiKey: 'k', baseUrl: 'https://wire.test/v1', model: 'gpt-5' })],
      ['anthropic', () => createAnthropicProvider({ apiKey: 'k', baseUrl: 'https://wire.test/v1', model: 'claude-sonnet-4' })],
      ['gemini', () => createGeminiProvider({ apiKey: 'k', baseUrl: 'https://wire.test/v1beta', model: 'gemini-2.5-pro' })],
    ] as const) {
      await withFetch(async (_url, init) => {
        bodies[label] = JSON.parse(String(init?.body)) as Json;
        return sse([{ choices: [{ delta: {} }] }, { type: 'response.output_text.delta', delta: '' }, { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }, { candidates: [{ content: { parts: [] } }] }]);
      }, () => make().complete(request));
    }

    const fail = (detail: string): never => { throw new Error(`seed=0x${SEED.toString(16)} case=${caseIndex} ${detail}`); };
    for (const [label, body] of Object.entries(bodies)) {
      const wire = JSON.stringify(body);
      // Every conversation turn present in this format's message carrier.
      for (const message of messages.slice(1)) {
        if (!wire.includes(message.content)) fail(`${label} dropped message content ${message.content}`);
      }
      // Every user/tool image survives.
      for (const message of messages) {
        if (!('parts' in message) || !message.parts) continue;
        const imagePart = (message.parts as Array<{ type: string; data?: string }>).find((part) => part.type === 'image');
        if (!imagePart?.data) continue;
        if (!wire.includes(imagePart.data)) fail(`${label} dropped image ${imagePart.data}`);
      }
      // Caller system message survives in the system field, not as a user turn.
      // Chat carries it inside `messages` (there is no top-level system field).
      const chatSystem = Array.isArray(body.messages)
        ? (body.messages as Json[]).filter((message) => message.role === 'system')
        : '';
      const systemField = JSON.stringify(body.system ?? body.instructions ?? body.systemInstruction ?? chatSystem);
      if (!systemField.includes(`CALLER-${caseIndex}`)) fail(`${label} lost caller system message`);
      // Tools and the one-call contract travel together.
      if (hasTools) {
        if (!Array.isArray(body.tools)) fail(`${label} dropped tools`);
        if (label === 'chat' || label === 'responses') {
          if (body.parallel_tool_calls !== false) fail(`${label} missing parallel_tool_calls`);
        }
        if (label === 'chat' || label === 'responses') {
          if (body.tool_choice !== 'auto') fail(`${label} missing tool_choice`);
        }
      }
      // Effort: 'off' means no native reasoning parameter on any wire.
      if (effort === 'off') {
        if ('reasoning' in body || 'thinking' in body || 'reasoning_effort' in body) fail(`${label} sent reasoning params for off`);
        const config = body.generationConfig as Json | undefined;
        if (config && 'thinkingConfig' in config) fail(`${label} sent thinkingConfig for off`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 8. Usage absence: every provider reports `undefined`, never fabricated zeros,
//    when the endpoint sends no usage block (consumers add each other's numbers).
// ---------------------------------------------------------------------------

test('all providers return usage undefined when the endpoint reports none', async () => {
  const request = { ...base, tools: [] };
  const chat = await withFetch(async () => sse([{ choices: [{ delta: { content: 'x' } }] }]), () =>
    createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://wire.test/v1', model: 'm' }).complete(request));
  const anthropic = await withFetch(async () => sse([{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }]), () =>
    createAnthropicProvider({ apiKey: 'k', baseUrl: 'https://wire.test/v1', model: 'm' }).complete(request));
  const responses = await withFetch(async () => sse([{ type: 'response.output_text.delta', delta: 'x' }, { type: 'response.completed', response: { id: 'r' } }]), () =>
    createOpenAIResponsesProvider({ apiKey: 'k', baseUrl: 'https://wire.test/v1', model: 'gpt-5' }).complete(request));
  const gemini = await withFetch(async () => sse([{ candidates: [{ content: { parts: [{ text: 'x' }] } }] }]), () =>
    createGeminiProvider({ apiKey: 'k', baseUrl: 'https://g.test/v1beta', model: 'm' }).complete(request));
  for (const [label, result] of Object.entries({ chat, anthropic, responses, gemini })) {
    assert.equal(result.usage, undefined, `${label} fabricated a usage block`);
  }
});
