import type { AgentAction, AgentMessage, ProviderRequest, ProviderToolSpec } from './types.js';

export function buildToolSystemPrompt(tools: ProviderToolSpec[], projectContext?: string, toolStrategy?: string) {
  return [
    'You are a local coding CLI agent. The user writes natural language. When answering requires local project inspection, file edits, search, or command execution, call a tool and wait for the tool result.',
    'Prefer native tool calling when available. If you must fall back to text, return exactly one tool call as JSON only (raw or fenced), with no extra prose.',
    'For multi-step tasks, request exactly one tool at a time. After the tool result is provided, request the next tool. Only write the final answer after all required tool results are available.',
    'If a tool fails and the failure is recoverable, choose a better dedicated tool or a platform-correct fallback instead of asking the user to run the command manually.',
    'If the user asks to create a Word document or .docx file, use create_docx. Do not use run_command for Word document creation.',
    'To read Desktop Word files use read_file with path like desktop/测试.docx or an absolute Desktop path. read_file extracts .docx text. Do not use workspace-relative desktop/ under the project root.',
    'Write final answers as plain terminal text. Do not use Markdown decorations such as **bold**, ## headings, or bullet markdown when talking to the user.',
    `Runtime platform: ${process.platform}. Prefer dedicated tools over shell commands. For disk capacity/free-space questions, use disk_info. For disk growth/recent large files questions, use disk_growth. For recent activity/session/history questions, use recent_activity. For environment/container/system identity questions, use environment_info. For memory/process ranking questions, use process_memory instead of run_command. If you must run a shell command on Windows, use Windows-compatible commands.`,
    projectContext ? `Project context and instructions:\n${projectContext}` : undefined,
    toolStrategy,
    'Text fallback tool call shape:',
    '{"tool":"read_file","input":{"path":"package.json"}}',
    'Available tools:',
    ...tools.map((tool) => `- ${tool.name} [${tool.risk}]: ${tool.description}. Input: ${tool.inputHint}`),
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

export function toOpenAITools(tools: ProviderToolSpec[]) {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: `${tool.description} Risk: ${tool.risk}.`,
      parameters: schemaFromInputHint(tool.inputHint),
    },
  }));
}

export function toAnthropicTools(tools: ProviderToolSpec[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: `${tool.description} Risk: ${tool.risk}.`,
    input_schema: schemaFromInputHint(tool.inputHint),
  }));
}

export function parseOpenAIToolCalls(message: {
  content?: string | null;
  tool_calls?: Array<{
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}): AgentAction[] {
  const actions: AgentAction[] = [];
  for (const call of message.tool_calls ?? []) {
    const name = call.function?.name;
    if (!name) continue;
    actions.push({
      type: 'tool',
      tool: name,
      input: parseToolArguments(call.function?.arguments),
    });
  }
  if (actions.length > 0) return uniqueActions(actions);
  return parseToolActions(message.content ?? '');
}

export function parseAnthropicContentBlocks(content: Array<Record<string, unknown>> | undefined): AgentAction[] {
  const blocks = content ?? [];
  const toolActions: AgentAction[] = [];
  const textParts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      toolActions.push({
        type: 'tool',
        tool: block.name,
        input: typeof block.input === 'object' && block.input !== null ? block.input : {},
      });
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text);
  }
  if (toolActions.length > 0) return uniqueActions(toolActions);
  return parseToolActions(textParts.join('\n'));
}

function schemaFromInputHint(inputHint: string): Record<string, unknown> {
  const properties: Record<string, { type: string }> = {};
  const required: string[] = [];
  const objectMatch = inputHint.match(/\{([\s\S]*)\}/);
  const body = objectMatch?.[1] ?? '';
  for (const fieldMatch of body.matchAll(/"([A-Za-z_][\w]*)"\s*:/g)) {
    const key = fieldMatch[1]!;
    properties[key] = { type: inferJsonTypeFromHint(body, key) };
  }
  // Common tool fields used across the registry even when not present in freeform hints.
  for (const key of ['path', 'query', 'command', 'maxFiles', 'maxMatches', 'maxBytes', 'timeoutMs', 'drive', 'hours', 'minMb', 'limit', 'includeVersions', 'maxSessions', 'maxResults', 'kind', 'from', 'to', 'oldText', 'newText', 'content']) {
    if (!properties[key] && inputHint.includes(key)) properties[key] = { type: inferJsonTypeFromHint(inputHint, key) };
  }
  if (Object.keys(properties).length === 0) {
    return { type: 'object', additionalProperties: true };
  }
  for (const key of Object.keys(properties)) {
    if (['path', 'query', 'command', 'content', 'oldText', 'newText', 'from', 'to'].includes(key)) required.push(key);
  }
  return {
    type: 'object',
    properties,
    required: required.filter((key) => key in properties),
    additionalProperties: true,
  };
}

function inferJsonTypeFromHint(hint: string, key: string): string {
  const snippet = hint.slice(Math.max(0, hint.indexOf(key) - 5), hint.indexOf(key) + key.length + 24);
  if (/"?\d+"?/.test(snippet) || /number|max|limit|hours|bytes|timeout/i.test(key)) return 'number';
  if (/true|false|boolean/i.test(snippet)) return 'boolean';
  return 'string';
}

function parseToolArguments(value: string | undefined): unknown {
  if (!value || !value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

export function toToolAwareMessages(messages: AgentMessage[]) {
  return messages.map((message) => {
    const role = message.role === 'tool' ? 'user' : message.role;
    if (message.role === 'user' && message.parts && message.parts.length > 0) {
      const content = message.parts.map((part) => {
        if (part.type === 'image') {
          return {
            type: 'image_url' as const,
            image_url: {
              url: `data:${part.mediaType};base64,${part.data}`,
            },
          };
        }
        return { type: 'text' as const, text: part.text };
      });
      return { role, content };
    }
    return {
      role,
      content: message.name ? `[tool:${message.name}] ${message.content}` : message.content,
    };
  });
}

export function toAnthropicAwareMessages(messages: AgentMessage[]) {
  const converted = messages.map((message) => {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    if (message.role === 'user' && message.parts && message.parts.some((part) => part.type === 'image')) {
      const content = message.parts.map((part) => {
        if (part.type === 'image') {
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: part.mediaType,
              data: part.data,
            },
          };
        }
        return { type: 'text' as const, text: part.text };
      });
      return { role, content };
    }
    return {
      role,
      content: message.name ? `[tool:${message.name}] ${message.content}` : message.content,
    };
  });
  return converted.length > 0 ? converted : [{ role: 'user' as const, content: 'Start.' }];
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

export async function* iterateSseDataLines(response: Response): AsyncGenerator<string> {
  if (!response.body) {
    const text = await response.text();
    for (const line of text.split(/\r?\n/)) {
      const data = extractSseData(line);
      if (data !== undefined) yield data;
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      const data = extractSseData(line);
      if (data !== undefined) yield data;
    }
  }
  if (buffer.trim()) {
    const data = extractSseData(buffer);
    if (data !== undefined) yield data;
  }
}

function extractSseData(line: string): string | undefined {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith('data:')) return undefined;
  return trimmed.slice(5).trimStart();
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { ProviderRequest };
