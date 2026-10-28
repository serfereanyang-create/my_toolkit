import type { AgentMessage, ProviderRequest } from '../providers/types.js';
import { withModelRetry } from '../providers/retry.js';
import { withRequestControl } from '../providers/requestControl.js';
import { throwIfAborted } from '../utils/cancellation.js';
import type { AgentRuntime } from './agent.js';
import { compactMessagesForModel } from './contextBudget.js';
import { autoCompactTokenLimit, resolveModelContextWindow } from './modelWindows.js';

/**
 * Auto-compact, ported from openai/codex (codex-rs/core/src/compact.rs +
 * session/context_window.rs, Apache-2.0):
 * - trigger: pre-turn, before the new user input enters history, when the
 *   estimated conversation size reaches 90% of the context window
 *   (auto_compact_limit = resolved_context_window * 9/10)
 * - token estimate: ceil(utf8 bytes / 4) (upstream APPROX_BYTES_PER_TOKEN)
 * - summarization prompt: handoff summary for another LLM (upstream
 *   SUMMARIZATION_PROMPT), sent as a trailing user message with no tools
 * - after compaction: summary stub + the most recent user messages
 *   (upstream keeps user messages within a 20k-token budget; we keep the
 *   latest two verbatim)
 * - window size: AICODE_CONTEXT_WINDOW, else the model table in modelWindows.ts,
 *   else a conservative fallback. Upstream reads it from /models metadata; our
 *   multi-vendor CLI has no metadata endpoint, so the table stands in.
 *
 * The window must never be unknown. It used to be: an unset
 * AICODE_CONTEXT_WINDOW returned undefined and `shouldAutoCompact` then
 * answered false forever. Because no model in the desktop's provider settings
 * carried a contextWindow, the variable was never set and auto-compaction never
 * fired once — the conversation just grew until the char budget silently
 * discarded most of it.
 */

export const AUTO_COMPACT_WINDOW_FRACTION = 0.9;
export const APPROX_BYTES_PER_TOKEN = 4;
/** Do not compact short sessions — the stub would lose more than it saves. */
export const AUTO_COMPACT_MIN_MESSAGES = 8;
/** compact.rs retains recent user messages after the summary stub. */
export const AUTO_COMPACT_KEEP_RECENT_USER = 2;

export function resolveContextWindowTokens(model?: string): number {
  return resolveModelContextWindow(model);
}

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / APPROX_BYTES_PER_TOKEN);
}

export function shouldAutoCompact(
  estimatedTokens: number,
  windowTokens: number | undefined,
  messageCount: number,
): boolean {
  if (!windowTokens) return false;
  if (messageCount < AUTO_COMPACT_MIN_MESSAGES) return false;
  return estimatedTokens >= autoCompactTokenLimit(windowTokens);
}

/** Tokens currently held in the session, by the upstream bytes/4 estimate. */
export function sessionTokens(messages: AgentMessage[]): number {
  return estimateTokens(messages.map((message) => message.content).join('\n'));
}

/** upstream prompts/templates/compact/prompt.md (SUMMARIZATION_PROMPT). */
export const SUMMARIZATION_PROMPT =
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM '
  + 'that will resume the task. Include: current progress and key decisions made; important context, '
  + 'constraints, or user preferences; what remains to be done (clear next steps); any critical data, '
  + 'examples, or references needed to continue. Be concise and structured.';

/** compact.rs SUMMARY_PREFIX semantics. */
export const SUMMARY_PREFIX = '[compacted session history] Another agent started this task and produced the following handoff summary.';

/**
 * compact.rs: the summarization request = full history + trailing user prompt,
 * no tools.
 *
 * "Full history" means the packed history, not the stored one. A live session
 * legitimately holds single tool results larger than the whole window — one
 * real desktop session carried a 2.7 MB `fetch_url` page — because every
 * ordinary step is clipped down to the per-role limits before it is sent (see
 * `compactMessagesForModel`, codex `truncation_policy`). Feeding the raw array
 * here made the summarization prompt itself ~694k tokens against a 272k
 * window: the provider answered 400, `runAutoCompact` kept the history that
 * caused it, and the next step rebuilt the identical oversized request — so
 * auto-compaction failed on every step forever while normal turns kept working.
 * Callers pack first (see `runAutoCompact`); the prompt is appended afterwards
 * so it can never be clipped away.
 */
export function buildCompactRequestMessages(messages: AgentMessage[]): AgentMessage[] {
  return [
    ...messages,
    { role: 'user', content: SUMMARIZATION_PROMPT, createdAt: new Date().toISOString() },
  ];
}

/**
 * Real provider usage from a compaction call.
 *
 * Compaction bypasses the agent loop, so its spend never reaches
 * `usageTotals` and used to appear in no ledger at all: a session that crossed
 * its window twice paid for two full-history summarizations invisibly. Callers
 * that keep a ledger pass a sink and get the real numbers.
 */
export type CompactUsageSink = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  outcome: 'completed' | 'failed';
};

/**
 * Pre-turn auto-compact (turn.rs:1231-1260 runs it before the new user input
 * enters history). Best-effort: a failed summarization never breaks the turn —
 * the per-request char-budget compaction still bounds the prompt size.
 *
 * Returns true when the history was replaced, so callers that run it mid-turn
 * know whether the messages they were holding are still valid.
 */
