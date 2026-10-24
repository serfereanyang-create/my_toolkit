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

/** 在指定环境变量下取默认 embedder 的元数据，结束后一律还原环境。 */
function metadataWith(env: Record<string, string | undefined>) {
  const keys = ['AICODE_EMBED_PROVIDER', 'AICODE_EMBED_MODEL', 'OPENAI_API_KEY', 'AICODE_EMBED_BASE_URL'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return createDefaultEmbedder().getMetadata();
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the default embedder is neural whenever a key is available — no silent lexical fallback', () => {
  // 有 key 就该用真向量：语义检索的价值全在向量质量上，默认拿哈希凑等于白挂这个能力。
  const neural = metadataWith({ OPENAI_API_KEY: 'sk-test' });
  assert.equal(neural.name, 'openai');
  assert.equal(neural.model, 'text-embedding-3-small');
  assert.equal(neural.dimensions, 1536);
});

test('an explicit provider still wins over key detection, so offline stays possible', () => {
  const forcedLocal = metadataWith({ OPENAI_API_KEY: 'sk-test', AICODE_EMBED_PROVIDER: 'local' });
  assert.equal(forcedLocal.name, 'local');
  assert.equal(forcedLocal.model, 'local-hash-v1');

  const forcedModel = metadataWith({ OPENAI_API_KEY: 'sk-test', AICODE_EMBED_MODEL: 'bge-m3' });
  assert.equal(forcedModel.name, 'openai');
  assert.equal(forcedModel.model, 'bge-m3');
});

test('with neither a key nor a provider the default is the labelled local hash', () => {
  const local = metadataWith({});
  assert.equal(local.name, 'local');
  assert.equal(local.dimensions, 768);
});
