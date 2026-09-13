import type { AgentMessage, MessagePart } from '../providers/types.js';

const DEFAULT_BUDGET_CHARS = 80_000;
/** Start aggressive clip when packed size exceeds this ratio of budget (soft threshold). */
const DEFAULT_SOFT_RATIO = 0.72;
/** Always keep this many newest messages intact when possible. */
const DEFAULT_KEEP_RECENT = 10;
/** Keep this many oldest non-system messages as a stable cache-friendly prefix. */
const DEFAULT_KEEP_PREFIX = 2;

const DEFAULT_TOOL_CHARS = 4_000;
const DEFAULT_TOOL_CHARS_SOFT = 2_000;
const DEFAULT_ASSISTANT_CHARS = 6_000;
const DEFAULT_ASSISTANT_CHARS_SOFT = 3_000;
const DEFAULT_USER_CHARS = 8_000;
const DEFAULT_USER_CHARS_SOFT = 4_000;

export type ContextBudgetOptions = {
  budgetChars?: number;
  softRatio?: number;
  keepRecent?: number;
  keepPrefix?: number;
  maxToolChars?: number;
  maxToolCharsSoft?: number;
  maxAssistantChars?: number;
  maxAssistantCharsSoft?: number;
  maxUserChars?: number;
  maxUserCharsSoft?: number;
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
  maxToolCharsSoft: number;
  maxAssistantChars: number;
  maxAssistantCharsSoft: number;
  maxUserChars: number;
  maxUserCharsSoft: number;
};

export function resolveContextBudgetChars(env: NodeJS.ProcessEnv = process.env): number {
  return resolveContextBudgetConfig(env).budgetChars;
}

export function resolveContextBudgetConfig(env: NodeJS.ProcessEnv = process.env): ContextBudgetConfig {
  return {
    budgetChars: readIntEnv(env, 'AICODE_CONTEXT_BUDGET_CHARS', DEFAULT_BUDGET_CHARS, 4_000),
    softRatio: readFloatEnv(env, 'AICODE_CONTEXT_SOFT_RATIO', DEFAULT_SOFT_RATIO, 0.4, 0.95),
    keepRecent: readIntEnv(env, 'AICODE_CONTEXT_KEEP_RECENT', DEFAULT_KEEP_RECENT, 2),
    keepPrefix: readIntEnv(env, 'AICODE_CONTEXT_KEEP_PREFIX', DEFAULT_KEEP_PREFIX, 0),
    maxToolChars: readIntEnv(env, 'AICODE_CONTEXT_MAX_TOOL_CHARS', DEFAULT_TOOL_CHARS, 500),
    maxToolCharsSoft: readIntEnv(env, 'AICODE_CONTEXT_MAX_TOOL_CHARS_SOFT', DEFAULT_TOOL_CHARS_SOFT, 300),
    maxAssistantChars: readIntEnv(env, 'AICODE_CONTEXT_MAX_ASSISTANT_CHARS', DEFAULT_ASSISTANT_CHARS, 500),
    maxAssistantCharsSoft: readIntEnv(env, 'AICODE_CONTEXT_MAX_ASSISTANT_CHARS_SOFT', DEFAULT_ASSISTANT_CHARS_SOFT, 300),
    maxUserChars: readIntEnv(env, 'AICODE_CONTEXT_MAX_USER_CHARS', DEFAULT_USER_CHARS, 500),
    maxUserCharsSoft: readIntEnv(env, 'AICODE_CONTEXT_MAX_USER_CHARS_SOFT', DEFAULT_USER_CHARS_SOFT, 300),
  };
}

