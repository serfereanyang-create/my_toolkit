/**
 * codeGraphBuild.test.ts — 代码图谱构建/指纹失效/跨文件查询
 *
 * 直接驱动 GraphBuilder + GraphStore + GraphQueryEngine（与 build_code_graph
 * 工具相同的底层路径），覆盖：构建→持久化→指纹一致复用→源码变更失效→
 * 跨文件调用者查询。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphBuilder } from '../src/graph/builder.js';
import { GraphStore } from '../src/graph/store.js';
import { GraphQueryEngine } from '../src/graph/query.js';

const AUTH_TS = `export function verifyToken(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  return validateTokenShape(trimmed);
}
function validateTokenShape(token: string): boolean {
  return token.length > 10;
}
`;

const ROUTES_TS = `import { verifyToken } from './auth';

export function protectedRoute(req: any) {
  const token = req.headers.authorization;
  if (!verifyToken(token)) {
    throw new Error('Unauthorized');
  }
  return handleRequest(req);
}
function handleRequest(req: any) {
  return { status: 'ok' };
}
`;

test('graph build persists with a source fingerprint and reloads cleanly', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'graph-build-test-'));
  try {
    await writeFile(join(ws, 'auth.ts'), AUTH_TS);
    await writeFile(join(ws, 'routes.ts'), ROUTES_TS);

    const store = new GraphStore(ws);
    const builder = new GraphBuilder(ws);
    const graph = await builder.build({ maxFiles: 50 });
    assert.ok(graph.stats.nodeCount > 0, 'nodes must be extracted');
    assert.ok(graph.stats.edgeCount > 0, 'call edges must be extracted');

    await store.save(graph);
    const reloaded = await store.load();
    assert.ok(reloaded, 'a matching fingerprint must reload');
    assert.equal(reloaded!.stats.nodeCount, graph.stats.nodeCount);
    assert.equal(reloaded!.stats.edgeCount, graph.stats.edgeCount);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('editing a source file invalidates the cached graph (stale detection)', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'graph-build-test-'));
  try {
    await writeFile(join(ws, 'auth.ts'), AUTH_TS);
    await writeFile(join(ws, 'routes.ts'), ROUTES_TS);

    const store = new GraphStore(ws);
    const graph = await new GraphBuilder(ws).build({ maxFiles: 50 });
    await store.save(graph);
    assert.ok(await store.load(), 'fresh cache must load');

    await writeFile(join(ws, 'auth.ts'), AUTH_TS + '\nexport function extraFn(): number { return 1; }\n');
    assert.equal(await store.load(), null, 'a changed fingerprint must invalidate the cache');
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('query engine resolves cross-file callers through imported symbols', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'graph-build-test-'));
  try {
    await writeFile(join(ws, 'auth.ts'), AUTH_TS);
    await writeFile(join(ws, 'routes.ts'), ROUTES_TS);

    const graph = await new GraphBuilder(ws).build({ maxFiles: 50 });
    const engine = new GraphQueryEngine(graph);

    const callers = engine.queryCallGraph('verifyToken', 'callers', 2, 10);
    const names = callers.nodes.map((item) => item.node);
    assert.ok(
      names.some((node) => node.name === 'protectedRoute' && node.loc.path === 'routes.ts'),
      `expected cross-file caller protectedRoute (routes.ts), got: ${JSON.stringify(names.map((n) => `${n.loc.path}::${n.name}`))}`,
    );

    const callees = engine.queryCallGraph('verifyToken', 'callees', 2, 10);
    assert.ok(
      callees.nodes.some((item) => item.node.name === 'validateTokenShape'),
      'same-file callee validateTokenShape must be found',
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
