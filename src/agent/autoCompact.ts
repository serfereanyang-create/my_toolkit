import type { AgentMessage, ProviderRequest } from '../providers/types.js';
import { withModelRetry } from '../providers/retry.js';
import type { AgentRuntime } from './agent.js';

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
 * - window size comes from AICODE_CONTEXT_WINDOW (tokens). Upstream reads it
 *   from /models metadata; our multi-vendor CLI has no metadata endpoint, so
 *   without the knob compaction stays manual/char-budget as before.
 */

export const AUTO_COMPACT_WINDOW_FRACTION = 0.9;
export const APPROX_BYTES_PER_TOKEN = 4;
/** Do not compact short sessions — the stub would lose more than it saves. */
export const AUTO_COMPACT_MIN_MESSAGES = 8;
/** compact.rs retains recent user messages after the summary stub. */
export const AUTO_COMPACT_KEEP_RECENT_USER = 2;

export function resolveContextWindowTokens(): number | undefined {
  const raw = process.env.AICODE_CONTEXT_WINDOW;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
  return estimatedTokens >= windowTokens * AUTO_COMPACT_WINDOW_FRACTION;
}

/** upstream prompts/templates/compact/prompt.md (SUMMARIZATION_PROMPT). */
export const SUMMARIZATION_PROMPT =
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM '
  + 'that will resume the task. Include: current progress and key decisions made; important context, '
  + 'constraints, or user preferences; what remains to be done (clear next steps); any critical data, '
  + 'examples, or references needed to continue. Be concise and structured.';

/** compact.rs SUMMARY_PREFIX semantics. */
export const SUMMARY_PREFIX = '[compacted session history] Another agent started this task and produced the following handoff summary.';

/** compact.rs: the summarization request = full history + trailing user prompt, no tools. */
export function buildCompactRequestMessages(messages: AgentMessage[]): AgentMessage[] {
  return [
    ...messages,
    { role: 'user', content: SUMMARIZATION_PROMPT, createdAt: new Date().toISOString() },
  ];
}

/**
 * Pre-turn auto-compact (turn.rs:1231-1260 runs it before the new user input
 * enters history). Best-effort: a failed summarization never breaks the turn —
 * the per-request char-budget compaction still bounds the prompt size.
 */
export async function maybeAutoCompact(runtime: AgentRuntime): Promise<void> {
  const windowTokens = resolveContextWindowTokens();
  if (!windowTokens) return;
  const messages = runtime.session.messages ?? [];
  const estimatedTokens = estimateTokens(messages.map((message) => message.content).join('\n'));
  if (!shouldAutoCompact(estimatedTokens, windowTokens, messages.length)) return;

  runtime.ui.info(
    `Context ≈${estimatedTokens} tokens (≥90% of the ${windowTokens}-token window) — auto-compacting…`,
  );
  const emitCompact = runtime.compactEmit;
  emitCompact?.({ phase: 'started', auto: true, before: messages.length });
  try {
    const request: ProviderRequest = {
      messages: buildCompactRequestMessages(messages),
      tools: [],
      workspaceRoot: runtime.config.workspaceRoot,
    };
    const response = await withModelRetry(() => runtime.provider.complete(request), {
      onRetry: (attempt, maxRetries) => runtime.ui.info(`Reconnecting… ${attempt}/${maxRetries} (compaction)`),
    });
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
    runtime.ui.info(
      `Auto-compact complete: ${messages.length} → ${runtime.session.messages.length} messages (summary stub + ${recentUser.length} recent user messages).`,
    );
    emitCompact?.({ phase: 'completed', auto: true, before: messages.length, after: runtime.session.messages.length });
  } catch (error) {
    runtime.ui.info(
      `Auto-compact failed (${error instanceof Error ? error.message : String(error)}); keeping full history — char-budget compaction still applies.`,
    );
    emitCompact?.({ phase: 'failed', auto: true, reason: error instanceof Error ? error.message : String(error) });
  }
}
