/**
 * depgraph-cycles.test.ts — 依赖图环检测 / 深度计算的终止性与正确性
 *
 * 旧实现用递归 DFS 并在找到一条环时 `return true` 整体回溯，实测：
 *  - `c -> a <-> b` 报出不存在的 `a -> b -> c -> a`，真环 `a <-> b` 反而丢失；
 *  - 两个互不相交的环只报第一个；
 *  - 20000 模块的链直接 RangeError（爆栈）。
 * 现在为迭代 Tarjan + SCC 内限流枚举基本环。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectCircularDependencies,
  calculateDependencyDepth,
  type DependencyGraph,
  type ModuleNode,
} from '../src/analysis/dependency-graph.js';

/** 用边集合构造最小 DependencyGraph（节点从边里自动补齐）。 */
function graphFromEdges(
  edges: Array<[string, string]>,
  extraNodes: string[] = [],
): DependencyGraph {
  const nodes = new Map<string, ModuleNode>();
  const adjacencyList = new Map<string, Set<string>>();
  const reverseAdjacencyList = new Map<string, Set<string>>();
  const ensure = (id: string) => {
    if (!nodes.has(id)) {
      nodes.set(id, { path: id, imports: [], importedBy: [], type: 'source' });
      adjacencyList.set(id, new Set());
      reverseAdjacencyList.set(id, new Set());
    }
  };
  for (const id of extraNodes) ensure(id);
  for (const [from, to] of edges) {
    ensure(from);
    ensure(to);
    adjacencyList.get(from)!.add(to);
    reverseAdjacencyList.get(to)!.add(from);
  }
  return { nodes, adjacencyList, reverseAdjacencyList };
}

/**
 * 环的起点由 SCC 遍历顺序决定（实现不承诺固定起点），断言时统一旋转到字典序最小节点，
 * 只校验「成员与顺序」这一语义。
 */
function toPath(cycle: string[]): string {
  const body = cycle.slice(0, -1);
  let best = 0;
  for (let i = 1; i < body.length; i++) {
    if (body[i]! < body[best]!) best = i;
  }
  return [...body.slice(best), ...body.slice(0, best), body[best]!].join(' -> ');
}

test('cycle detection reports only real cycles (no fabricated path through a tail)', () => {
  // c -> a，a <-> b：c 不在任何环里。
  const graph = graphFromEdges([
    ['c.ts', 'a.ts'],
    ['a.ts', 'b.ts'],
    ['b.ts', 'a.ts'],
  ]);
  const cycles = detectCircularDependencies(graph).map((c) => toPath(c.cycle));
  assert.deepEqual(cycles, ['a.ts -> b.ts -> a.ts']);
  assert.ok(!cycles.some((c) => c.includes('c.ts')), `c.ts 不应出现在环里：${cycles.join(' | ')}`);
});

test('two disjoint cycles are both reported', () => {
  const graph = graphFromEdges([
    ['a.ts', 'b.ts'],
    ['b.ts', 'a.ts'],
    ['c.ts', 'd.ts'],
    ['d.ts', 'c.ts'],
  ]);
  const cycles = detectCircularDependencies(graph).map((c) => toPath(c.cycle)).sort();
  assert.deepEqual(cycles, ['a.ts -> b.ts -> a.ts', 'c.ts -> d.ts -> c.ts']);
});

test('self-import is reported as a one-node cycle', () => {
  const graph = graphFromEdges([['solo.ts', 'solo.ts']]);
  const cycles = detectCircularDependencies(graph);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0]!.cycle, ['solo.ts', 'solo.ts']);
  assert.equal(cycles[0]!.severity, 'error');
});

test('barrel file cycle is reported once, not duplicated per entry point', () => {
  // index.ts 再导出 a，a 又 import index —— 经典 barrel 环。
  const graph = graphFromEdges([
    ['index.ts', 'a.ts'],
    ['a.ts', 'index.ts'],
    ['b.ts', 'index.ts'],
  ]);
  const cycles = detectCircularDependencies(graph);
  assert.equal(cycles.length, 1, `应只报一条环，实际：${cycles.map((c) => toPath(c.cycle)).join(' | ')}`);
  const cycle = new Set(cycles[0]!.cycle);
  assert.ok(cycle.has('index.ts') && cycle.has('a.ts'));
  assert.ok(!cycle.has('b.ts'), 'b.ts 只是导入者，不在环里');
});

