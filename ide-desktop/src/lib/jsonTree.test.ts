import { describe, expect, it } from 'vitest';
import {
  allContainerPaths,
  buildJsonTree,
  filterJsonTree,
  flattenJsonTree,
  tryParseJson,
} from './jsonTree';

describe('buildJsonTree', () => {
  it('types scalars correctly', () => {
    expect(buildJsonTree(null)).toMatchObject({ type: 'null', value: null });
    expect(buildJsonTree(42)).toMatchObject({ type: 'number', value: 42 });
    expect(buildJsonTree(true)).toMatchObject({ type: 'boolean', value: true });
    expect(buildJsonTree('hi')).toMatchObject({ type: 'string', value: 'hi', textLength: 2 });
  });

  it('caps long strings with a preview but records real length', () => {
    const big = 'x'.repeat(600);
    const node = buildJsonTree(big);
    expect(node.value).toHaveLength(512);
    expect(node.textLength).toBe(600);
  });

  it('walks objects and arrays with pointer paths', () => {
    const tree = buildJsonTree({ a: [1, 2] });
    expect(tree.type).toBe('object');
    expect(tree.size).toBe(1);
    const child = tree.children![0];
    expect(child).toMatchObject({ key: 'a', type: 'array', path: '/a', size: 2 });
    expect(child.children![1]).toMatchObject({ path: '/a/1', type: 'number', value: 2 });
  });

  it('escapes slashes in object keys', () => {
    const tree = buildJsonTree({ 'x/y': 1 });
    expect(tree.children![0].path).toBe('/x~1y');
  });

  it('respects maxDepth by terminating deeper nodes', () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    const tree = buildJsonTree(deep, 2);
    // At depth 2 the {d:1} object becomes a terminal chip with no children.
    const bc = tree.children![0].children![0];
    expect(bc.type).toBe('object');
    expect(bc.children).toBeUndefined();
    expect(bc.size).toBe(1);
  });
});

describe('flattenJsonTree', () => {
  const tree = buildJsonTree({ keep: 1, drop: [1, 2, 3] });

  it('emits all rows when nothing is collapsed', () => {
    const rows = flattenJsonTree(tree, new Set());
    // root + keep + drop + 3 array items
    expect(rows.length).toBe(6);
    expect(rows[0].depth).toBe(0);
    expect(rows.find((r) => r.node.key === 'keep')!.depth).toBe(1);
  });

  it('hides descendants under a collapsed path', () => {
    const rows = flattenJsonTree(tree, new Set(['/drop']));
    expect(rows.length).toBe(3); // root, keep, drop (collapsed)
    const drop = rows.find((r) => r.node.key === 'drop')!;
    expect(drop.collapsed).toBe(true);
  });

  it('assigns array ordinals', () => {
    const rows = flattenJsonTree(tree, new Set());
    const first = rows.find((r) => r.node.path === '/drop/0')!;
    expect(first.ordinal).toBe(0);
  });
});

describe('filterJsonTree', () => {
  const tree = buildJsonTree({ user: { name: 'alice', age: 30 }, empty: {} });

  it('returns the whole tree for a blank needle', () => {
    expect(filterJsonTree(tree, '')).toBe(tree);
  });

  it('keeps ancestors of matching leaves', () => {
    const out = filterJsonTree(tree, 'alice')!;
    expect(out.type).toBe('object');
    expect(out.children!.map((c) => c.key)).toEqual(['user']);
    expect(out.children![0].children!.map((c) => c.key)).toEqual(['name']);
  });

  it('matches on key/path text too', () => {
    const out = filterJsonTree(tree, 'age')!;
    expect(out.children!.length).toBe(1); // user kept via its child
  });

  it('drops non-matching branches', () => {
    const out = filterJsonTree(tree, 'nothere');
    expect(out).toBeNull();
  });
});

describe('allContainerPaths', () => {
  it('lists every expandable node path', () => {
    const paths = allContainerPaths(buildJsonTree({ a: { b: [1] } }));
    expect(paths).toEqual(['', '/a', '/a/b']);
  });
});

describe('tryParseJson', () => {
  it('parses valid JSON', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(tryParseJson('  [1,2]  ')).toEqual({ ok: true, value: [1, 2] });
  });

  it('flags JSON-looking text with a parse error', () => {
    const res = tryParseJson('{oops');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.looksLikeJson).toBe(true);
      expect(res.error).not.toBe('not-json');
    }
  });

  it('reports plain text as not-json without an error', () => {
    const res = tryParseJson('just a log line');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.looksLikeJson).toBe(false);
      expect(res.error).toBe('not-json');
    }
  });
});
