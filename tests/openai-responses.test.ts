import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAIResponsesProvider } from '../src/providers/openai-responses.js';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sseResponse(lines: string[]) {
  return new Response(`${lines.map((line) => `data: ${line}`).join('\n')}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('Responses provider posts instructions/input and maps output text and usage', async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  let seenBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    seenUrl = String(input);
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response({
      output_text: 'hello',
      output: [{ type: 'reasoning', summary: [{ text: 'plan' }] }],
      usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 6 } },
    });
  };
  try {
    const provider = createOpenAIResponsesProvider({ apiKey: process.env.OPENAI_API_KEY ?? 'test-key-from-env', baseUrl: 'https://api.example.test/v1', model: 'gpt-5' });
    const result = await provider.complete({
      messages: [
        { role: 'system', content: 'instructions', createdAt: new Date().toISOString() },
        { role: 'user', content: 'hello', createdAt: new Date().toISOString() },
      ],
      tools: [], workspaceRoot: 'C:/work', reasoningEffort: 'high',
    });
    assert.equal(seenUrl, 'https://api.example.test/v1/responses');
    // Caller-supplied system message leads the stable instructions prefix;
    // the built-in stable tool prompt follows it.
    assert.match(String(seenBody?.instructions), /^instructions\n\nYou are aicode/);
    assert.deepEqual(seenBody?.input, [{ role: 'user', content: 'hello' }]);
    assert.deepEqual(seenBody?.reasoning, { effort: 'high' });
    assert.equal(result.actions[0]?.type, 'message');
    // `input_tokens` is inclusive of the cached part; the shared shape is net.
    assert.equal(result.usage?.inputTokens, 4);
    assert.equal(result.usage?.cacheReadTokens, 6);
    assert.equal(result.thinking, 'plan');
    assert.equal(result.streamMetrics?.transport, 'json');
    assert.equal(result.streamMetrics?.eventCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Responses streaming exposes cadence metrics alongside text deltas', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' }),
    JSON.stringify({ type: 'response.output_text.delta', delta: ' world' }),
    JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 2, output_tokens: 2 } } }),
  ]);
  try {
    const deltas: string[] = [];
    const provider = createOpenAIResponsesProvider({ apiKey: 'k', baseUrl: 'https://api.example.test/v1', model: 'gpt-5' });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hello', createdAt: new Date().toISOString() }],
      tools: [], workspaceRoot: 'C:/work', reasoningEffort: 'off', onTextDelta: (delta) => deltas.push(delta),
    });
    assert.deepEqual(deltas, ['hello', ' world']);
    assert.equal(result.streamMetrics?.transport, 'sse');
    assert.equal(result.streamMetrics?.eventCount, 3);
    assert.equal(result.streamMetrics?.outputChars, 11);
    assert.equal(result.streamMetrics?.timeToFirstOutputMs !== null, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('Responses provider preserves user and tool image parts', async () => {
  const originalFetch = globalThis.fetch;
  let seenBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response({ output_text: 'seen' });
  };
  try {
    const provider = createOpenAIResponsesProvider({ apiKey: 'k', baseUrl: 'https://api.example.test/v1', model: 'gpt-5' });
    await provider.complete({
      messages: [
        { role: 'user', content: 'look at this', createdAt: new Date().toISOString(), parts: [{ type: 'image', mediaType: 'image/png', data: 'dXNlcg==' }] },
        { role: 'tool', name: 'computer_screenshot', content: 'window capture', createdAt: new Date().toISOString(), parts: [{ type: 'image', mediaType: 'image/png', data: 'c2NyZWVu' }] },
      ],
      tools: [], workspaceRoot: 'C:/work', reasoningEffort: 'off',
    });
    const input = seenBody?.input as Array<Record<string, unknown>>;
    assert.equal(input[0]?.role, 'user');
    assert.deepEqual(input[0]?.content, 'look at this');
    assert.deepEqual(input[1], { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,dXNlcg==' }] });
    assert.match(String(input[2]?.content), /\[tool:computer_screenshot\] window capture/);
    assert.deepEqual(input[3], { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,c2NyZWVu' }] });
  } finally { globalThis.fetch = originalFetch; }
});

test('Responses provider does not leak API key into URL', async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  globalThis.fetch = async (input) => { seenUrl = String(input); return response({ output_text: 'ok' }); };
  try {
    const provider = createOpenAIResponsesProvider({ apiKey: process.env.OPENAI_API_KEY ?? 'test-key-from-env', baseUrl: 'https://api.example.test/v1', model: 'gpt-5' });
    await provider.complete({ messages: [{ role: 'user', content: 'x', createdAt: new Date().toISOString() }], tools: [], workspaceRoot: 'C:/work', reasoningEffort: 'off' });
    assert.equal(seenUrl.includes('test-key-from-env'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('Responses provider skips previous_response_id for custom endpoints and replays full context', async () => {
  const originalFetch = globalThis.fetch;
  let seenBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response({ output_text: 'done', output: [] });
  };
  const iso = new Date().toISOString();
  try {
    const provider = createOpenAIResponsesProvider({ apiKey: 'k', baseUrl: 'https://relay.example.test/v1', model: 'gpt-5' });
    await provider.complete({
      messages: [
        { role: 'user', content: '把一行 ok3 写入 codex-approval-test3.txt', createdAt: iso },
        { role: 'tool', content: 'Wrote codex-approval-test3.txt (4 bytes)', name: 'write_file', createdAt: iso },
      ],
      tools: [], workspaceRoot: 'C:/work', reasoningEffort: 'off',
      customProvider: true,
      continuation: { responseId: 'resp_123', toolOutputs: [{ callId: 'call_1', output: 'Wrote codex-approval-test3.txt (4 bytes)' }] },
    });
    assert.equal('previous_response_id' in (seenBody ?? {}), false);
    // Full conversation replay: tool result surfaces as a user-role message so
    // the custom endpoint still sees complete context without server state.
    const input = seenBody?.input as Array<Record<string, unknown>>;
    assert.equal(input.length, 2);
    assert.equal(input[1]?.role, 'user');
    assert.match(String(input[1]?.content), /Wrote codex-approval-test3\.txt/);
  } finally { globalThis.fetch = originalFetch; }
});

test('Responses provider keeps server continuation for official OpenAI endpoint', async () => {
  const originalFetch = globalThis.fetch;
  let seenBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response({ output_text: 'done', output: [] });
  };
  try {
    const provider = createOpenAIResponsesProvider({ apiKey: 'k', model: 'gpt-5' });
    await provider.complete({
      messages: [{ role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
      tools: [], workspaceRoot: 'C:/work', reasoningEffort: 'off',
      continuation: { responseId: 'resp_123', toolOutputs: [{ callId: 'call_1', output: 'ok' }] },
    });
    assert.equal(seenBody?.previous_response_id, 'resp_123');
    assert.deepEqual(seenBody?.input, [{ type: 'function_call_output', call_id: 'call_1', output: 'ok' }]);
  } finally { globalThis.fetch = originalFetch; }
});