export function compactMessagesForModel(
  messages: AgentMessage[],
  options: ContextBudgetOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): CompactResult {
  const cfg = { ...resolveContextBudgetConfig(env), ...normalizeOptions(options) };
  const originalChars = messages.reduce((sum, message) => sum + messageChars(message), 0);
  if (messages.length === 0) {
    return emptyResult(0);
  }

  // Always strip historical image binary from packed messages (keep only latest user images).
  const { messages: withoutHistoryImages, imagesStripped } = stripHistoricalImages(messages);
  const afterStripChars = withoutHistoryImages.reduce((sum, message) => sum + messageChars(message), 0);

  if (afterStripChars <= cfg.budgetChars * cfg.softRatio) {
    const compactChars = withoutHistoryImages.reduce((sum, message) => sum + messageChars(message), 0);
    return {
      messages: withoutHistoryImages,
      truncated: imagesStripped > 0 || compactChars !== originalChars,
      originalChars,
      compactChars,
      droppedMessages: 0,
      softTriggered: false,
      imagesStripped,
      mode: imagesStripped > 0 ? 'soft-clip' : 'passthrough',
    };
  }

  // Soft clip: shrink tool/assistant/user bodies but keep all messages (prefix-stable for cache).
  const softClipped = withoutHistoryImages.map((message, index) => {
    const isRecent = index >= withoutHistoryImages.length - cfg.keepRecent;
    if (isRecent) {
      return clipMessage(message, {
        maxToolChars: cfg.maxToolChars,
        maxAssistantChars: cfg.maxAssistantChars,
        maxUserChars: cfg.maxUserChars,
      });
    }
    return clipMessage(message, {
      maxToolChars: cfg.maxToolCharsSoft,
      maxAssistantChars: cfg.maxAssistantCharsSoft,
      maxUserChars: cfg.maxUserCharsSoft,
    });
  });
  const softChars = softClipped.reduce((sum, message) => sum + messageChars(message), 0);
  if (softChars <= cfg.budgetChars) {
    return {
      messages: softClipped,
      truncated: true,
      originalChars,
      compactChars: softChars,
      droppedMessages: 0,
      softTriggered: true,
      imagesStripped,
      mode: 'soft-clip',
    };
  }

  // Hard pack: keep stable prefix + newest tail; summarize the dropped middle.
  const packed = hardPack(softClipped, cfg);
  return {
    ...packed,
    originalChars,
    softTriggered: true,
    imagesStripped,
    mode: 'hard-pack',
  };
}

