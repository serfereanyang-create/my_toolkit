import type { AgentAction, AgentMessage, ProviderRequest, ProviderToolSpec } from './types.js';

export function buildToolSystemPrompt(tools: ProviderToolSpec[], projectContext?: string, toolStrategy?: string) {
  return [
    'You are a local coding CLI agent. The user writes natural language. When answering requires local project inspection, file edits, search, or command execution, request one tool call and wait for the tool result.',
    'Return tool calls as JSON only, either raw JSON or fenced JSON. Do not explain before or after a tool call.',
    'For multi-step tasks, return exactly one tool call at a time. After the tool result is provided, request the next tool. Only write the final answer after all required tool results are available.',
    'If a tool fails and the failure is recoverable, choose a better dedicated tool or a platform-correct fallback instead of asking the user to run the command manually.',
    'If the user asks to create a Word document or .docx file, use create_docx. Do not use run_command for Word document creation.',
    `Runtime platform: ${process.platform}. Prefer dedicated tools over shell commands. For disk capacity/free-space questions, use disk_info. For disk growth/recent large files questions, use disk_growth. For recent activity/session/history questions, use recent_activity. For environment/container/system identity questions, use environment_info. For memory/process ranking questions, use process_memory instead of run_command. If you must run a shell command on Windows, use Windows-compatible commands.`,
    projectContext ? `Project context and instructions:\n${projectContext}` : undefined,
    toolStrategy,
    'Tool call shape:',
    '{"tool":"read_file","input":{"path":"package.json"}}',
    'Available tools:',
    ...tools.map((tool) => `- ${tool.name} [${tool.risk}]: ${tool.description}. Input: ${tool.inputHint}`),
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

export function toToolAwareMessages(messages: AgentMessage[]) {
  return messages.map((message) => ({
    role: message.role === 'tool' ? 'user' : message.role,
    content: message.name ? `[tool:${message.name}] ${message.content}` : message.content,
  }));
}

export function parseToolActions(content: string): AgentAction[] {
  const toolActions = uniqueActions(
    extractJsonCandidates(content)
      .flatMap((candidate) => normalizeParsedActions(safeJson(candidate)))
      .filter((action) => action.type === 'tool'),
  );
  if (toolActions.length > 0) return toolActions;

  for (const candidate of extractJsonCandidates(content)) {
    const actions = normalizeParsedActions(safeJson(candidate));
    if (actions.length > 0) return uniqueActions(actions);
  }
  return [{ type: 'message', content }];
}

function extractJsonCandidates(content: string) {
  const candidates: string[] = [];
  const fenced = content.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
  for (const match of fenced) candidates.push(match[1].trim());
  candidates.push(content.trim());
  candidates.push(...extractBalancedJson(content, '{', '}'));
  candidates.push(...extractBalancedJson(content, '[', ']'));
  return Array.from(new Set(candidates.filter(Boolean)));
}

function extractBalancedJson(content: string, open: '{' | '[', close: '}' | ']') {
  const blocks: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === close && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        blocks.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return blocks;
}

function safeJson(candidate: string) {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function uniqueActions(actions: AgentAction[]) {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = JSON.stringify(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeParsedActions(parsed: unknown): AgentAction[] {
  if (Array.isArray(parsed)) return parsed.flatMap(normalizeParsedActions);
  if (typeof parsed !== 'object' || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  if (typeof record.tool === 'string') {
    return [{ type: 'tool', tool: record.tool, input: record.input ?? {} }];
  }
  if (Array.isArray(record.actions)) return record.actions.flatMap(normalizeParsedActions);
  if (typeof record.message === 'string') return [{ type: 'message', content: record.message }];
  return [];
}

export async function fetchWithRetry(url: string, init: Parameters<typeof fetch>[1], attempts = 3) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok || response.status < 500 || attempt === attempts) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    }
    await delay(400 * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { ProviderRequest };
