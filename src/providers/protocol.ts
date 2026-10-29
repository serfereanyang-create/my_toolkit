import type { AgentAction, AgentMessage, ProviderRequest, ProviderToolSpec } from './types.js';
import type { DelegationLevel } from '../config/types.js';
import { cacheControl } from './cacheStrategy.js';
import { createRequestControl } from './requestControl.js';
import { abortable, abortableDelay, throwIfAborted } from '../utils/cancellation.js';
import { netFetch } from '../utils/net.js';
import { parseToolArguments } from './toolArguments.js';

/**
 * Runtime facts the model would otherwise have to guess or discover via a tool
 * call. All optional so existing callers (and tests) that only pass tools/
 * projectContext/toolStrategy keep working unchanged.
 */
export type PromptIdentity = {
  /** Absolute path to the active workspace root for this session. */
  workspaceRoot?: string;
  /** True when this CLI process was spawned as the agent backend for the desktop IDE. */
  desktopBridge?: boolean;
  /**
   * How readily the agent should delegate to sub-agents. Absent means the
   * documented default (eager) — see delegationHint.
   */
  delegation?: DelegationLevel;
};

import { DEFAULT_DELEGATION_LEVEL, delegationHint } from '../agent/toolStrategy.js';

/**
 * The shell a command will actually run under, and the path format that shell
 * understands. Stated as a fact rather than an instruction because the model
 * has no way to observe it: on Windows `shell: true` means cmd.exe, so an MSYS
 * path like `/c/Users/me` is simply not a path — and the model has no reason to
 * suspect that if it learned paths from a Git Bash transcript.
 */
const SHELL_PATH_HINT = process.platform === 'win32'
  ? 'Shell commands run through cmd.exe, not a POSIX shell: use Windows syntax (dir, %VAR%, &&) and Windows paths ("C:\\Users\\me\\x.txt" or a workspace-relative path such as src/index.ts). An MSYS path like /c/Users/me/x.txt is rejected before it runs.'
  : 'Shell commands run through /bin/sh.';

export function buildToolSystemPromptParts(
  tools: ProviderToolSpec[],
  projectContext?: string,
  toolStrategy?: string,
  identity?: PromptIdentity,
) {
  const stable = [
    `You are aicode, a local coding CLI agent${identity?.desktopBridge ? ', running embedded as the backend of the YOYcode Desktop IDE' : ''}. The user writes natural language. When answering requires local project inspection, file edits, search, or command execution, call a tool and wait for the tool result.`,
    'Prefer native tool calling when available. If you must fall back to text, return exactly one tool call as JSON only (raw or fenced), with no extra prose.',
    'For multi-step tasks, request exactly one tool at a time. After the tool result is provided, request the next tool. Only write the final answer after all required tool results are available.',
    'Investigate before you edit code: read the files you are about to change (read_file, search_text, glob_files, list_files) and say in one or two sentences which files you will change and how, then make the edit. Writing to an existing file or patching code before reading anything is refused.',
    'If a tool fails, do not end the turn and do not repeat the same call. Try a different route: a better dedicated tool, a corrected path or argument, or an equivalent command. Only stop when it genuinely cannot be done, and then say what you tried and why each attempt failed.',
    'If a tool call is blocked by the safety policy, do not look for a way around it — use the dedicated tool that does the same job (read_file instead of shell `type`, apply_patch instead of shell redirection), or tell the user which permission is missing.',
    'If the user asks to create a Word document or .docx file, use create_docx. Do not use run_command for Word document creation.',
    'After create_docx succeeds, stop. Reply with a short confirmation only — do not call create_docx again for the same file.',
    'To read Desktop Word files use read_file with path like desktop/测试.docx or an absolute Desktop path. read_file extracts .docx text. Do not use workspace-relative desktop/ under the project root.',
    'For spreadsheets use create_xlsx (rows as a 2D array or an array of objects; optional headers). For tabular text use read_csv / write_csv. For structured data use read_json (optional dot-path query). Prefer these dedicated tools over run_command.',
    'To find information online when you do not have a URL, use web_search first, then call fetch_url on a chosen result. To fetch a known URL use fetch_url (HTTP GET). Only hosts on the network allowlist are reachable; if fetch_url returns a redirect, call it again with the new URL.',
    'Write final answers as plain terminal text. Do not use Markdown decorations such as **bold**, ## headings, or bullet markdown when talking to the user.',
    `Runtime platform: ${process.platform}. ${SHELL_PATH_HINT} Prefer dedicated tools over shell commands. For disk capacity/free-space questions, use disk_info. For disk growth/recent large files questions, use disk_growth. For recent activity/session/history questions, use recent_activity. For environment/container/system identity questions, use environment_info. For memory/process ranking questions, use process_memory instead of run_command. For cache hit-rate / cache health / cache efficiency questions, use cache_probe.`,
    identity?.workspaceRoot
      ? `Workspace root: ${identity.workspaceRoot}. All relative paths in tool calls resolve against this root.`
      : undefined,
    projectContext ? `Project context and instructions:\n${projectContext}` : undefined,
    // The delegation policy depends on the configured level; the rest of the
    // hint (expert roster, dependsOn rules) is shared. Absent identity means
    // the default, which is what a caller that never heard of this setting
    // should get.
    delegationHint(identity?.delegation ?? DEFAULT_DELEGATION_LEVEL),
    'Text fallback tool call shape:',
    '{"tool":"read_file","input":{"path":"package.json"}}',
    'Available tools:',
    ...tools.map((tool) => `- ${tool.name} [${tool.risk}]: ${tool.description}. Input: ${tool.inputHint}`),
  ].filter((line): line is string => typeof line === 'string').join('\n');

  const dynamic = toolStrategy?.trim()
    ? `Current-turn tool strategy (dynamic; do not treat as stable project instructions):\n${toolStrategy.trim()}`
    : undefined;

  return { stable, dynamic };
}

