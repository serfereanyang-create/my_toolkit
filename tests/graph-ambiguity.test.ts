/**
 * graph-ambiguity.test.ts — 同名符号 / 大小写 / 部分匹配的解析口径
 *
 * 旧实现按名字查节点时只挑一个（exported 优先），同名符号的调用者永远查不到，
 * 输出却像“完整答案”；`analyzeImpact` 也会漏报影响面。这里用合成图固定语义：
 *  - 同名节点全部作为起点，并在结果里标 ambiguous；
 *  - 节点 ID（`file.ts::name`）可精确指定；
 *  - 精确匹配（大小写不敏感全等）优先，子串只算候选并标 partialMatch；
 *  - `analyzeImpact` 绝不把 `HandleRequest` 当成 `handle`。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphQueryEngine } from '../src/graph/query.js';
import type { CodeGraph, GraphEdge, GraphNode } from '../src/graph/types.js';

function node(id: string, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  const [path] = id.split('::');
  return {
    id,
    kind: 'function',
    name,
    exported: true,
    signature: `${name}()`,
    loc: { path: path ?? id, line: 1 },
    ...extra,
  };
}

function graph(nodes: GraphNode[], edges: GraphEdge[]): CodeGraph {
  const record: Record<string, GraphNode> = {};
  for (const n of nodes) record[n.id] = n;
  return {
    version: 1,
    generated: 0,
    root: '/repo',
    nodes: record,
    edges,
    stats: { nodeCount: nodes.length, edgeCount: edges.length, fileCount: new Set(nodes.map((n) => n.loc.path)).size },
  };
}

/**
 * 场景：one.ts 与 two.ts 各有一个 handler；callerA 调 two.ts 的，callerB 调 one.ts 的。
 */
const AMBIGUOUS_GRAPH = graph(
  [
    node('one.ts::handler', 'handler'),
    node('two.ts::handler', 'handler'),
    node('one.ts::callerB', 'callerB'),
    node('two.ts::callerA', 'callerA'),
    node('util.ts::run', 'run'),
  ],
  [
    { from: 'one.ts::callerB', to: 'one.ts::handler', type: 'call' },
    { from: 'two.ts::callerA', to: 'two.ts::handler', type: 'call' },
  ],
);

test('queryCallGraph uses every same-named node as a start and flags ambiguity', () => {
  const engine = new GraphQueryEngine(AMBIGUOUS_GRAPH);
  const result = engine.queryCallGraph('handler', 'callers', 2);

  assert.equal(result.startNodes?.length, 2, `两个 handler 都应作为起点：${JSON.stringify(result.startNodes)}`);
  assert.equal(result.ambiguous?.length, 2);
  assert.equal(result.partialMatch, undefined, '精确同名不应标 partialMatch');

  const ids = result.nodes.map((n) => n.node.id).sort();
  assert.deepEqual(ids, ['one.ts::callerB', 'two.ts::callerA'], `两个调用者都应出现：${ids}`);
});

test('queryCallGraph accepts a node ID to disambiguate', () => {
  const engine = new GraphQueryEngine(AMBIGUOUS_GRAPH);
  const result = engine.queryCallGraph('two.ts::handler', 'callers', 2);

  assert.deepEqual(result.startNodes, ['two.ts::handler']);
  assert.equal(result.ambiguous, undefined);
  assert.deepEqual(result.nodes.map((n) => n.node.id), ['two.ts::callerA']);
});

test('lowercase/partial names are candidates only, never exact answers', () => {
  const g = graph(
    [node('api.ts::HandleRequest', 'HandleRequest'), node('api.ts::client', 'client')],
    [{ from: 'api.ts::client', to: 'api.ts::HandleRequest', type: 'call' }],
  );
  const engine = new GraphQueryEngine(g);

  const byLower = engine.queryCallGraph('handlerequest', 'callers', 2);
  assert.equal(byLower.partialMatch, undefined, '大小写不敏感全等应视为精确匹配');
  assert.equal(byLower.startNodes?.length, 1);

  const partial = engine.queryCallGraph('handle', 'callers', 2);
  assert.equal(partial.partialMatch, true, '子串匹配必须标记为 partial');

  const impact = engine.analyzeImpact('handle');
  assert.deepEqual(impact.directImpact, [], '子串猜测不能当成精确符号的影响面');
  assert.deepEqual(impact.matchedNodes ?? [], []);

  // 精确名可以正常分析
  const exactImpact = engine.analyzeImpact('HandleRequest');
  assert.deepEqual(exactImpact.directImpact.map((n) => n.id), ['api.ts::client']);
});

test('analyzeImpact unions callers of all same-named nodes (no silent under-reporting)', () => {
  const engine = new GraphQueryEngine(AMBIGUOUS_GRAPH);
  const impact = engine.analyzeImpact('handler');

  assert.equal(impact.matchedNodes?.length, 2);
  assert.equal(impact.startNodes?.length, 2);
  assert.deepEqual(
    impact.directImpact.map((n) => n.id).sort(),
    ['one.ts::callerB', 'two.ts::callerA'],
    '两个同名 handler 的调用者都必须出现在影响面里',
  );
  assert.deepEqual(impact.affectedFiles.slice().sort(), ['one.ts', 'two.ts']);
  assert.equal(impact.risk, 'low');
});

test('findShortestPath and type relations use exact names', () => {
  const g = graph(
    [
      node('a.ts::start', 'start'),
      node('b.ts::middle', 'middle'),
      node('c.ts::end', 'end'),
      node('x.ts::End', 'End', { kind: 'class' }),
      node('y.ts::Derived', 'Derived', { kind: 'class' }),
    ],
    [
      { from: 'a.ts::start', to: 'b.ts::middle', type: 'call' },
      { from: 'b.ts::middle', to: 'c.ts::end', type: 'call' },
      { from: 'y.ts::Derived', to: 'x.ts::End', type: 'extends' },
    ],
  );
  const engine = new GraphQueryEngine(g);

  assert.deepEqual(engine.findShortestPath('start', 'end'), ['a.ts::start', 'b.ts::middle', 'c.ts::end']);
  assert.equal(engine.findShortestPath('sta', 'end'), null, '部分名不应返回路径');

  // 大小写敏感的精确名优先：'End' 与 'end' 并存时，'End' 指类，'end' 指函数。
  const relations = engine.queryTypeRelations('End');
  assert.deepEqual(relations.subclasses?.map((n) => n.id), ['y.ts::Derived']);
  assert.deepEqual(relations.superTypes ?? [], [], 'End 的父类型为空，不能拿 end 的边来凑');
});
