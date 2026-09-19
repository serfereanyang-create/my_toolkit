/*
 * gitGraph — lane layout for a commit DAG.
 *
 * `git log --graph` draws an ASCII picture, which cannot be rendered as real
 * UI. So we take the commit list with parent hashes and assign each commit a
 * lane (column) plus the edges that connect it to its parents, the same way
 * every git GUI does it.
 *
 * The algorithm is a single top-to-bottom pass. `lanes` holds the commit hash
 * each column is currently "waiting for": when we draw commit C, we find the
 * column reserved for C, then replace that reservation with C's first parent
 * (so the column keeps flowing downward), and open a new column for any
 * additional parents (a merge).
 *
 * Pure and synchronous so it can be unit-tested without a repo.
 */

export type GraphInput = {
  hash: string;
  parents: string[];
};

export type GraphEdge = {
  /** Lane the edge starts in (this commit's lane). */
  fromLane: number;
  /** Lane the edge ends in (the parent's lane). */
  toLane: number;
  /** True when the parent is a merge's second+ parent (drawn curved). */
  merge: boolean;
};

export type GraphRow = {
  hash: string;
  lane: number;
  /** Total lanes in use at this row, so the renderer can size the gutter. */
  laneCount: number;
  /** Edges leaving this commit downward to its parents. */
  edges: GraphEdge[];
  /** True when this commit joins two or more lanes (a merge commit). */
  isMerge: boolean;
};

export type GraphLayout = {
  rows: GraphRow[];
  /** Widest lane count across all rows — the gutter width. */
  maxLanes: number;
};

/**
 * Lay out a commit list (newest first, as `git log` returns it).
 *
 * Commits whose parents are absent from the list (history truncated by the
 * limit) simply produce no edge for that parent — the graph ends cleanly
 * rather than inventing a lane for a commit we will never draw.
 */
export function layoutGraph(commits: GraphInput[]): GraphLayout {
  // lanes[i] = hash of the commit column i is currently waiting to draw, or
  // null when the column is free.
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let maxLanes = 0;

  const known = new Set(commits.map((c) => c.hash));

  for (const commit of commits) {
    // 1. Find this commit's lane: either already reserved by a child, or take
    //    the first free column (or append one).
    let lane = lanes.indexOf(commit.hash);
    if (lane === -1) {
      const free = lanes.indexOf(null);
      lane = free === -1 ? lanes.length : free;
    }

    // 2. Reserve lanes for parents before clearing this one, so a merge's
    //    second parent does not reuse the column we are about to keep.
    const parents = commit.parents.filter((p) => known.has(p));

    // The first parent continues in this commit's lane (the mainline).
    if (parents.length > 0) {
      lanes[lane] = parents[0];
    } else {
      lanes[lane] = null;
    }

    // Extra parents (a merge) each get their own lane.
    const edges: GraphEdge[] = [];
    if (parents.length > 0) edges.push({ fromLane: lane, toLane: lane, merge: false });
    for (let i = 1; i < parents.length; i += 1) {
      const parent = parents[i]!;
      let parentLane = lanes.indexOf(parent);
      if (parentLane === -1) {
        const free = lanes.indexOf(null);
        parentLane = free === -1 ? lanes.length : free;
        lanes[parentLane] = parent;
      }
      edges.push({ fromLane: lane, toLane: parentLane, merge: true });
    }

    // 3. Drop trailing free columns so the gutter does not grow forever.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    const laneCount = Math.max(lanes.length, lane + 1);
    maxLanes = Math.max(maxLanes, laneCount);
    rows.push({ hash: commit.hash, lane, laneCount, edges, isMerge: parents.length > 1 });
  }

  return { rows, maxLanes };
}

/**
 * Assign a stable colour index to each lane so a branch keeps its colour as
 * the list scrolls. Wraps over `paletteSize` distinct colours.
 */
export function laneColorIndex(lane: number, paletteSize = 6): number {
  if (!Number.isFinite(lane) || lane < 0) return 0;
  return Math.floor(lane) % Math.max(1, paletteSize);
}