export function buildToolSystemPrompt(
  tools: ProviderToolSpec[],
  projectContext?: string,
  toolStrategy?: string,
  identity?: PromptIdentity,
) {
  const parts = buildToolSystemPromptParts(tools, projectContext, toolStrategy, identity);
  return [parts.stable, parts.dynamic].filter((part): part is string => Boolean(part)).join('\n');
}

export function toOpenAITools(tools: ProviderToolSpec[]) {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: `${tool.description} Risk: ${tool.risk}.`,
      parameters: toolInputSchema(tool),
    },
  }));
}

export function toAnthropicTools(tools: ProviderToolSpec[]) {
  return tools.map((tool, index) => {
    const entry: Record<string, unknown> = {
      name: tool.name,
      description: `${tool.description} Risk: ${tool.risk}.`,
      input_schema: toolInputSchema(tool),
    };
    // Anthropic evaluates tools before system. This breakpoint caches the tool
    // schema prefix independently; it cannot cover system content that follows.
    // The stable system block owns its own breakpoint in anthropic.ts, while
    // the final message breakpoint advances with conversation history.
    if (index === tools.length - 1) {
      entry.cache_control = cacheControl();
    }
    return entry;
  });
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
      input: parseToolArguments(call.function?.arguments).input,
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

export function toOpenAIResponsesTools(tools: ProviderToolSpec[]) {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: `${tool.description} Risk: ${tool.risk}.`,
    parameters: toolInputSchema(tool),
    strict: false,
  }));
}

export function toolInputSchema(tool: ProviderToolSpec): Record<string, unknown> {
  return tool.inputSchema ?? schemaFromInputHint(tool.inputHint);
}

/**
 * Keys that are the point of the call whenever the tool's own example shows
 * them: omit one and the tool can only answer "… is required". Applied ONLY to
 * keys present in the example, which is what used to go wrong — `required` was
 * built from whatever appeared anywhere in the hint text, so a hint mentioning
 * `"Button"` produced a required `to` that the tool does not accept.
 */
const REQUIRED_KEYS = ['path', 'query', 'command', 'content', 'oldText', 'newText', 'from', 'to'];

