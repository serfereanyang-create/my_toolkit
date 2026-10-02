import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** One message as it was actually sent to (or returned by) the model. */
export type TrajectoryMessage = {
  role: string;
  content: string;
  name?: string;
};

/**
 * One model round-trip. Mirrors the upstream `ZCodeModelTrajectoryRecord`
 * fields that this app can actually produce: the request context as sent, the
 * response as received, timing, and the correlation ids that tie a row to a
 * turn and a step.
 */
export type TrajectoryRecord = {
  requestId: string;
  turnId: string;
  step: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  model: string;
  provider: string;
  ok: boolean;
  error?: string;
  /** Message count of the request context — the record stores the tail only. */
  requestMessageCount: number;
  /** The last N messages as sent, so the viewer shows the real prompt tail. */
  requestTail: TrajectoryMessage[];
  /** Assistant text produced by this call. */
  responseText: string;
  toolNames: string[];
  promptChars: number;
  usage?: { inputTokens?: number; outputTokens?: number };
};

/** Where the rows for one session live: next to the session file itself. */
/** How many trailing messages the viewer keeps per call (the real prompt tail). */
export const TRAJECTORY_TAIL = 6;

export function trajectoryPathFor(sessionPath: string): string {
  return sessionPath.replace(/\.json$/, '.trajectory.jsonl');
}

/**
 * Append one row. Never throws into the agent loop: a failed trace must not
 * take down a turn that is otherwise fine.
 */
export function recordTrajectoryRow(sessionPath: string, row: TrajectoryRecord): void {
  try {
    const file = trajectoryPathFor(sessionPath);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf-8');
  } catch {
    /* tracing is best-effort */
  }
}

/** Read the rows back, oldest first. Missing or corrupt file yields []. */
export function readTrajectoryRecords(sessionPath: string): TrajectoryRecord[] {
  const file = trajectoryPathFor(sessionPath);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf-8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as TrajectoryRecord);
  } catch {
    return [];
  }
}

/** Minimal runtime surface the recorder needs; keeps agent.ts decoupled. */
type RecorderRuntime = {
  session: { id: string };
  sessions: { filePath(id: string): string };
};

/**
 * Record one model call from the agent loop.
 *
 * Kept here so the loop needs a single call and the file naming lives in one
 * place. Best-effort by design: a broken trace must never fail a turn.
 */
export function recordTrajectory(runtime: RecorderRuntime, row: TrajectoryRecord): void {
  try {
    recordTrajectoryRow(runtime.sessions.filePath(runtime.session.id), row);
  } catch {
    /* tracing is diagnostics, never a turn-critical path */
  }
}
