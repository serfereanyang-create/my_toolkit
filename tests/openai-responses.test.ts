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
    assert.equal(seenBody?.instructions, 'instructions');
    assert.deepEqual(seenBody?.input, [{ role: 'user', content: 'hello' }]);
    assert.deepEqual(seenBody?.reasoning, { effort: 'high' });
    assert.equal(result.actions[0]?.type, 'message');
    assert.equal(result.usage?.inputTokens, 10);
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
