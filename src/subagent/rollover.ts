import type { AgentRuntime } from '../agent/agent.js';
import { runAgentTurn } from '../agent/agent.js';
import { buildCompactRequestMessages, SUMMARY_PREFIX } from '../agent/autoCompact.js';
import type { ProviderRequest } from '../providers/types.js';
import { withModelRetry } from '../providers/retry.js';

/**
 * A sub-agent that runs out of its step budget continues in a **new session**,
 * seeded with a handoff summary — it does not simply fail.
 *
 * Why a new session rather than a bigger budget: a single agent run accumulates
 * context until every step resends a history that is mostly spent. Restarting
 * with a summary keeps the working set small, which is both cheaper and less
 * likely to lose the thread than an ever-growing transcript. This mirrors what
 * codex-rs does with mid-turn compaction (turn.rs:600-640) — its loop is
 * unbounded, and context, not iteration count, is what actually has to be
 * managed.
 */

/**
 * Segments one sub-agent may run before giving up. Each segment gets a fresh
 * step budget; the summary is what carries progress across the boundary.
 */
export const MAX_SUBAGENT_SEGMENTS = 4;

/** Chars of the previous segment's answer carried into the next segment's prompt. */
export const ROLLOVER_ANSWER_CHARS = 1500;

export type RolloverSegment = {
  /** 1-based segment index. */
  index: number;
  sessionId: string;
  ok: boolean;
  answer: string;
  steps: number;
};

export type RolloverOutcome = {
  ok: boolean;
  answer: string;
  /** The final segment's session id — what callers surface as the run's session. */
  sessionId: string;
  steps: number;
  segments: RolloverSegment[];
  /** True when the run was still unfinished at MAX_SUBAGENT_SEGMENTS. */
  exhausted: boolean;
};

export type RolloverOptions = {
  /** Steps allowed per segment. */
  segmentSteps: number;
  /** Extra context appended to the first segment's goal (upstream results etc). */
  buildGoal: (segment: number, handoff: string | undefined) => string;
  /** Cooperative cancel, checked between segments. */
  cancelRequested?: () => boolean;
  onSegmentStart?: (segment: number, sessionId: string) => void;
  onSegmentDone?: (segment: RolloverSegment) => void;
};

/**
 * Summarize a finished segment so the next one can resume without its history.
 *
 * Best-effort by design: when summarization fails the previous answer is carried
 * verbatim instead. A rollover that loses the summary is far better than one
 * that loses the work.
 */
async function summarizeSegment(
  runtime: AgentRuntime,
  messages: import('../providers/types.js').AgentMessage[],
): Promise<string | undefined> {
  try {
    const request: ProviderRequest = {
      messages: buildCompactRequestMessages(messages),
      tools: [],
      workspaceRoot: runtime.config.workspaceRoot,
    };
    const response = await withModelRetry(() => runtime.provider.complete(request));
    const summary = response.actions
      .filter((action): action is Extract<typeof action, { type: 'message' }> => action.type === 'message')
      .map((action) => action.content.trim())
      .filter(Boolean)
      .join('\n\n');
    return summary || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run one sub-agent to completion, rolling over into fresh sessions when a
 * segment exhausts its step budget.
 */
export async function runSubAgentWithRollover(
  baseRuntime: AgentRuntime,
  createSegmentRuntime: (goal: string) => Promise<{ runtime: AgentRuntime; sessionId: string }>,
  options: RolloverOptions,
): Promise<RolloverOutcome> {
  const segments: RolloverSegment[] = [];
  let handoff: string | undefined;
  let lastAnswer = '';
  let lastSessionId = '';
  let totalSteps = 0;

  for (let segment = 1; segment <= MAX_SUBAGENT_SEGMENTS; segment += 1) {
    if (options.cancelRequested?.() === true) {
      return {
        ok: false,
        answer: lastAnswer || '已取消：本段未启动。',
        sessionId: lastSessionId,
        steps: totalSteps,
        segments,
        exhausted: false,
      };
    }

    // The segment's prompt IS the built goal — a fresh session has no history to
    // continue from, so the goal has to be passed in explicitly.
    const goal = options.buildGoal(segment, handoff);
    const { runtime, sessionId } = await createSegmentRuntime(goal);
    options.onSegmentStart?.(segment, sessionId);
    const result = await runAgentTurn(runtime, goal, {});
    const answer = result.finalAnswer ?? result.reason ?? '(no answer)';
    // The loop's own count, not a derived one: counting assistant messages
    // undercounts a tool-only segment (three tool calls and a budget stop leaves
    // a single message), which is exactly the case rollover has to measure.
    const steps = result.steps ?? runtime.lastTurnSteps ?? 0;

    const record: RolloverSegment = { index: segment, sessionId, ok: result.ok, answer, steps };
    segments.push(record);
    options.onSegmentDone?.(record);
    totalSteps += steps;
    lastAnswer = answer;
    lastSessionId = sessionId;

    if (result.ok) {
      return { ok: true, answer, sessionId, steps: totalSteps, segments, exhausted: false };
    }
    // A budget stop is the one failure that rollover can fix. A genuine error
    // (provider failure, terminal tool failure) would repeat verbatim in a fresh
    // session, so it is returned as-is rather than burning the remaining
    // segments on it.
    if (!isBudgetStop(result.reason)) {
      return { ok: false, answer, sessionId, steps: totalSteps, segments, exhausted: false };
    }

    handoff = await summarizeSegment(runtime, runtime.session.messages) ?? answer.slice(0, ROLLOVER_ANSWER_CHARS);
  }

  return {
    ok: false,
    answer: `已连续 ${MAX_SUBAGENT_SEGMENTS} 段用尽步数上限，最后一段的结论：${lastAnswer}`,
    sessionId: lastSessionId,
    steps: totalSteps,
    segments,
    exhausted: true,
  };
}

/**
 * Whether a turn ended because it ran out of budget rather than because it hit
 * a real error. Only these are worth rolling over.
 */
export function isBudgetStop(reason: string | undefined): boolean {
  if (!reason) return false;
  return reason.includes('max steps') || reason.includes('token budget');
}

/** Render the handoff block injected into a rolled-over segment's goal. */
export function formatHandoff(segment: number, handoff: string | undefined): string {
  if (segment === 1 || !handoff) return '';
  return [
    '',
    '## 上一段的工作交接',
    `这是第 ${segment} 段。上一段用完了步数上限，你接手继续完成同一个子任务。`,
    '不要重复已经做完的工作；先确认当前进度，再继续未完成的部分。',
    '',
    SUMMARY_PREFIX,
    handoff,
  ].join('\n');
}
