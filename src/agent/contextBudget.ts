import type { AgentMessage } from '../providers/types.js';

const DEFAULT_BUDGET_CHARS = 80_000;
const DEFAULT_TOOL_CHARS = 4_000;
const DEFAULT_ASSISTANT_CHARS = 6_000;
const DEFAULT_USER_CHARS = 8_000;

export type ContextBudgetOptions = {
  budgetChars?: number;
  maxToolChars?: number;
  maxAssistantChars?: number;
  maxUserChars?: number;
};

export type CompactResult = {
  messages: AgentMessage[];
  truncated: boolean;
  originalChars: number;
  compactChars: number;
  droppedMessages: number;
};

export function resolveContextBudgetChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AICODE_CONTEXT_BUDGET_CHARS?.trim();
  if (!raw) return DEFAULT_BUDGET_CHARS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 4_000) return DEFAULT_BUDGET_CHARS;
  return Math.floor(value);
}

export function compactMessagesForModel(
  messages: AgentMessage[],
  options: ContextBudgetOptions = {},
): CompactResult {
  const budgetChars = options.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const maxToolChars = options.maxToolChars ?? DEFAULT_TOOL_CHARS;
  const maxAssistantChars = options.maxAssistantChars ?? DEFAULT_ASSISTANT_CHARS;
  const maxUserChars = options.maxUserChars ?? DEFAULT_USER_CHARS;

  const originalChars = messages.reduce((sum, message) => sum + messageChars(message), 0);
  if (messages.length === 0) {
    return { messages: [], truncated: false, originalChars: 0, compactChars: 0, droppedMessages: 0 };
  }

  const clipped = messages.map((message) => clipMessage(message, {
    maxToolChars,
    maxAssistantChars,
    maxUserChars,
  }));

  const selected: AgentMessage[] = [];
  let used = 0;
  for (let index = clipped.length - 1; index >= 0; index -= 1) {
    const message = clipped[index]!;
    const size = messageChars(message) + 1;
    if (selected.length > 0 && used + size > budgetChars) {
      const older = clipped.slice(0, index + 1);
      const summary = buildHistorySummary(older);
      const summaryMessage: AgentMessage = {
        role: 'user',
        content: summary,
        createdAt: older[0]?.createdAt ?? new Date().toISOString(),
      };
      // Ensure summary + selected fit; if not, drop summary and keep newest only.
      const summarySize = messageChars(summaryMessage) + 1;
      if (used + summarySize <= budgetChars) {
        return {
          messages: [summaryMessage, ...selected],
          truncated: true,
          originalChars,
          compactChars: used + summarySize,
          droppedMessages: older.length,
        };
      }
      return {
        messages: selected,
        truncated: true,
        originalChars,
        compactChars: used,
        droppedMessages: older.length,
      };
    }
    selected.unshift(message);
    used += size;
  }

  const compactChars = selected.reduce((sum, message) => sum + messageChars(message), 0);
  return {
    messages: selected,
    truncated: compactChars !== originalChars,
    originalChars,
    compactChars,
    droppedMessages: 0,
  };
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

function messageChars(message: AgentMessage): number {
  return (message.content?.length ?? 0) + (message.name?.length ?? 0) + message.role.length + 8;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function countBy(values: string[]) {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
