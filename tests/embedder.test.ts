/**
 * embedder.test.ts — embedding 生成器单元测试
 *
 * 真实 API 路径用 mock fetch 验证请求/响应契约；本地降级与错误
 * 路径直接断言行为。凭据一律从环境变量回退，不写夹具字面量。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodeEmbedder, createDefaultEmbedder } from '../src/semantic/embedder.js';

/** Float32 精度下的近似相等。 */
function assertVectorClose(actual: Float32Array, expected: number[], epsilon = 1e-6): void {
  assert.equal(actual.length, expected.length);
  expected.forEach((value, index) => {
    assert.ok(Math.abs(actual[index]! - value) < epsilon, `component ${index}: ${actual[index]} ~= ${value}`);
  });
}

test('openai provider without an API key fails loudly instead of faking embeddings', () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(
      () => new CodeEmbedder({ name: 'openai', fallback: 'none' }),
      /requires an API key/,
    );
  } finally {
    if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
  }
});

test('openai embeddings posts model+input and maps vectors by index order', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [0.4, 0.5, 0.6] },
        { index: 0, embedding: [0.1, 0.2, 0.3] },
      ],
      usage: { prompt_tokens: 17 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const embedder = new CodeEmbedder({
      name: 'openai',
      apiKey: process.env.OPENAI_API_KEY ?? 'env-fallback-only',
      model: 'text-embedding-3-small',
      dimensions: 3,
      batchSize: 2,
    });
    const response = await embedder.embed({ texts: ['first', 'second'] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.model, 'text-embedding-3-small');
    assert.deepEqual(calls[0]!.input, ['first', 'second']);
    assert.equal(response.vectors.length, 2);
    // index 字段重排：第一个输入对应 index 0 的向量
    assertVectorClose(response.vectors[0]!, [0.1, 0.2, 0.3]);
    assertVectorClose(response.vectors[1]!, [0.4, 0.5, 0.6]);
    assert.equal(response.tokenCount, 17);
    assert.equal(response.model, 'text-embedding-3-small');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai embeddings splits large batches across requests', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(JSON.stringify({
      data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
      usage: { prompt_tokens: body.input.length },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const embedder = new CodeEmbedder({
      name: 'openai',
      apiKey: process.env.OPENAI_API_KEY ?? 'env-fallback-only',
      model: 'text-embedding-3-small',
      dimensions: 3,
      batchSize: 2,
    });
    const response = await embedder.embed({ texts: ['a', 'b', 'c', 'd', 'e'] });
    assert.equal(calls, 3);
    assert.equal(response.vectors.length, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai embeddings surfaces API errors with status and body', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{"error":"bad key"}', {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

  try {
    const embedder = new CodeEmbedder({
      name: 'openai',
      apiKey: process.env.OPENAI_API_KEY ?? 'env-fallback-only',
      model: 'text-embedding-3-small',
      dimensions: 3,
      batchSize: 2,
    });
    await assert.rejects(
      embedder.embed({ texts: ['x'] }),
      /OpenAI embeddings request failed: 401/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('local provider produces honest local-hash vectors and metadata', async () => {
  const embedder = new CodeEmbedder({ name: 'local' });
  const metadata = embedder.getMetadata();
  assert.equal(metadata.name, 'local');
  assert.equal(metadata.model, 'local-hash-v1');

  const response = await embedder.embed({ texts: ['hello world', 'hello world'] });
  assert.equal(response.vectors.length, 2);
  assert.equal(response.model, 'local-hash-v1');
  // 相同文本 → 相同向量（确定性）
  assert.deepEqual(Array.from(response.vectors[0]!), Array.from(response.vectors[1]!));
  assert.equal(response.vectors[0]!.length, 768);
});

test('createDefaultEmbedder honors AICODE_EMBED_* overrides', () => {
  const previousProvider = process.env.AICODE_EMBED_PROVIDER;
  const previousModel = process.env.AICODE_EMBED_MODEL;
  const previousBaseUrl = process.env.AICODE_EMBED_BASE_URL;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.AICODE_EMBED_PROVIDER = 'openai';
  process.env.AICODE_EMBED_MODEL = 'text-embedding-3-large';
  process.env.AICODE_EMBED_BASE_URL = 'https://relay.example/v1';
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'env-fallback-only';
  try {
    const embedder = createDefaultEmbedder();
    const metadata = embedder.getMetadata();
    assert.equal(metadata.name, 'openai');
    assert.equal(metadata.model, 'text-embedding-3-large');
    assert.equal(metadata.baseUrl, 'https://relay.example/v1');
  } finally {
    if (previousProvider === undefined) delete process.env.AICODE_EMBED_PROVIDER; else process.env.AICODE_EMBED_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.AICODE_EMBED_MODEL; else process.env.AICODE_EMBED_MODEL = previousModel;
    if (previousBaseUrl === undefined) delete process.env.AICODE_EMBED_BASE_URL; else process.env.AICODE_EMBED_BASE_URL = previousBaseUrl;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});
