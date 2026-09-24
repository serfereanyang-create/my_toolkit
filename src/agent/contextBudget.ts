import type { AgentMessage, MessagePart } from '../providers/types.js';
import {
  APPROX_BYTES_PER_TOKEN,
  effectiveContextWindow,
  resolveModelContextWindow,
} from './modelWindows.js';

/**
 * Fallback hard budget, used only when no context window can be resolved.
 *
 * The real budget is DERIVED from the model's window (see
 * `resolveContextBudgetConfig`), because a fixed char budget is wrong by
 * construction: it is the same number for a 128k model and a 1M model, and on a
 * large-window model it silently discards much of the conversation.
 *
 * Measured against the real usage ledger (~/.aicode/usage.jsonl, 103 non-mock
 * turns): the median request carried ~43k tokens and the p90 ~76k, against a
 * fixed 80_000-char (~20k token) budget. 97 of 103 requests were over it, and
 * the median request had ~53% of its context that the budget could not carry.
 */
const DEFAULT_BUDGET_CHARS = 80_000;
/** Start aggressive clip when packed size exceeds this ratio of budget (soft threshold). */
const DEFAULT_SOFT_RATIO = 0.72;
/** Always keep this many newest messages intact when possible. */
const DEFAULT_KEEP_RECENT = 10;
/** Keep this many oldest non-system messages as a stable cache-friendly prefix. */
const DEFAULT_KEEP_PREFIX = 2;

/**
 * Per-message clip limits, applied by ROLE and by nothing else.
 *
 * These were two tiers — a generous limit for the newest N messages and a tight
 * one for everything older — chosen by distance from the end of the array. That
 * is a cache killer, and the reason is subtle: the boundary MOVES. Every step
 * appends messages, so a message that was "recent" becomes "older", gets
 * re-clipped at the tighter limit, and `truncateText` writes the omitted count
 * into the body. The bytes of a message in the MIDDLE of the history change, and
 * every message after it is a cache miss. Measured on a 20-message history: the
 * first divergence appeared at message 10, with `truncated 3080 chars` becoming
 * `truncated 6080 chars` purely because two messages were appended.
 *
 * Clipping by role alone makes a message's packed form a pure function of the
 * message, so it is byte-identical no matter how much history surrounds it.
 * That is the property the prompt cache needs, and it costs only a slightly
 * smaller allowance for the newest messages.
 *
 * The tool limit follows codex's `truncation_policy` (models.json:
 * `{ "mode": "tokens", "limit": 10000 }`, and the fallback metadata's
 * `bytes(10_000)`), converted at APPROX_BYTES_PER_TOKEN. At 4_000 chars it was
 * ten times tighter than that, which is why tool output — 276k of the 277k
 * chars in the largest real session — arrived at the model as a few hundred
 * characters per call. Assistant and user messages are model- and human-
 * produced and naturally bounded, so they keep a smaller cap.
 */
const DEFAULT_TOOL_CHARS = 40_000;
const DEFAULT_ASSISTANT_CHARS = 6_000;
const DEFAULT_USER_CHARS = 8_000;

export type ContextBudgetOptions = {
  budgetChars?: number;
  softRatio?: number;
  keepRecent?: number;
  keepPrefix?: number;
  maxToolChars?: number;
  maxAssistantChars?: number;
  maxUserChars?: number;
  /** Model id used to derive the budget when `budgetChars` is not given. */
  model?: string;
};

export type CompactResult = {
  messages: AgentMessage[];
  truncated: boolean;
  originalChars: number;
  compactChars: number;
  droppedMessages: number;
  softTriggered: boolean;
  imagesStripped: number;
  mode: 'passthrough' | 'soft-clip' | 'hard-pack';
};

export type ContextBudgetConfig = {
  budgetChars: number;
  softRatio: number;
  keepRecent: number;
  keepPrefix: number;
  maxToolChars: number;
  maxAssistantChars: number;
  maxUserChars: number;
  /** The context window the budget was derived from, in tokens. */
  windowTokens: number;
};

