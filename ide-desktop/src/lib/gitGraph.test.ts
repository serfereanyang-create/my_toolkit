import { describe, expect, it } from 'vitest';
import { laneColorIndex, layoutGraph } from './gitGraph';

/** Build a commit list (newest first) from [hash, ...parents] tuples. */
function commits(...spec: Array<[string, ...string[]]>) {
  return spec.map(([hash, ...parents]) => ({ hash, parents }));
}

describe('layoutGraph', () => {
  it('lays a linear history in one lane', () => {
    const { rows, maxLanes } = layoutGraph(commits(['c', 'b'], ['b', 'a'], ['a']));
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(maxLanes).toBe(1);
    expect(rows.every((r) => !r.isMerge)).toBe(true);
    // Each commit links to its single parent in the same lane.
    expect(rows[0]!.edges).toEqual([{ fromLane: 0, toLane: 0, merge: false }]);
    // The root has no parents in the list, so it has no outgoing edge.
    expect(rows[2]!.edges).toEqual([]);
  });

  it('opens a second lane for a branch and closes it when it rejoins', () => {
    //   d (main)
    //   | c (side)
    //   |/
    //   b
    //   a
    const { rows, maxLanes } = layoutGraph(
      commits(['d', 'b'], ['c', 'b'], ['b', 'a'], ['a']),
    );
    expect(rows[0]!.lane).toBe(0); // d keeps the mainline
    expect(rows[1]!.lane).toBe(1); // c branches off to lane 1
    expect(rows[2]!.lane).toBe(0); // b is back on lane 0
    expect(maxLanes).toBe(2);
  });

  it('gives a merge commit an edge per parent', () => {
    // m merges two branches; both parents are present.
    const { rows } = layoutGraph(
      commits(['m', 'x', 'y'], ['x', 'p'], ['y', 'p'], ['p']),
    );
    const merge = rows[0]!;
    expect(merge.isMerge).toBe(true);
    expect(merge.edges).toHaveLength(2);
    // First parent continues in this lane; the second opens a new one.
    expect(merge.edges[0]).toEqual({ fromLane: 0, toLane: 0, merge: false });
    expect(merge.edges[1]!.merge).toBe(true);
    expect(merge.edges[1]!.toLane).not.toBe(0);
  });

  it('ignores parents truncated out of the list', () => {
    // A shallow log: `b`'s parent `a` is not in the window.
    const { rows, maxLanes } = layoutGraph(commits(['c', 'b'], ['b', 'a']));
    expect(maxLanes).toBe(1);
    // `b` has no parent we can draw, so it must not reserve a lane.
    expect(rows[1]!.edges).toEqual([]);
  });

  it('reuses a freed lane instead of growing the gutter', () => {
    // Two independent branches that both end: lane 1 must be reusable.
    const { maxLanes } = layoutGraph(
      commits(['a1'], ['a2'], ['b1'], ['b2']),
    );
    expect(maxLanes).toBe(1);
  });

  it('handles an empty history', () => {
    expect(layoutGraph([])).toEqual({ rows: [], maxLanes: 0 });
  });

  it('keeps every commit even when lanes are reused', () => {
    const input = commits(['c', 'a', 'b'], ['b', 'a'], ['a']);
    const { rows } = layoutGraph(input);
    expect(rows.map((r) => r.hash)).toEqual(['c', 'b', 'a']);
  });
});

describe('laneColorIndex', () => {
  it('wraps over the palette and guards bad input', () => {
    expect(laneColorIndex(0)).toBe(0);
    expect(laneColorIndex(5)).toBe(5);
    expect(laneColorIndex(6)).toBe(0);
    expect(laneColorIndex(7, 3)).toBe(1);
    expect(laneColorIndex(-1)).toBe(0);
    expect(laneColorIndex(Number.NaN)).toBe(0);
  });
});