export function schemaFromInputHint(inputHint: string): Record<string, unknown> {
  const example = exampleObject(inputHint);
  if (!example) return { type: 'object', additionalProperties: true };
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(example)) properties[key] = describeJsonValue(value);
  if (Object.keys(properties).length === 0) return { type: 'object', additionalProperties: true };
  return {
    type: 'object',
    properties,
    required: REQUIRED_KEYS.filter((key) => key in properties),
    additionalProperties: true,
  };
}

/**
 * The example object a hint carries, decoded.
 *
 * This used to be a regex over the hint body, which produced a schema the model
 * could not follow: a key mentioned in prose (`"Button"` in a window title)
 * became a phantom property because the fallback matched substrings; every
 * array was typed `string`; and a nested object's keys were flattened to the
 * top level. Reading the example as data — the same repair path the model's own
 * arguments go through — keeps the types and the nesting it actually shows.
 */
function exampleObject(inputHint: string): Record<string, unknown> | null {
  const start = inputHint.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < inputHint.length; index += 1) {
    const char = inputHint[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  const text = inputHint.slice(start, end);
  const parsed = parseToolArguments(text);
  if (!parsed.ok) return null;
  return isPlainRecord(parsed.input) ? parsed.input : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeJsonValue(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const first = value[0];
    return first === undefined ? { type: 'array' } : { type: 'array', items: describeJsonValue(first) };
  }
  if (isPlainRecord(value)) {
    const properties: Record<string, Record<string, unknown>> = {};
    for (const [key, nested] of Object.entries(value)) properties[key] = describeJsonValue(nested);
    return { type: 'object', properties, additionalProperties: true };
  }
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'string') return { type: 'string' };
  // null in an example says nothing about the type the tool wants.
  return {};
}

export function toToolAwareMessages(messages: AgentMessage[]) {
  return messages.map((message) => {
    const role = message.role === 'tool' ? 'user' : message.role;
    // Tool messages carrying a screenshot (computer control) also render their
    // image parts: OpenAI chat has no image content type under role 'tool',
    // so they are folded into the user-role stream like the tool text itself.
    if ((message.role === 'user' || message.role === 'tool') && message.parts && message.parts.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      if (message.role === 'tool') {
        content.push({ type: 'text', text: message.name ? `[tool:${message.name}] ${message.content}` : message.content });
      }
      for (const part of message.parts) {
        if (part.type === 'image') {
          content.push({ type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } });
        } else {
          content.push({ type: 'text', text: part.text });
        }
      }
      return { role, content };
    }
    return {
      role,
      content: message.name ? `[tool:${message.name}] ${message.content}` : message.content,
    };
  });
}

