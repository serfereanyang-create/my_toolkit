import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import { createOpenAIProvider } from '../src/providers/openai.js';
import { iterateSseDataLines } from '../src/providers/protocol.js';
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

test('iterateSseDataLines yields data payloads', async () => {
  const response = sseResponse(['{"a":1}', '{"b":2}']);
  const rows: string[] = [];
  for await (const row of iterateSseDataLines(response)) rows.push(row);
  assert.deepEqual(rows.filter((row) => row !== '[DONE]'), ['{"a":1}', '{"b":2}']);
});

test('OpenAI streaming accumulates text deltas and tool call arguments', async () => {
  const originalFetch = globalThis.fetch;
  const deltas: string[] = [];
  globalThis.fetch = async () => sseResponse([
    JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
    JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
    JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }],
        },
      }],
    }),
    JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }],
        },
      }],
    }),
  ]);

  try {
    const provider = createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://openai.test/v1', model: 'm' });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
      tools,
      workspaceRoot: process.cwd(),
      onTextDelta: (delta) => deltas.push(delta),
    });
    assert.deepEqual(deltas, ['Hel', 'lo']);
    assert.deepEqual(result.actions, [{ type: 'tool', tool: 'read_file', input: { path: 'README.md' } }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic streaming accumulates text and tool_use input json', async () => {
  const originalFetch = globalThis.fetch;
  const deltas: string[] = [];
  globalThis.fetch = async () => sseResponse([
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } }),
    JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'read_file' } }),
    JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"' } }),
    JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '}' } }),
  ]);

  try {
    const provider = createAnthropicProvider({ apiKey: 'k', baseUrl: 'https://anthropic.test/v1', model: 'm' });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
      tools,
      workspaceRoot: process.cwd(),
      onTextDelta: (delta) => deltas.push(delta),
    });
    assert.deepEqual(deltas, ['Hi ', 'there']);
    assert.deepEqual(result.actions, [{ type: 'tool', tool: 'read_file', input: { path: 'a.ts' } }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