export async function maybeAutoCompact(runtime: AgentRuntime, usage?: CompactUsageSink): Promise<boolean> {
  const messages = runtime.session.messages ?? [];
  const windowTokens = resolveContextWindowTokens(runtime.provider.model);
  const estimatedTokens = sessionTokens(messages);
  if (!shouldAutoCompact(estimatedTokens, windowTokens, messages.length)) return false;
  return await runAutoCompact(runtime, messages, estimatedTokens, windowTokens, usage);
}

/**
 * Mid-turn auto-compact: the same compaction, but run between steps of a single
 * turn rather than before the next user input.
 *
 * Upstream needs this because one turn can be long: a task that runs twenty
 * tools never returns to `run_pre_sampling_compact`, so a pre-turn-only trigger
 * would let that turn grow past the window entirely. codex fires it mid-turn
 * (turn.rs:600-640, `CompactionPhase::MidTurn`) when the model asks for a
 * follow-up and the token limit has been reached.
 */
export async function maybeMidTurnCompact(runtime: AgentRuntime, usage?: CompactUsageSink): Promise<boolean> {
  const messages = runtime.session.messages ?? [];
  const windowTokens = resolveContextWindowTokens(runtime.provider.model);
  const estimatedTokens = sessionTokens(messages);
  if (!shouldAutoCompact(estimatedTokens, windowTokens, messages.length)) return false;
  return await runAutoCompact(runtime, messages, estimatedTokens, windowTokens, usage);
}

async function runAutoCompact(
  runtime: AgentRuntime,
  messages: AgentMessage[],
  estimatedTokens: number,
  windowTokens: number,
  usage?: CompactUsageSink,
): Promise<boolean> {
  runtime.ui.info(
    `Context ≈${estimatedTokens} tokens (≥90% of the ${windowTokens}-token window) — auto-compacting…`,
  );
  const emitCompact = runtime.compactEmit;
  emitCompact?.({ phase: 'started', auto: true, before: messages.length });
  try {
    // Pack the history before summarizing it, exactly as a normal step does.
    //
    // Without this the request carried the raw stored messages, and a single
    // oversized tool result (a 2.7 MB fetch_url page is real, measured in a
    // desktop session) put the summarization prompt itself over the window.
    // The provider rejects that with a context-length error, the history is
    // kept, and the next step rebuilds the same request: auto-compaction can
    // then never succeed, no matter how far over the limit the session grows.
    // The packed form is the same one the model just answered, so a summary of
    // it is a summary of what was actually in context.
    const packed = compactMessagesForModel(messages, { model: runtime.provider.model });
    if (packed.truncated) {
      runtime.ui.info(
        `Compaction request packed to fit the window: ${packed.originalChars} → ${packed.compactChars} chars`
        + (packed.droppedMessages ? `, oldest ${packed.droppedMessages} message(s) dropped` : '') + '.',
      );
    }
    const request: ProviderRequest = {
      signal: runtime.requestSignal,
      timeoutMs: runtime.config.requestTimeoutMs,
      messages: buildCompactRequestMessages(packed.messages),
      tools: [],
      workspaceRoot: runtime.config.workspaceRoot,
    };
    // Count the attempt before it is made: a request that throws (timeout,
    // 5xx, socket reset) may still have been billed server-side, and a turn
    // whose only spend was that attempt must not look free. Tokens are added
    // below when a response actually carries usage.
    if (usage) usage.calls += 1;
    const response = await withRequestControl(request, controlled => withModelRetry(() => runtime.provider.complete(controlled), {
      signal: controlled.signal,
      onRetry: (attempt, maxRetries) => runtime.ui.info(`Reconnecting… ${attempt}/${maxRetries} (compaction)`),
    }));
    if (usage && response.usage) {
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
    }
    const summary = response.actions
      .filter((action): action is Extract<typeof action, { type: 'message' }> => action.type === 'message')
      .map((action) => action.content.trim())
      .filter(Boolean)
      .join('\n\n');
    if (!summary) throw new Error('empty compaction summary');

    const recentUser = [...messages]
      .reverse()
      .filter((message) => message.role === 'user')
      .slice(0, AUTO_COMPACT_KEEP_RECENT_USER)
      .reverse();
    runtime.session.messages = [
      { role: 'user', content: `${SUMMARY_PREFIX}\n\n${summary}`, createdAt: new Date().toISOString() },
      ...recentUser,
    ];
    // The server-side continuation chain (Responses API `previous_response_id`)
    // still refers to the pre-compaction history. Keeping it would make the
    // provider continue from the history we just replaced, so the compacted
    // messages would never reach the model at all. codex clears the reference
    // context item in `replace_compacted_history` for the same reason.
    runtime.session.providerContinuation = undefined;
    runtime.ui.info(
      `Auto-compact complete: ${messages.length} → ${runtime.session.messages.length} messages (summary stub + ${recentUser.length} recent user messages).`,
    );
    emitCompact?.({ phase: 'completed', auto: true, before: messages.length, after: runtime.session.messages.length });
    if (usage) usage.outcome = 'completed';
    return true;
  } catch (error) {
    if (usage) usage.outcome = 'failed';
    if (runtime.requestSignal?.aborted) {
      emitCompact?.({ phase: 'failed', auto: true, reason: '上下文压缩已取消' });
      throwIfAborted(runtime.requestSignal);
    }
    runtime.ui.info(
      `Auto-compact failed (${error instanceof Error ? error.message : String(error)}); keeping full history — char-budget compaction still applies.`,
    );
    emitCompact?.({ phase: 'failed', auto: true, reason: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