export function toAnthropicAwareMessages(
  messages: AgentMessage[],
  options?: {
    slidingCacheBreakpoint?: boolean;
    /**
     * Per-turn text to append AFTER the cached prefix (the tool strategy).
     *
     * It goes on the last message rather than into `system` because Anthropic
     * evaluates the prefix in the order tools → system → messages, so anything
     * in `system` is inside the range the sliding breakpoint covers. The strategy
     * is regenerated every turn from the prompt and recent tool results, so
     * putting it there invalidated the whole conversation history on every turn:
     * the cache could only ever cover tools + the stable system block, which is
     * exactly the ~70% plateau seen in real usage.
     *
     * The last message is new input on every request anyway, so appending there
     * costs nothing and leaves the reusable prefix intact. The OpenAI path solves
     * the same problem with `buildAutoCacheMessages`; this is its equivalent for
     * a provider whose system prompt cannot come after the messages.
     */
    trailingStrategy?: string;
  },
) {
  const converted: Array<{ role: 'user' | 'assistant'; content: unknown }> = messages
    // System instructions travel in `body.system`, which only this provider can
    // populate (the caller's own system messages are hoisted there first). Left
    // in the array they would be downgraded to role 'user' below — a system
    // instruction the model reads as something the user typed.
    .filter((message) => message.role !== 'system')
    .map((message) => {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    if ((message.role === 'user' || message.role === 'tool') && message.parts && message.parts.some((part) => part.type === 'image')) {
      const content: Array<Record<string, unknown>> = [];
      // Tool messages keep their text result; the screenshot follows as an
      // image block so the model sees the screen (user parts are pure image
      // attachments and need no extra text block).
      if (message.role === 'tool') {
        content.push({ type: 'text', text: message.name ? `[tool:${message.name}] ${message.content}` : message.content });
      }
      for (const part of message.parts) {
        if (part.type === 'image') {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.mediaType,
              data: part.data,
            },
          });
        } else {
          content.push({ type: 'text', text: part.text });
        }
      }
      return { role, content };
    }
    return {
      role,
      content: message.name ? `[tool:${message.name}] ${message.content}` : message.content,
    };
  });
  const result: Array<{ role: 'user' | 'assistant'; content: unknown }> = converted.length > 0
    ? converted
    : [{ role: 'user', content: 'Start.' }];

  const strategy = options?.trailingStrategy?.trim();
  if (strategy && result.length > 0) {
    const last = result[result.length - 1]!;
    const block = `Current-turn tool strategy (dynamic; do not treat as stable project instructions):\n${strategy}`;
    // Always split into two blocks: the message's own content, then the
    // strategy. Concatenating them into one string would put the strategy inside
    // whatever block the breakpoint marks, defeating the point.
    if (typeof last.content === 'string') {
      last.content = [{ type: 'text', text: last.content }, { type: 'text', text: block }];
    } else if (Array.isArray(last.content)) {
      last.content.push({ type: 'text', text: block });
    }
  }

  if (options?.slidingCacheBreakpoint && result.length > 0) {
    // Sliding breakpoint: mark ONLY the last message so each request caches the
    // full prefix (tools + system + all prior messages) and the next request
    // reuses it — the breakpoint advances with the conversation. One message
    // breakpoint + system + tools breakpoints stays within Anthropic's 4-limit.
    //
    // With a trailing strategy the breakpoint must sit on the block BEFORE it,
    // or the strategy — which changes every turn — would be inside the cached
    // range and invalidate it. Marking the last message still caches everything
    // up to and including it; only the strategy text appended after stays out.
    const last = result[result.length - 1]!;
    if (typeof last.content === 'string') {
      last.content = [{ type: 'text', text: last.content, cache_control: cacheControl() }];
    } else if (Array.isArray(last.content) && last.content.length > 0) {
      // Mark the last block that is NOT the trailing strategy.
      const index = strategy ? last.content.length - 2 : last.content.length - 1;
      const block = last.content[Math.max(0, index)] as Record<string, unknown> | undefined;
      if (block) block.cache_control = cacheControl();
    }
  }
  return result;
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

/**
 * Every balanced `{...}` / `[...]` block in the text, in order of appearance.
 *
 * Depth-counting with string state, so nested objects and braces inside string
 * literals are handled. Exported because a caller that must pull one JSON object
 * out of prose (code review, structured verdicts) cannot use a naive
 * first-brace-to-last-brace scan: a reply quoting a second object — or JSON from
 * the very code it is reviewing — gets cut in the wrong place.
 */
