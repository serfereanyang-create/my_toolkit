import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { desktop } from '../lib/ipc';
import type { GitGraphCommit } from '../lib/ipc';
import { laneColorIndex, layoutGraph } from '../lib/gitGraph';

/*
 * GitGraph — the commit DAG, drawn.
 *
 * `git log --graph` produces an ASCII picture, so the backend ships commits
 * with their parent hashes and `lib/gitGraph` computes lanes. This component
 * only draws: an SVG gutter per row (node + edges to parents) plus the commit
 * text.
 *
 * The gutter is drawn per row rather than as one big SVG so the list can stay
 * a normal scrolling list — a single canvas would have to be as tall as the
 * whole history.
 */

const LANE_WIDTH = 14;
const ROW_HEIGHT = 34;
const NODE_RADIUS = 3.5;
const PALETTE_SIZE = 6;

/** Lane colours, indexed by lane so a branch keeps its colour down the list. */
const LANE_COLORS = ['#3b82f6', '#a855f7', '#10b981', '#f59e0b', '#ef4444', '#06b6d4'];

function laneColor(lane: number): string {
  return LANE_COLORS[laneColorIndex(lane, PALETTE_SIZE)]!;
}

function Gutter({ row, maxLanes }: { row: ReturnType<typeof layoutGraph>['rows'][number]; maxLanes: number }) {
  const width = Math.max(1, maxLanes) * LANE_WIDTH;
  const cx = row.lane * LANE_WIDTH + LANE_WIDTH / 2;
  const cy = ROW_HEIGHT / 2;

  return (
    <svg className="git-graph-gutter" width={width} height={ROW_HEIGHT} aria-hidden="true">
      {row.edges.map((edge, index) => {
        const toX = edge.toLane * LANE_WIDTH + LANE_WIDTH / 2;
        const color = laneColor(edge.toLane);
        // The first parent continues straight down; a merge's extra parent
        // curves out to its lane, which is what makes a merge readable.
        const path = edge.fromLane === edge.toLane
          ? `M ${cx} ${cy} L ${toX} ${ROW_HEIGHT}`
          : `M ${cx} ${cy} C ${cx} ${cy + ROW_HEIGHT * 0.5}, ${toX} ${cy + ROW_HEIGHT * 0.5}, ${toX} ${ROW_HEIGHT}`;
        return <path key={index} d={path} stroke={color} strokeWidth={1.6} fill="none" />;
      })}
      <circle cx={cx} cy={cy} r={row.isMerge ? NODE_RADIUS + 1 : NODE_RADIUS} fill={laneColor(row.lane)} />
    </svg>
  );
}

export function GitGraph({ limit = 60 }: { limit?: number }) {
  const [commits, setCommits] = useState<GitGraphCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await desktop.git.graph(limit);
      if (result.ok === false) {
        setError(result.error ?? '无法读取提交历史');
        setCommits([]);
      } else {
        setCommits(Array.isArray(result.commits) ? result.commits : []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => { void refresh(); }, [refresh]);

  const { rows, maxLanes } = layoutGraph(commits.map((c) => ({ hash: c.hash, parents: c.parents })));
  const byHash = new Map(commits.map((c) => [c.hash, c]));

  return (
    <div className="git-graph">
      <div className="git-graph-head">
        <span>Git 图谱</span>
        <button type="button" className="git-graph-refresh" onClick={() => void refresh()} disabled={loading} title="刷新">
          <RefreshCw size={13} className={loading ? 'review-spin' : undefined} />
        </button>
      </div>

      {error && (
        <div className="git-graph-error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {!error && !loading && rows.length === 0 && (
        <p className="git-graph-empty">还没有提交记录。</p>
      )}

      <ul className="git-graph-list">
        {rows.map((row) => {
          const commit = byHash.get(row.hash);
          if (!commit) return null;
          return (
            <li key={row.hash} className="git-graph-row" style={{ height: ROW_HEIGHT }}>
              <Gutter row={row} maxLanes={maxLanes} />
              <div className="git-graph-body">
                <span className="git-graph-message" title={commit.message}>{commit.message}</span>
                <span className="git-graph-meta">
                  <code>{commit.shortHash}</code>
                  <span>{commit.author}</span>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