export function resolveContextBudgetChars(env: NodeJS.ProcessEnv = process.env, model?: string): number {
  return resolveContextBudgetConfig(env, model).budgetChars;
}

/**
 * Resolve the packing budget.
 *
 * Resolution order:
 *   1. `AICODE_CONTEXT_BUDGET_CHARS` — an explicit override, always wins.
 *   2. the model's context window (see modelWindows.ts), converted to chars.
 *
 * Deriving from the window is the whole point. The previous fixed 80_000-char
 * default is ~20k tokens, which is 1/14th of a 272k-token model's window and
 * 1/6th of a 128k one: the same number for every model, and far below all of
 * them. On the real ledger the median request carried ~43k tokens, so the old
 * budget could not hold roughly half of a typical request's context — and it
 * discarded that half silently, from the middle of the conversation.
 *
 * The conversion uses codex's 4-bytes-per-token estimate
 * (`APPROX_BYTES_PER_TOKEN`, utils/string/src/truncate.rs). The budget is the
 * EFFECTIVE window — the window minus the output headroom
 * (`effective_context_window_percent`) — so a full pack still leaves room for
 * the reply and for the tool definitions that ride outside the message array.
 */
export function resolveContextBudgetConfig(
  env: NodeJS.ProcessEnv = process.env,
  model?: string,
): ContextBudgetConfig {
  const windowTokens = resolveModelContextWindow(model, env);
  const derivedChars = effectiveContextWindow(windowTokens) * APPROX_BYTES_PER_TOKEN;
  return {
    budgetChars: readIntEnv(env, 'AICODE_CONTEXT_BUDGET_CHARS', derivedChars, 4_000),
    softRatio: readFloatEnv(env, 'AICODE_CONTEXT_SOFT_RATIO', DEFAULT_SOFT_RATIO, 0.4, 0.95),
    keepRecent: readIntEnv(env, 'AICODE_CONTEXT_KEEP_RECENT', DEFAULT_KEEP_RECENT, 2),
    keepPrefix: readIntEnv(env, 'AICODE_CONTEXT_KEEP_PREFIX', DEFAULT_KEEP_PREFIX, 0),
    maxToolChars: readIntEnv(env, 'AICODE_CONTEXT_MAX_TOOL_CHARS', DEFAULT_TOOL_CHARS, 500),
    maxAssistantChars: readIntEnv(env, 'AICODE_CONTEXT_MAX_ASSISTANT_CHARS', DEFAULT_ASSISTANT_CHARS, 500),
    maxUserChars: readIntEnv(env, 'AICODE_CONTEXT_MAX_USER_CHARS', DEFAULT_USER_CHARS, 500),
    windowTokens,
  };
}

/**
 * Clip one message to its role's limit.
 *
 * Exported because it is the unit of cache stability: the packed form of a
 * message must depend on that message alone, and a test asserts it directly.
 */
export function clipMessageByRole(message: AgentMessage, cfg: ContextBudgetConfig): AgentMessage {
  return clipMessage(message, {
    maxToolChars: cfg.maxToolChars,
    maxAssistantChars: cfg.maxAssistantChars,
    maxUserChars: cfg.maxUserChars,
  });
}

