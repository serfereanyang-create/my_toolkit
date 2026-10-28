import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAIProvider } from '../src/providers/openai.js';
import { createAnthropicProvider } from '../src/providers/anthropic.js';

type Json = Record<string, any>;

function stream(lines: unknown[]) {
  const body = `${lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function hasOpenAiImage(value: unknown, expected: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasOpenAiImage(item, expected));
  if (!value || typeof value !== 'object') return false;
  const record = value as Json;
  return record.type === 'image_url' && record.image_url?.url === `data:image/png;base64,${expected}`
    || Object.values(record).some((item) => hasOpenAiImage(item, expected));
}

function hasAnthropicImage(value: unknown, expected: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasAnthropicImage(item, expected));
  if (!value || typeof value !== 'object') return false;
  const record = value as Json;
  return record.type === 'image' && record.source?.type === 'base64' && record.source.data === expected
    || Object.values(record).some((item) => hasAnthropicImage(item, expected));
}

const messages = [
  { role: 'user' as const, content: 'inspect this', createdAt: 'now', parts: [{ type: 'image' as const, mediaType: 'image/png', data: 'dXNlcg==' }] },
  { role: 'tool' as const, name: 'computer_screenshot', content: 'window capture', createdAt: 'now', parts: [{ type: 'image' as const, mediaType: 'image/png', data: 'c2NyZWVu' }] },
];

test('OpenAI Chat wire preserves user and tool images', async () => {
  const originalFetch = globalThis.fetch;
  let body: Json | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return stream([{ choices: [{ delta: { content: 'ok' } }] }]);
  };
  try {
    await createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://openai.test/v1', model: 'fixture' }).complete({ messages, tools: [], workspaceRoot: 'C:/work' });
    assert.equal(hasOpenAiImage(body?.messages, 'dXNlcg=='), true);
    assert.equal(hasOpenAiImage(body?.messages, 'c2NyZWVu'), true);
  } finally { globalThis.fetch = originalFetch; }
});

test('Anthropic wire preserves user and tool images', async () => {
  const originalFetch = globalThis.fetch;
  let body: Json | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return stream([{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }, { type: 'message_stop' }]);
  };
  try {
    await createAnthropicProvider({ apiKey: 'k', baseUrl: 'https://anthropic.test/v1', model: 'fixture' }).complete({ messages, tools: [], workspaceRoot: 'C:/work' });
    assert.equal(hasAnthropicImage(body?.messages, 'dXNlcg=='), true);
    assert.equal(hasAnthropicImage(body?.messages, 'c2NyZWVu'), true);
  } finally { globalThis.fetch = originalFetch; }
});