test('maxCycles cap is honored on a dense SCC (阶乘级环数量不会先全量生成)', () => {
  // 10 个模块两两互相 import：基本环数量是阶乘级。旧实现先生成全部环再截断，
  // 实测 maxCycles=5 仍需 20s、堆 2.8GB；现在把配额传进搜索，秒回。
  const names = Array.from({ length: 10 }, (_, i) => `m${i}.ts`);
  const edges: Array<[string, string]> = [];
  for (const a of names) for (const b of names) if (a !== b) edges.push([a, b]);
  const graph = graphFromEdges(edges);

  const started = Date.now();
  const cycles = detectCircularDependencies(graph, { maxCycles: 5 });
  const elapsed = Date.now() - started;

  assert.equal(cycles.length, 5);
  assert.ok(elapsed < 5000, `稠密 SCC 应在限流下快速返回，实测 ${elapsed}ms`);
});

test('20000-module chain neither overflows the stack nor reports cycles', () => {
  const n = 20000;
  const edges: Array<[string, string]> = [];
  for (let i = 0; i < n - 1; i++) edges.push([`m${i}.ts`, `m${i + 1}.ts`]);
  const graph = graphFromEdges(edges);

  // 旧实现递归 DFS：这里会 RangeError: Maximum call stack size exceeded。
  assert.deepEqual(detectCircularDependencies(graph), []);
  assert.equal(calculateDependencyDepth(graph, 'm0.ts'), n - 1);
});

/**
 * mulberry32：定种子伪随机，失败信息里打印种子与 case 编号。
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('randomized: reported cycles are real cycles and every injected cycle is found', () => {
  const seed = 0x5eed1;
  const rand = mulberry32(seed);

  for (let caseIndex = 0; caseIndex < 60; caseIndex++) {
    const nodeCount = 2 + Math.floor(rand() * 8);
    const names = Array.from({ length: nodeCount }, (_, i) => `n${i}.ts`);
    const edges = new Set<string>();

    // 注入 1-2 个随机环（长度 >= 2）。
    const injected: string[][] = [];
    const cycleCount = 1 + Math.floor(rand() * 2);
    for (let c = 0; c < cycleCount; c++) {
      const len = 2 + Math.floor(rand() * Math.min(3, nodeCount - 1));
      const picks: string[] = [];
      while (picks.length < len) {
        const candidate = names[Math.floor(rand() * names.length)]!;
        if (!picks.includes(candidate)) picks.push(candidate);
      }
      for (let i = 0; i < picks.length; i++) {
        edges.add(`${picks[i]}\u0000${picks[(i + 1) % picks.length]}`);
      }
      injected.push(picks);
    }
    // 再撒少量随机边（可能制造额外环，不影响断言口径）。
    const extra = Math.floor(rand() * nodeCount);
    for (let i = 0; i < extra; i++) {
      const from = names[Math.floor(rand() * names.length)]!;
      const to = names[Math.floor(rand() * names.length)]!;
      if (from !== to) edges.add(`${from}\u0000${to}`);
    }

    const graph = graphFromEdges(
      [...edges].map((e) => e.split('\u0000') as [string, string]),
      names,
    );
    const cycles = detectCircularDependencies(graph, { maxCycles: 200 }).map((c) => c.cycle);

    for (const cycle of cycles) {
      const nodes = cycle.slice(0, -1);
      assert.ok(nodes.length > 0, `seed=${seed} case=${caseIndex}: 空环 ${JSON.stringify(cycle)}`);
      assert.equal(cycle[0], cycle[cycle.length - 1], `seed=${seed} case=${caseIndex}: 环首尾不一致 ${JSON.stringify(cycle)}`);
      for (let i = 0; i < nodes.length; i++) {
        const from = nodes[i]!;
        const to = nodes[(i + 1) % nodes.length]!;
        assert.ok(
          graph.adjacencyList.get(from)?.has(to),
          `seed=${seed} case=${caseIndex}: 报出的环含不存在的边 ${from} -> ${to}（${JSON.stringify(cycle)}）`,
        );
      }
      const unique = new Set(nodes);
      assert.equal(unique.size, nodes.length, `seed=${seed} case=${caseIndex}: 环内节点重复 ${JSON.stringify(cycle)}`);
    }

    for (const group of injected) {
      const groupSet = new Set(group);
      const found = cycles.some((cycle) => {
        const nodes = new Set(cycle.slice(0, -1));
        return nodes.size === groupSet.size && [...groupSet].every((n) => nodes.has(n));
      });
      assert.ok(
        found,
        `seed=${seed} case=${caseIndex}: 注入的环未报出 ${JSON.stringify(group)}（实际 ${JSON.stringify(cycles)}）`,
      );
    }
  }
});
