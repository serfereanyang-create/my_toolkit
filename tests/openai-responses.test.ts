import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAIResponsesProvider } from '../src/providers/openai-responses.js';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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
  } finally {
    globalThis.fetch = originalFetch;
  }
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