export function extractBalancedJsonText(content: string, open: '{' | '[', close: '}' | ']'): string[] {
  return extractBalancedJson(content, open, close);
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

export type ProviderTimeouts = {
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
};

export async function fetchWithRetry(url: string, init: Parameters<typeof fetch>[1], attempts = 3, timeouts: ProviderTimeouts = {}) {
  const totalTimeoutMs = timeouts.totalTimeoutMs ?? 300_000;
  const control = createRequestControl(init?.signal, totalTimeoutMs);
  let lastError: unknown;
  try {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(control.signal);
    try {
      // netFetch, not bare fetch: provider traffic has to reach the proxy too,
      // or a machine that only gets out through one cannot even start a turn.
      const response = await abortable(netFetch(url, { ...init, signal: control.signal }), control.signal);
      if (response.ok || response.status < 500 || attempt === attempts) return response;
      lastError = new Error(`HTTP ${response.status}`);
      if (response.body) void response.body.cancel().catch(() => undefined);
    } catch (error) {
      throwIfAborted(control.signal);
      lastError = error;
      if (attempt === attempts) break;
    }
    await abortableDelay(400 * attempt, control.signal);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } finally { control.dispose(); }
}

export type ProviderBodyKind = 'sse' | 'json' | 'text';

/** A gateway may prepend a byte-order mark before the first `data:` line. */
const BOM_PREFIX = new RegExp('^﻿');

/**
 * Decide how to read a 2xx provider body.
 *
 * Every provider used to hard-dispatch on the Content-Type header alone
 * (`includes('application/json')` for the Anthropic non-stream path, a
 * point-blank `!includes('text/event-stream')` for Responses, nothing at all
 * for chat/gemini). Relays routinely answer a `stream: true` request with a
 * plain JSON completion and a wildcard or missing content type (probed: the
 * chat and Gemini providers then yielded `(empty)`/`(empty response)` and dropped
 * the real answer AND its usage). Sniffing a short prefix when the header does
 * not settle it costs one `clone()` read and keeps real SSE streaming
 * incremental — the original body is never buffered.
 */
export async function resolveProviderBodyKind(response: Response): Promise<ProviderBodyKind> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('text/event-stream')) return 'sse';
  if (contentType.includes('json')) return 'json';
  if (!response.body) return 'text';
  const decoder = new TextDecoder();
  const reader = response.clone().body!.getReader();
  let prefix = '';
  try {
    while (prefix.trimStart().length < 16) {
      const { done, value } = await reader.read();
      if (done) break;
      prefix += decoder.decode(value, { stream: true });
    }
  } finally {
    // NOT awaited: cancelling a tee branch (which is what clone() creates) can
    // leave the promise pending forever in Node when the other branch is never
    // consumed — awaited here, every sniffed response hung for 30s until the
    // test runner killed it. The bytes read are a few already-buffered ones.
    try { void reader.cancel().catch(() => undefined); } catch { /* already released */ }
    try { reader.releaseLock(); } catch { /* outstanding read op: the reader is dropped anyway */ }
  }
  const head = prefix.replace(BOM_PREFIX, '').trimStart();
  if (head.startsWith('data:') || head.startsWith(':') || head.startsWith('event:')) return 'sse';
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  return 'text';
}

/**
 * Parse a body that {@link resolveProviderBodyKind} called 'json' or 'text'.
 * Throws a descriptive error instead of letting a plain-text gateway page be
 * mistaken for a completion.
 */
export async function readProviderJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label}: expected JSON but the endpoint returned ${text.slice(0, 200) || '(empty body)'}`);
  }
}

export async function* iterateSseDataLines(response: Response, idleTimeoutMs = 90_000, signal?: AbortSignal, onData?: (data: string) => void): AsyncGenerator<string> {
  throwIfAborted(signal);
  if (!response.body) {
    const text = await abortable(response.text(), signal);
    for (const line of text.split(/\r?\n/)) {
      const data = extractSseData(line);
      if (data !== undefined) { onData?.(data); yield data; }
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  try {
    while (true) {
      throwIfAborted(signal);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const readResult = await abortable(Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { idleTimer = setTimeout(() => reject(new Error(`Provider stream idle timeout after ${idleTimeoutMs}ms`)), idleTimeoutMs); }),
      ]), signal).finally(() => { if (idleTimer !== undefined) clearTimeout(idleTimer); });
      const { done, value } = readResult;
      if (done) { finished = true; break; }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        const data = extractSseData(line);
        if (data !== undefined) { onData?.(data); yield data; }
      }
    }
    if (buffer.trim()) {
      const data = extractSseData(buffer);
      if (data !== undefined) { onData?.(data); yield data; }
    }
  } catch (error) {
    throwIfAborted(signal);
    // Flush any complete SSE lines already buffered before rethrowing (partial recovery).
    if (buffer.trim()) {
      for (const line of buffer.split(/\r?\n/)) {
        const data = extractSseData(line);
        if (data !== undefined) { onData?.(data); yield data; }
      }
    }
    throw error;
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function extractSseData(line: string): string | undefined {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith('data:')) return undefined;
  return trimmed.slice(5).trimStart();
}


export type { ProviderRequest };
