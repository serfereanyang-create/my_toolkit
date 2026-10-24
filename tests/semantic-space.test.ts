/**
 * semantic-space.test.ts — 语义索引的「向量空间」契约
 *
 * 语义检索的价值全在一个前提上：索引和查询必须是同一个 embedding 空间。
 * 一旦换 embedder（默认会随 OPENAI_API_KEY 自动切换）而不重建，余弦相似度
 * 就是两个不同空间的数相乘——要么维度对不上直接算错，要么维度撞上却给出
 * 看着合理的乱序排名。后者比前者更危险，因为它不报错。
 *
 * 这里锁三件事：
 *   1. 查询引擎绝不回写索引元数据（修之前就是这样：守卫比的是它刚写进去的
 *      数字，等于永远通过）；
 *   2. 换了 embedder 却没 force，构建必须拒绝，而不是把两套空间混进一张表；
 *   3. force 重建会清空旧空间的向量。
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildSemanticIndexTool } from '../src/tools/semantic.js';
import { SemanticQueryEngine } from '../src/semantic/query.js';
import { SemanticStore } from '../src/semantic/store.js';
import { CodeEmbedder } from '../src/semantic/embedder.js';
import type { ToolContext } from '../src/tools/types.js';

/** 一个最小可索引工作区：两个导出符号足够验证重建行为。 */
async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aicode-semantic-space-'));
  await mkdir(join(root, 'src'), { recursive: true });
  // 索引器只收「≥5 行方法体」的导出符号，夹具必须足够长，否则一个候选都没有。
  await writeFile(join(root, 'src', 'math.ts'), [
    'export function addNumbers(a: number, b: number): number {',
    '  const sum = a + b;',
    '  const doubled = sum * 2;',
    '  const half = doubled / 2;',
    '  const label = `sum:${sum}`;',
    '  return label.length > 0 ? half : sum;',
    '}',
    'export function subtractNumbers(a: number, b: number): number {',
    '  const difference = a - b;',
    '  const squared = difference * difference;',
    '  const rooted = Math.sqrt(squared);',
    '  const label = `diff:${difference}`;',
    '  return label.length > 0 ? rooted : difference;',
    '}',
  ].join('\n'), 'utf8');
  return root;
}

function context(root: string): ToolContext {
  return { workspaceRoot: root, approval: 'auto' };
}

/** 在给定环境变量下跑一次构建，结束后还原环境。 */
async function buildWith(
  root: string,
  env: Record<string, string | undefined>,
  input: Record<string, unknown> = {},
) {
  const keys = ['AICODE_EMBED_PROVIDER', 'AICODE_EMBED_MODEL', 'AICODE_EMBED_FALLBACK', 'OPENAI_API_KEY'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await buildSemanticIndexTool.execute(
      buildSemanticIndexTool.validate({ maxFiles: 50, maxSymbols: 50, ...input }),
      context(root),
    );
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a lexical index reports itself as lexical, with provider, model and dimensions', async () => {
  const root = await makeWorkspace();
  try {
    const result = await buildWith(root, { AICODE_EMBED_PROVIDER: 'local' });
    assert.equal(result.ok, true, result.output);
    assert.match(result.output, /local\/local-hash-v1 \(768d, lexical approximation\)/);
    assert.match(result.output, /not a neural embedding model/);
    assert.equal((result.data as Record<string, unknown>).lexical, true);

    const store = new SemanticStore(root);
    try {
      const stats = store.getStats();
      assert.equal(stats.provider, 'local');
      assert.equal(stats.model, 'local-hash-v1');
      assert.equal(stats.dimensions, 768);
      assert.ok(stats.embeddingCount >= 2, `expected both symbols indexed, got ${stats.embeddingCount}`);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('switching embedder refuses to update incrementally and keeps the old index intact', async () => {
  const root = await makeWorkspace();
  try {
    const first = await buildWith(root, { AICODE_EMBED_PROVIDER: 'local', AICODE_EMBED_MODEL: 'local-hash-v1' });
    assert.equal(first.ok, true, first.output);

    // 同名 provider、不同 model：维度一样（768），所以维度守卫不会救你。
    const second = await buildWith(root, { AICODE_EMBED_PROVIDER: 'local', AICODE_EMBED_MODEL: 'local-hash-v2' });
    assert.equal(second.ok, false, 'a model switch must not be applied as an incremental update');
    assert.equal((second.data as Record<string, unknown>).error, 'embedder_changed');
    assert.match(second.output, /local-hash-v1 \(768d\).*local-hash-v2 \(768d\)/s);
    assert.match(second.output, /force: true/);

    const store = new SemanticStore(root);
    try {
      const stats = store.getStats();
      assert.equal(stats.model, 'local-hash-v1', 'the refused build must not relabel the index');
      assert.ok(stats.embeddingCount >= 2);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('force rebuild purges the old vector space instead of mixing the two', async () => {
  const root = await makeWorkspace();
  try {
    assert.equal((await buildWith(root, { AICODE_EMBED_PROVIDER: 'local', AICODE_EMBED_MODEL: 'local-hash-v1' })).ok, true);

    const rebuilt = await buildWith(
      root,
      { AICODE_EMBED_PROVIDER: 'local', AICODE_EMBED_MODEL: 'local-hash-v2' },
      { force: true },
    );
    assert.equal(rebuilt.ok, true, rebuilt.output);
    const data = rebuilt.data as Record<string, unknown>;
    assert.equal(data.model, 'local-hash-v2');
    assert.equal(data.unchanged, 0, 'force means every symbol is re-embedded, none skipped by fingerprint');
    assert.ok(Number(data.embedded) >= 2);

    const store = new SemanticStore(root);
    try {
      const stats = store.getStats();
      assert.equal(stats.model, 'local-hash-v2');
      // 旧空间的行必须消失：清空后重建，行数等于本次嵌入数
      assert.equal(stats.embeddingCount, Number(data.embedded));
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a query from another embedding space fails loudly and never rewrites the index metadata', async () => {
  const root = await makeWorkspace();
  try {
    assert.equal((await buildWith(root, { AICODE_EMBED_PROVIDER: 'local' })).ok, true);

    // 维度不同的外来 embedder（openai 1536d）
    const foreign = new CodeEmbedder({ name: 'openai', apiKey: 'test-only', baseUrl: 'http://127.0.0.1:9/v1' });
    const engine = new SemanticQueryEngine(root, foreign);
    try {
      await assert.rejects(
        () => engine.search('add two numbers'),
        /dimension mismatch: the index holds 768 dims .* at 1536 dims/,
      );
      // 关键回归：查询方不得把自己的元数据写进索引
      assert.equal(engine.getStats().model, 'local-hash-v1');
      assert.equal(engine.getStats().dimensions, 768);
    } finally {
      engine.close();
    }

    const store = new SemanticStore(root);
    try {
      const stats = store.getStats();
      assert.equal(stats.provider, 'local');
      assert.equal(stats.model, 'local-hash-v1');
      assert.equal(stats.dimensions, 768);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