export function compactMessagesForModel(
  messages: AgentMessage[],
  options: ContextBudgetOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): CompactResult {
  const cfg = { ...resolveContextBudgetConfig(env, options.model), ...normalizeOptions(options) };
  const originalChars = messages.reduce((sum, message) => sum + messageChars(message), 0);
  if (messages.length === 0) {
    return emptyResult(0);
  }

  // Always strip historical image binary from packed messages (keep only latest user images).
  const { messages: withoutHistoryImages, imagesStripped } = stripHistoricalImages(messages);
  const afterStripChars = withoutHistoryImages.reduce((sum, message) => sum + messageChars(message), 0);

  // Below the soft threshold, pack nothing. `clipMessageByRole` is still applied
  // so a message's bytes do not CHANGE when the session later crosses the
  // threshold — otherwise crossing it would rewrite the whole history at once.
  if (afterStripChars <= cfg.budgetChars * cfg.softRatio) {
    const underThreshold = withoutHistoryImages.map((message) => clipMessageByRole(message, cfg));
    const compactChars = underThreshold.reduce((sum, message) => sum + messageChars(message), 0);
    return {
      messages: underThreshold,
      truncated: imagesStripped > 0 || compactChars !== originalChars,
      originalChars,
      compactChars,
      droppedMessages: 0,
      softTriggered: false,
      imagesStripped,
      mode: imagesStripped > 0 ? 'soft-clip' : 'passthrough',
    };
  }

  // Clip every message by role. Identical treatment for every position, which is
  // what keeps the prefix byte-stable as the window slides.
  const clipped = withoutHistoryImages.map((message) => clipMessageByRole(message, cfg));
  const clippedChars = clipped.reduce((sum, message) => sum + messageChars(message), 0);
  if (clippedChars <= cfg.budgetChars) {
    return {
      messages: clipped,
      truncated: true,
      originalChars,
      compactChars: clippedChars,
      droppedMessages: 0,
      softTriggered: true,
      imagesStripped,
      mode: 'soft-clip',
    };
  }

  // Hard pack: keep the newest messages that fit, and drop the older ones.
  const packed = hardPack(clipped, cfg);
  return {
    ...packed,
    originalChars,
    softTriggered: true,
    imagesStripped,
    mode: 'hard-pack',
  };
}

/**
 * Keep the newest messages that fit, dropping the oldest.
 *
 * Deliberately does NOT inject a summary of the dropped middle. The previous
 * version inserted `[compacted session history]` at position `keepPrefix` — early
 * in the array — with text that was a live count of the messages being dropped
 * ("tools=6" → "tools=7"). That message changed on every step, so every message
 * after it was a cache miss: measured on a 24-message history, only 2 of 13 kept
 * messages survived byte-identical between two consecutive steps.
 *
 * Dropping from the front instead means the retained messages keep their bytes,
 * and it is honest: nothing is silently rewritten into a paraphrase.
 *
 * On quantizing the drop point: the boundary is NOT rounded to a block. That was
 * tried, to make the window advance in coarse steps, and it broke the budget
 * invariant outright — rounding down left the packed result over budget on 19 of
 * 30 steps, which is the one thing this function exists to prevent. Cache
 * stability comes from `clipMessageByRole` being a pure function of each message
 * instead; the drop point is free to move exactly as far as the budget requires.
 */
function hardPack(clipped: AgentMessage[], cfg: ContextBudgetConfig): Omit<CompactResult, 'originalChars' | 'softTriggered' | 'imagesStripped' | 'mode'> {
  const budgetChars = cfg.budgetChars;
  const sizes = clipped.map((message) => messageChars(message) + 1);
  const total = sizes.reduce((sum, size) => sum + size, 0);

  // Drop exactly as many of the oldest as it takes, keeping at least the newest.
  let start = 0;
  let remaining = total;
  while (remaining > budgetChars && start < clipped.length - 1) {
    remaining -= sizes[start]!;
    start += 1;
  }

  let kept = clipped.slice(start);
  let used = remaining;

  // A single message larger than the whole budget still has to fit: clip it
  // harder rather than dropping it, or the model loses the newest input.
  if (kept.length === 1 && used > budgetChars) {
    const tight = clipMessage(kept[0]!, {
      maxToolChars: Math.min(1_500, cfg.maxToolChars),
      maxAssistantChars: Math.min(1_500, cfg.maxAssistantChars),
      maxUserChars: Math.min(2_000, cfg.maxUserChars),
    });
    kept = [tight];
    used = messageChars(tight) + 1;
  }

  return {
    messages: kept,
    truncated: true,
    compactChars: used,
    droppedMessages: start,
  };
}