function hardPack(messages: AgentMessage[], cfg: ContextBudgetConfig): Omit<CompactResult, 'originalChars' | 'softTriggered' | 'imagesStripped' | 'mode'> & { mode?: never } {
  const budgetChars = cfg.budgetChars;
  const keepRecent = Math.min(cfg.keepRecent, messages.length);
  const keepPrefix = Math.min(cfg.keepPrefix, Math.max(0, messages.length - keepRecent));

  const prefix = messages.slice(0, keepPrefix);
  const tail = messages.slice(messages.length - keepRecent);
  const middle = messages.slice(keepPrefix, messages.length - keepRecent);

  // Clip prefix lightly so it stays cache-stable and small.
  const prefixClipped = prefix.map((message) => clipMessage(message, {
    maxToolChars: Math.min(cfg.maxToolCharsSoft, 1_200),
    maxAssistantChars: Math.min(cfg.maxAssistantCharsSoft, 1_200),
    maxUserChars: Math.min(cfg.maxUserCharsSoft, 1_500),
  }));

  const selected: AgentMessage[] = [];
  let used = 0;

  for (const message of prefixClipped) {
    const size = messageChars(message) + 1;
    if (used + size > budgetChars * 0.35 && selected.length > 0) break;
    selected.push(message);
    used += size;
  }

  // Reserve room for tail by packing from newest of the soft-clipped full list if prefix empty.
  const tailSelected: AgentMessage[] = [];
  let tailUsed = 0;
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const message = tail[index]!;
    const size = messageChars(message) + 1;
    if (tailSelected.length > 0 && used + tailUsed + size > budgetChars) break;
    if (tailSelected.length === 0 && size > budgetChars - used) {
      // Force-fit latest message by clipping harder.
      const tight = clipMessage(message, {
        maxToolChars: Math.min(1_500, cfg.maxToolCharsSoft),
        maxAssistantChars: Math.min(1_500, cfg.maxAssistantCharsSoft),
        maxUserChars: Math.min(2_000, cfg.maxUserCharsSoft),
      });
      tailSelected.unshift(tight);
      tailUsed += messageChars(tight) + 1;
      break;
    }
    tailSelected.unshift(message);
    tailUsed += size;
  }

  const droppedMiddle = middle.length + (tail.length - tailSelected.length) + (prefix.length - selected.length);
  let resultMessages = [...selected, ...tailSelected];
  let compactChars = resultMessages.reduce((sum, message) => sum + messageChars(message), 0);

  if (droppedMiddle > 0 && middle.length > 0) {
    const summary = buildHistorySummary(middle);
    const summaryMessage: AgentMessage = {
      role: 'user',
      content: summary,
      createdAt: middle[0]?.createdAt ?? new Date().toISOString(),
    };
    const summarySize = messageChars(summaryMessage) + 1;
    if (compactChars + summarySize <= budgetChars) {
      // Insert summary between prefix and tail for readability; prefix stays first for cache.
      resultMessages = [...selected, summaryMessage, ...tailSelected];
      compactChars += summarySize;
    }
  }

  // Final safety: if still over budget, drop from just after prefix.
  while (resultMessages.length > 1 && compactChars > budgetChars) {
    const dropIndex = Math.min(selected.length, resultMessages.length - 1);
    if (dropIndex <= 0 && resultMessages.length > 1) {
      resultMessages.splice(1, 1);
    } else if (dropIndex < resultMessages.length - 1) {
      resultMessages.splice(dropIndex, 1);
    } else {
      break;
    }
    compactChars = resultMessages.reduce((sum, message) => sum + messageChars(message), 0);
  }

  return {
    messages: resultMessages,
    truncated: true,
    compactChars,
    droppedMessages: Math.max(0, messages.length - resultMessages.length + (resultMessages.some((m) => m.content.startsWith('[compacted session history]')) ? 1 : 0)),
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

function buildHistorySummary(messages: AgentMessage[]): string {
  const tools = messages.filter((message) => message.role === 'tool');
  const users = messages.filter((message) => message.role === 'user');
  const assistants = messages.filter((message) => message.role === 'assistant');
  const toolNames = countBy(tools.map((message) => message.name ?? 'tool'));
  const failures = tools.filter((message) => /failed|error|blocked|ENOENT|AssertionError/i.test(message.content)).length;
  const latestUser = [...users].reverse().find((message) => !message.content.startsWith('[compacted session history]'));

  const toolSummary = Object.entries(toolNames)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([name, count]) => `${name}×${count}`)
    .join(', ') || 'none';

  const snippets = tools
    .slice(-6)
    .map((message) => `- ${message.name ?? 'tool'}: ${oneLine(message.content).slice(0, 120)}`)
    .join('\n');

  return [
    '[compacted session history]',
    `Older messages compacted: users=${users.length}, assistants=${assistants.length}, tools=${tools.length}, toolFailures≈${failures}.`,
    `Tool mix: ${toolSummary}.`,
    latestUser ? `Oldest retained context cue: ${oneLine(latestUser.content).slice(0, 200)}` : undefined,
    snippets ? `Recent older tool tails:\n${snippets}` : undefined,
    'Use this summary as background only; prefer newer messages for current task state.',
  ].filter((line): line is string => typeof line === 'string').join('\n');
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
  if (options.maxToolCharsSoft !== undefined) out.maxToolCharsSoft = options.maxToolCharsSoft;
  if (options.maxAssistantChars !== undefined) out.maxAssistantChars = options.maxAssistantChars;
  if (options.maxAssistantCharsSoft !== undefined) out.maxAssistantCharsSoft = options.maxAssistantCharsSoft;
  if (options.maxUserChars !== undefined) out.maxUserChars = options.maxUserChars;
  if (options.maxUserCharsSoft !== undefined) out.maxUserCharsSoft = options.maxUserCharsSoft;
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
