/**
 * Supervisor: one place that watches every unit of work in a session and can
 * report where it stands.
 *
 * Why this exists: sub-agents, task-board tasks, and turn-level rollovers each
 * already emit progress, but nothing aggregates them. A caller who wants "what
 * is running right now and is any of it stuck" has to join three event streams
 * by hand. The supervisor keeps that state.
 *
 * It is deliberately **observational**, matching the reference implementation:
 * codex-rs has no supervisor at all — its closest component, `ThreadWatchManager`
 * (app-server/src/thread_status.rs), only publishes status and never acts on it.
 * Acting on agents automatically (killing a "stuck" one, restarting a "failed"
 * one) needs a judgement this layer cannot make, so it reports and leaves the
 * decision to the user or to an explicit tool call.
 */

export type SupervisedKind = 'subagent' | 'task' | 'turn';

export type SupervisedStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export type SupervisedUnit = {
  /** Stable id: the subagent id, the task id, or `turn:<sessionId>`. */
  id: string;
  kind: SupervisedKind;
  /** Human-readable goal, for a progress list. */
  label: string;
  status: SupervisedStatus;
  /** Which subagent/task this belongs to, when nested. */
  parentId?: string;
  /** Segment index when a unit rolled over into a new session (1 = first). */
  segment?: number;
  /** Steps observed so far. */
  steps: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** Last failure text, when the unit failed. */
  error?: string;
  /** The session the unit ran in (the latest segment's session). */
  sessionId?: string;
  /** Expert role, for subagents. */
  expert?: string;
};

export type SupervisorSnapshot = {
  units: SupervisedUnit[];
  running: number;
  done: number;
  failed: number;
  /** Total steps across every unit in this session. */
  steps: number;
  /** Oldest still-running unit's elapsed ms, if any. */
  longestRunningMs?: number;
  /**
   * How many sub-agent runs this session has produced, and which experts they
   * used.
   *
   * Exists because "did delegation fire?" is otherwise unanswerable from the
   * outside: a turn that delegated nothing emits no subagent event at all, so
   * the only evidence is an absence — and an absence is indistinguishable from
   * a broken emit. Counting from the unit list makes the negative case
   * observable (delegated: 0) instead of inferred.
   */
  delegated: number;
  delegatedExperts: string[];
};

/**
 * Tracks the units of work in one session.
 *
 * Keyed by kind+id rather than a bare id: a task and a subagent can legitimately
 * share a name (both are often `task_1`), and collapsing them would lose one.
 */
export class Supervisor {
  private readonly units = new Map<string, SupervisedUnit>();

  /**
   * Notified after every state change.
   *
   * Set by the embedding layer. Notifying from inside the mutators is deliberate:
   * an emit call at each of the several start/finish sites would be forgotten by
   * whichever one is added next, and a stale progress panel is worse than none.
   */
  onChange?: (snapshot: SupervisorSnapshot) => void;

  private notify(): void {
    this.onChange?.(this.snapshot());
  }

  private static key(kind: SupervisedKind, id: string): string {
    return `${kind}:${id}`;
  }

  /** Record that a unit started (or started a new segment). */
  start(input: {
    kind: SupervisedKind;
    id: string;
    label: string;
    parentId?: string;
    segment?: number;
    expert?: string;
    sessionId?: string;
  }): SupervisedUnit {
    const key = Supervisor.key(input.kind, input.id);
    const existing = this.units.get(key);
    const now = Date.now();
    const unit: SupervisedUnit = {
      id: input.id,
      kind: input.kind,
      label: input.label,
      status: 'running',
      steps: existing?.steps ?? 0,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.segment !== undefined ? { segment: input.segment } : {}),
      ...(input.expert ? { expert: input.expert } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    };
    this.units.set(key, unit);
    this.notify();
    return unit;
  }

  /** Record observed progress (step count) without changing status. */
  progress(kind: SupervisedKind, id: string, steps: number): void {
    const unit = this.units.get(Supervisor.key(kind, id));
    if (!unit) return;
    unit.steps = steps;
    unit.updatedAt = Date.now();
    this.notify();
  }

  /** Record that a unit settled. */
  finish(
    kind: SupervisedKind,
    id: string,
    status: Exclude<SupervisedStatus, 'running'>,
    options?: { error?: string; steps?: number; sessionId?: string; segment?: number },
  ): void {
    const key = Supervisor.key(kind, id);
    const unit = this.units.get(key);
    const now = Date.now();
    if (!unit) {
      // A finish without a start (e.g. a run adopted from a sidecar file) still
      // has to be visible — dropping it would hide a real failure.
      this.units.set(key, {
        id,
        kind,
        label: id,
        status,
        steps: options?.steps ?? 0,
        startedAt: now,
        updatedAt: now,
        finishedAt: now,
        ...(options?.error ? { error: options.error } : {}),
        ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options?.segment !== undefined ? { segment: options.segment } : {}),
      });
      this.notify();
      return;
    }
    unit.status = status;
    unit.updatedAt = now;
    unit.finishedAt = now;
    if (options?.steps !== undefined) unit.steps = options.steps;
    if (options?.error) unit.error = options.error;
    if (options?.sessionId) unit.sessionId = options.sessionId;
    if (options?.segment !== undefined) unit.segment = options.segment;
    this.notify();
  }

  /** Every tracked unit, newest activity first. */
  snapshot(): SupervisorSnapshot {
    const units = [...this.units.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    const runningUnits = units.filter((unit) => unit.status === 'running');
    const subagents = units.filter((unit) => unit.kind === 'subagent');
    const now = Date.now();
    return {
      units,
      running: runningUnits.length,
      done: units.filter((unit) => unit.status === 'done').length,
      failed: units.filter((unit) => unit.status === 'failed').length,
      steps: units.reduce((sum, unit) => sum + unit.steps, 0),
      delegated: subagents.length,
      delegatedExperts: [...new Set(subagents.map((unit) => unit.expert).filter((id): id is string => Boolean(id)))],
      ...(runningUnits.length > 0
        ? { longestRunningMs: Math.max(...runningUnits.map((unit) => now - unit.startedAt)) }
        : {}),
    };
  }

  /** Drop settled units, keeping anything still running. */
  clearFinished(): void {
    for (const [key, unit] of this.units) {
      if (unit.status !== 'running') this.units.delete(key);
    }
  }
}