/** Strip image parts from all but the latest vision-carrying message (user or tool). */
export function stripHistoricalImages(messages: AgentMessage[]): { messages: AgentMessage[]; imagesStripped: number } {
  let lastUserWithImage = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if ((message.role === 'user' || message.role === 'tool') && message.parts?.some((part) => part.type === 'image')) {
      lastUserWithImage = index;
      break;
    }
  }

  let imagesStripped = 0;
  const next = messages.map((message, index) => {
    if (!message.parts?.length) return message;
    if (index === lastUserWithImage) return message;
    const kept: MessagePart[] = [];
    let stripped = 0;
    for (const part of message.parts) {
      if (part.type === 'image') {
        stripped += 1;
        kept.push({
          type: 'text',
          text: `[image omitted from history: ${part.path ?? part.mediaType}]`,
        });
      } else {
        kept.push(part);
      }
    }
    if (stripped === 0) return message;
    imagesStripped += stripped;
    const text = kept.filter((part) => part.type === 'text').map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    return {
      ...message,
      content: text || message.content,
      // Keep a parts array (text placeholders) so callers can see images were replaced, not dropped silently.
      parts: kept,
    };
  });
  return { messages: next, imagesStripped };
}

function clipMessage(
  message: AgentMessage,
  limits: { maxToolChars: number; maxAssistantChars: number; maxUserChars: number },
): AgentMessage {
  if (message.role === 'tool') {
    return { ...message, content: truncateText(message.content, limits.maxToolChars, `tool:${message.name ?? 'unknown'}`) };
  }
  if (message.role === 'assistant') {
    return { ...message, content: truncateText(message.content, limits.maxAssistantChars, 'assistant') };
  }
  if (message.role === 'user') {
    return { ...message, content: truncateText(message.content, limits.maxUserChars, 'user') };
  }
  return message;
}

function truncateText(content: string, maxChars: number, label: string): string {
  if (content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.7);
  const tail = Math.max(0, maxChars - head - 80);
  const omitted = content.length - head - tail;
  return `${content.slice(0, head)}\n...[${label} truncated ${omitted} chars]...\n${content.slice(-tail)}`;
}

export function messageChars(message: AgentMessage): number {
  let total = (message.content?.length ?? 0) + (message.name?.length ?? 0) + message.role.length + 8;
  if (message.parts) {
    for (const part of message.parts) {
      if (part.type === 'text') total += part.text.length;
      // Count images by small constant, not base64 length (they should already be stripped in pack path).
      if (part.type === 'image') total += Math.min(part.data.length, 256) + 32;
    }
  }
  return total;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function countBy(values: string[]) {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function emptyResult(originalChars: number): CompactResult {
  return {
    messages: [],
    truncated: false,
    originalChars,
    compactChars: 0,
    droppedMessages: 0,
    softTriggered: false,
    imagesStripped: 0,
    mode: 'passthrough',
  };
}

function normalizeOptions(options: ContextBudgetOptions): Partial<ContextBudgetConfig> {
  const out: Partial<ContextBudgetConfig> = {};
  if (options.budgetChars !== undefined) out.budgetChars = options.budgetChars;
  if (options.softRatio !== undefined) out.softRatio = options.softRatio;
  if (options.keepRecent !== undefined) out.keepRecent = options.keepRecent;
  if (options.keepPrefix !== undefined) out.keepPrefix = options.keepPrefix;
  if (options.maxToolChars !== undefined) out.maxToolChars = options.maxToolChars;
  if (options.maxAssistantChars !== undefined) out.maxAssistantChars = options.maxAssistantChars;
  if (options.maxUserChars !== undefined) out.maxUserChars = options.maxUserChars;
  return out;
}

function readIntEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number) {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) return fallback;
  return Math.floor(value);
}

function readFloatEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number) {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}
