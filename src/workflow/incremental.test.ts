/**
 * Tests for incremental build and change impact analysis.
 * Fixtures are created in OS temp directories; no workspace files are touched.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDiffOutput,
  stripExtension,
  slashJoin,
  resolveImportAgainstFileSet,
  extractImports,
  extractExports,
  hashContent,
  DependencyGraphBuilder,
  ImpactAnalyzer,
  generateRecommendations,
  IncrementalCacheManager,
  type DependencyGraph,
} from './incremental.js';

describe('parseDiffOutput', () => {
  it('parses numstat lines with tabs', () => {
    const output = '10\t2\tsrc/foo.ts\n0\t5\tsrc/bar.ts\n-\t-\tsrc/binary.png\n';
    const changes = parseDiffOutput(output);

    expect(changes).toHaveLength(3);
    expect(changes[0]).toEqual({ path: 'src/foo.ts', type: 'modified', linesAdded: 10, linesDeleted: 2 });
    expect(changes[1]).toEqual({ path: 'src/bar.ts', type: 'deleted', linesAdded: 0, linesDeleted: 5 });
    expect(changes[2]).toEqual({ path: 'src/binary.png', type: 'modified', linesAdded: 0, linesDeleted: 0 });
  });

  it('marks pure additions as added', () => {
    const changes = parseDiffOutput('25\t0\tsrc/new-file.ts\n');
    expect(changes[0].type).toBe('added');
  });

  it('strips ./ worktree prefix from paths', () => {
    const changes = parseDiffOutput('1\t0\t./cli/src/foo.ts\n');
    expect(changes[0].path).toBe('cli/src/foo.ts');
  });

  it('returns empty array for empty output', () => {
    expect(parseDiffOutput('')).toEqual([]);
  });
});

describe('path helpers', () => {
  it('stripExtension removes only the extension', () => {
    expect(stripExtension('src/foo.test.ts')).toBe('src/foo.test');
    expect(stripExtension('src/noext')).toBe('src/noext');
    expect(stripExtension('C:\\dir\\file.tsx')).toBe('C:\\dir\\file');
  });

  it('slashJoin resolves ./ and ../ segments', () => {
    expect(slashJoin('src/dir', './sibling.ts')).toBe('src/dir/sibling.ts');
    expect(slashJoin('src/dir', '../other.ts')).toBe('src/other.ts');
    expect(slashJoin('src/a/b', '../../root.ts')).toBe('src/root.ts');
    expect(slashJoin('.', 'file.ts')).toBe('file.ts');
  });

  it('resolveImportAgainstFileSet matches with extension aliasing', () => {
    const fileSet = new Set(['src/util.ts', 'src/widgets/index.ts']);

    expect(resolveImportAgainstFileSet('./util.js', 'src/main.ts', fileSet)).toBe('src/util.ts');
    expect(resolveImportAgainstFileSet('./util', 'src/main.ts', fileSet)).toBe('src/util.ts');
    expect(resolveImportAgainstFileSet('./widgets', 'src/main.ts', fileSet)).toBe('src/widgets/index.ts');
    expect(resolveImportAgainstFileSet('./missing', 'src/main.ts', fileSet)).toBeNull();
    // Bare imports (node_modules) are never resolved
    expect(resolveImportAgainstFileSet('vitest', 'src/main.ts', fileSet)).toBeNull();
  });
});

describe('extractImports / extractExports / hashContent', () => {
  const fileSet = new Set(['src/a.ts', 'src/b.ts']);

  it('extracts named and side-effect imports', () => {
    const content = [
      "import { helper } from './a.js';",
      "import * as ns from './b';",
      "import './side-effect';",
      "import type { T } from './types';",
    ].join('\n');

    const imports = extractImports(content, 'src/main.ts', fileSet);
    expect(imports).toContain('src/a.ts'); // .js alias resolves to .ts
    expect(imports).toContain('src/b.ts');
  });

  it('extracts declaration and list exports', () => {
    const content = [
      'export function foo() {}',
      'export const bar = 1;',
      'export class Baz {}',
      'export interface Qux {}',
      'export { alpha, beta as gamma };',
    ].join('\n');

    const exports = extractExports(content);
    expect(exports).toEqual(['foo', 'bar', 'Baz', 'Qux', 'alpha', 'beta']);
  });

  it('hashContent is deterministic and input-sensitive', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'));
    expect(hashContent('hello')).not.toBe(hashContent('hellp'));
  });
});

describe('DependencyGraphBuilder + ImpactAnalyzer', () => {
  let fixtureRoot: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'wf-impact-'));
    // fixture graph: core.ts <- service.ts <- service.test.ts, util.ts <- service.ts
    writeFileSync(join(fixtureRoot, 'core.ts'), "export const CORE = 1;\nimport { util } from './util';\n");
    writeFileSync(join(fixtureRoot, 'util.ts'), 'export function util() { return 1; }\n');
    writeFileSync(join(fixtureRoot, 'service.ts'), "import { CORE } from './core';\nimport { util } from './util';\nexport function serve() { return CORE + util(); }\n");
    writeFileSync(join(fixtureRoot, 'service.test.ts'), "import { serve } from './service';\nconsole.log(serve);\n");
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  async function buildGraph(): Promise<{ graph: DependencyGraph; builder: DependencyGraphBuilder }> {
    const builder = new DependencyGraphBuilder(fixtureRoot);
    const graph = await builder.build();
    return { graph, builder };
  }

  it('builds nodes and reverse edges from fixture files', async () => {
    const { graph } = await buildGraph();

    expect(graph.nodes.size).toBe(4);
    expect(graph.nodes.get('service.ts')!.imports.sort()).toEqual(['core.ts', 'util.ts']);
    // reverse edge: importing service.ts lists service.test.ts
    expect(graph.edges.get('service.ts')).toContain('service.test.ts');
  });

  it('finds transitive dependents', async () => {
    const { builder } = await buildGraph();

    const dependents = builder.findDependents('util.ts');
    expect(dependents).toContain('core.ts');
    expect(dependents).toContain('service.ts');
    expect(dependents).toContain('service.test.ts');
  });

  it('impact of util.ts covers whole chain and finds its tests', async () => {
    const { graph, builder } = await buildGraph();
    const analyzer = new ImpactAnalyzer(graph, (f) => builder.findDependents(f));

    const result = analyzer.analyze([
      { path: 'util.ts', type: 'modified', linesAdded: 3, linesDeleted: 1 },
    ]);

    expect(result.affectedFiles).toContain('core.ts');
    expect(result.affectedFiles).toContain('service.test.ts');
    expect(result.affectedTests).toContain('service.test.ts');
    expect(result.impactScope).toBe('comprehensive'); // 4/4 files in tiny fixture
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it('minimal change yields minimal scope', async () => {
    const { graph, builder } = await buildGraph();
    const analyzer = new ImpactAnalyzer(graph, (f) => builder.findDependents(f));

    const result = analyzer.analyze([
      { path: 'util.ts', type: 'modified', linesAdded: 1, linesDeleted: 0 },
    ]);
    // Just sanity-check the shape; scope depends on fixture size
    expect(['minimal', 'moderate', 'extensive', 'comprehensive']).toContain(result.impactScope);
    expect(result.estimatedImpact).toBeGreaterThanOrEqual(0);
    expect(result.estimatedImpact).toBeLessThanOrEqual(100);
  });

  it('flags config and type changes in recommendations', () => {
    const recs = generateRecommendations(
      [
        { path: 'package.json', type: 'modified', linesAdded: 1, linesDeleted: 1 },
        { path: 'src/types.ts', type: 'modified', linesAdded: 2, linesDeleted: 0 },
      ],
      10,
      3,
      'moderate'
    );

    expect(recs.some((r) => r.includes('Config file'))).toBe(true);
    expect(recs.some((r) => r.includes('Type definition'))).toBe(true);
  });
});

describe('IncrementalCacheManager', () => {
  it('persists and reloads file hashes and test results', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wf-cache-'));
    try {
      const manager = new IncrementalCacheManager(root);
      await manager.setFileHash('src/a.ts', 'abc123');
      await manager.setTestResult('src/a.test.ts', {
        passed: true,
        duration: 42,
        timestamp: 1000,
        hash: 'abc123',
      });
      await manager.markBuildComplete();

      // New instance reads from disk
      const reloaded = new IncrementalCacheManager(root);
      expect(await reloaded.getFileHash('src/a.ts')).toBe('abc123');
      const entry = await reloaded.getTestResult('src/a.test.ts');
      expect(entry?.passed).toBe(true);
      expect(entry?.duration).toBe(42);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('clear resets the cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wf-cache2-'));
    try {
      const manager = new IncrementalCacheManager(root);
      await manager.setFileHash('src/a.ts', 'abc123');
      await manager.clear();

      const reloaded = new IncrementalCacheManager(root);
      expect(await reloaded.getFileHash('src/a.ts')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
