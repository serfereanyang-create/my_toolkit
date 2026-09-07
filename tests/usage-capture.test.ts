import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import { createOpenAIProvider } from '../src/providers/openai.js';
import { appendUsage, resolveUsageLogPath } from '../src/usage/ledger.js';
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

test('Anthropic extracts real usage from message_start and message_delta', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 42, output_tokens: 0 } } }),
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
    JSON.stringify({ type: 'message_delta', usage: { output_tokens: 17 } }),
  ]);
  try {
    const provider = createAnthropicProvider({ apiKey: 'k', baseUrl: 'https://anthropic.test/v1', model: 'm' });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
      tools,
      workspaceRoot: process.cwd(),
    });
    assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 17 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic usage is undefined when the stream reports none', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
  ]);
  try {
    const provider = createAnthropicProvider({ apiKey: 'k', baseUrl: 'https://anthropic.test/v1', model: 'm' });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
      tools,
      workspaceRoot: process.cwd(),
    });
    assert.equal(result.usage, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI streaming requests and reads the final usage chunk', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: { stream_options?: { include_usage?: boolean } } = {};
  globalThis.fetch = async (_url, init) => {
    sentBody = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    return sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }),
    ]);
  };
  try {
    const provider = createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://openai.test/v1', model: 'm' });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
      tools,
      workspaceRoot: process.cwd(),
    });
    assert.equal(sentBody.stream_options?.include_usage, true);
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 5 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI non-streaming reads usage block', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { stream?: boolean } : {};
    if (body.stream) {
      // Force fallback to non-streaming by killing the stream immediately.
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{}}]}\n\n'));
          controller.error(new Error('terminated'));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'done' } }],
      usage: { prompt_tokens: 100, completion_tokens: 25 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const provider = createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://openai.test/v1', model: 'm' });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
      tools,
      workspaceRoot: process.cwd(),
    });
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 25 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveUsageLogPath honors explicit > env > default', () => {
  assert.match(resolveUsageLogPath('/tmp/x/usage.jsonl'), /usage\.jsonl$/);
  assert.match(resolveUsageLogPath(undefined, { AICODE_USAGE_LOG: '/env/u.jsonl' } as NodeJS.ProcessEnv), /u\.jsonl$/);
  assert.match(resolveUsageLogPath(undefined, {} as NodeJS.ProcessEnv), /[\\/]\.aicode[\\/]usage\.jsonl$/);
});

test('appendUsage writes a JSONL line for real usage and skips empty usage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  const logPath = join(dir, 'usage.jsonl');
  try {
    await appendUsage(logPath, { ts: '2026-08-10T00:00:00.000Z', sessionId: 's1', provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: 42, outputTokens: 17 });
    await appendUsage(logPath, { ts: '2026-08-10T01:00:00.000Z', sessionId: 's2', provider: 'mock', model: 'mock', inputTokens: 0, outputTokens: 0 });
    await appendUsage(logPath, { ts: '2026-08-10T02:00:00.000Z', sessionId: 's3', provider: 'openai', model: 'gpt-5.5', inputTokens: 5, outputTokens: 9 });
    const content = await readFile(logPath, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2, 'empty usage line should be skipped');
    const first = JSON.parse(lines[0]);
    assert.equal(first.model, 'claude-opus-4-8');
    assert.equal(first.inputTokens, 42);
    assert.equal(first.outputTokens, 17);
    const second = JSON.parse(lines[1]);
    assert.equal(second.provider, 'openai');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
