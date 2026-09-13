import type { AgentAction, Provider, ProviderRequest, ProviderResponse } from './types.js';
import { fetchWithRetry, iterateSseDataLines, toOpenAIResponsesTools, buildToolSystemPromptParts } from './protocol.js';
import { isReasoningParamRejection, openaiReasoningEffort } from './reasoning.js';

export type OpenAIResponsesProviderOptions = { apiKey?: string; baseUrl?: string; model: string };

function collectText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.text === 'string') parts.push(obj.text);
    if (Array.isArray(obj.content)) for (const content of obj.content) {
      if (content && typeof content === 'object' && typeof (content as Record<string, unknown>).text === 'string') parts.push((content as Record<string, string>).text);
    }
  }
  return parts.join('');
}

function collectThinking(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.reasoning_content === 'string') parts.push(obj.reasoning_content);
    if (Array.isArray(obj.summary)) for (const summary of obj.summary) {
      if (summary && typeof summary === 'object' && typeof (summary as Record<string, unknown>).text === 'string') parts.push((summary as Record<string, string>).text);
    }
  }
  return parts.join('') || undefined;
}

function usageFromResponse(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  const details = usage.input_tokens_details;
  const cached = details && typeof details === 'object' && typeof (details as Record<string, unknown>).cached_tokens === 'number'
    ? (details as Record<string, number>).cached_tokens : undefined;
  if (inputTokens <= 0 && outputTokens <= 0) return undefined;
  return { inputTokens, outputTokens, ...(cached !== undefined ? { cacheReadTokens: cached } : {}) };
}

function parseResponseActions(output: unknown): AgentAction[] {
  if (!Array.isArray(output)) return [];
  return output.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const obj = item as Record<string, unknown>;
    if (obj.type !== 'function_call' || typeof obj.name !== 'string' || typeof obj.arguments !== 'string') return [];
    let input: unknown = {};
    try { input = JSON.parse(obj.arguments); } catch { input = { raw: obj.arguments }; }
    return [{ type: 'tool' as const, tool: obj.name, input, callId: typeof obj.call_id === 'string' ? obj.call_id : undefined }];
  });
}

export function createOpenAIResponsesProvider(options: OpenAIResponsesProviderOptions): Provider {
  return {
    name: 'openai-responses',
    model: options.model,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      if (!options.apiKey) throw new Error('OPENAI_API_KEY is required for provider openai-responses');
      const base = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
      // previous_response_id continuation is an OpenAI first-party feature:
      // custom endpoints (proxy/relay gateways) reject it with 400. For those,
      // replay the whole conversation from request.messages instead — tool
      // results are already appended there, so context stays complete.
      const officialOpenAI = !options.baseUrl || options.baseUrl.startsWith('https://api.openai.com');
      const useServerContinuation = Boolean(request.continuation?.responseId)
        && request.customProvider !== true
        && officialOpenAI;
      // Responses API: instructions 是独立于 input 的稳定前缀段（自动缓存）。
      // 只放 stable 部分；每轮变化的 toolStrategy 尾置为最后一条 input 项，
      // 否则 instructions 每轮字节变化 → 自动前缀缓存整体失效。
      const systemParts = buildToolSystemPromptParts(request.tools, request.projectContext, request.toolStrategy, {
        workspaceRoot: request.workspaceRoot,
        desktopBridge: request.desktopBridge,
      });
      const input: unknown[] = useServerContinuation && request.continuation?.toolOutputs?.length
        ? request.continuation.toolOutputs.map((item) => ({ type: 'function_call_output', call_id: item.callId, output: item.output }))
        : request.messages.filter((message) => message.role !== 'system').flatMap((message) => {
          const items: unknown[] = [{ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }];
          // Computer-control screenshots ride on tool messages; the Responses
          // API takes images as a separate user input_image item.
          if (message.role === 'tool' && message.parts) {
            for (const part of message.parts) {
              if (part.type === 'image') {
                items.push({ role: 'user', content: [{ type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}` }] });
              }
            }
          }
          return items;
        });
      if (systemParts.dynamic && systemParts.dynamic.trim()) {
        input.push({ role: 'system', content: systemParts.dynamic });
      }
      const body: Record<string, unknown> = { model: options.model, input, tools: toOpenAIResponsesTools(request.tools), tool_choice: 'auto' };
      if (useServerContinuation) body.previous_response_id = request.continuation!.responseId;
      // Caller-supplied system messages are session-stable instructions: keep
      // them at the head of the stable prefix instead of silently dropping
      // them, so custom deployments that pass a system message are honored.
      const callerSystem = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => (typeof message.content === 'string' ? message.content.trim() : ''))
        .filter(Boolean)
        .join('\n\n');
      const instructions = [callerSystem, systemParts.stable].filter((part) => part && part.trim()).join('\n\n');
      if (instructions) body.instructions = instructions;
      const effort = openaiReasoningEffort(request.reasoningEffort);
      if (effort) body.reasoning = { effort };
      body.stream = true;
      const postResponses = () => fetchWithRetry(`${base}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` }, body: JSON.stringify(body) });
      let response = await postResponses();
      if (!response.ok) {
        const errorText = await response.text();
        // 未知自定义端点可能不认 reasoning 参数：4xx 点名 reasoning 时降级一次
        // （去掉档位重发），而不是让整轮失败。
        if (isReasoningParamRejection(response.status, errorText) && body.reasoning) {
          delete body.reasoning;
          response = await postResponses();
          if (!response.ok) throw new Error(`OpenAI Responses request failed: ${response.status} ${await response.text()}`);
        } else {
          throw new Error(`OpenAI Responses request failed: ${response.status} ${errorText}`);
        }
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        const json = await response.json() as Record<string, unknown>;
        const toolActions = parseResponseActions(json.output);
        const text = typeof json.output_text === 'string' ? json.output_text : collectText(json.output);
        const thinking = typeof json.reasoning_content === 'string' ? json.reasoning_content : collectThinking(json.output);
        const continuation = typeof json.id === 'string' && toolActions.length > 0 ? { responseId: json.id, status: 'pending' as const, updatedAt: new Date().toISOString() } : undefined;
        return { actions: toolActions.length ? toolActions : [{ type: 'message', content: text || '(empty response)' }], thinking, continuation, usage: usageFromResponse(json.usage), raw: json };
      }

      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const calls = new Map<string, { name: string; args: string; complete: boolean }>();
      const events: unknown[] = [];
      let responseId: string | undefined;
      let usage: ProviderResponse['usage'];
      for await (const data of iterateSseDataLines(response)) {
        if (!data || data === '[DONE]') continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
        events.push(event);
        const type = typeof event.type === 'string' ? event.type : '';
        if (type === 'response.output_text.delta') {
          const delta = typeof event.delta === 'string' ? event.delta : '';
          if (delta) { textParts.push(delta); request.onTextDelta?.(delta); }
        } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
          if (typeof event.delta === 'string' && event.delta) {
            thinkingParts.push(event.delta);
            request.onThinkingDelta?.(event.delta);
          }
        } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
          const item = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : {};
          if (item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
            calls.set(item.call_id, { name: item.name, args: typeof item.arguments === 'string' ? item.arguments : '', complete: type.endsWith('done') });
          }
        } else if (type === 'response.function_call_arguments.delta') {
          const callId = typeof event.call_id === 'string' ? event.call_id : '';
          if (callId) { const current = calls.get(callId) ?? { name: '', args: '', complete: false }; current.args += typeof event.delta === 'string' ? event.delta : ''; calls.set(callId, current); }
        } else if (type === 'response.function_call_arguments.done') {
          const callId = typeof event.call_id === 'string' ? event.call_id : '';
          if (callId && calls.has(callId)) calls.get(callId)!.complete = true;
        } else if (type === 'response.completed') {
          const result = event.response && typeof event.response === 'object' ? event.response as Record<string, unknown> : {};
          if (typeof result.id === 'string') responseId = result.id;
          usage = usageFromResponse(result.usage);
        } else if (type === 'response.failed' || type === 'error') {
          throw new Error(`OpenAI Responses stream failed: ${typeof event.message === 'string' ? event.message : type}`);
        }
      }
      const toolActions: AgentAction[] = [];
      for (const [callId, call] of calls) {
        if (!call.complete || !call.name) continue;
        let input: unknown = {};
        try { input = JSON.parse(call.args || '{}'); } catch { input = { raw: call.args }; }
        toolActions.push({ type: 'tool', tool: call.name, input, callId });
      }
      const text = textParts.join('');
      const continuation = responseId && toolActions.length > 0 ? { responseId, pendingCalls: toolActions.filter((a): a is Extract<AgentAction, { type: 'tool' }> => a.type === 'tool').map((a) => ({ callId: a.callId!, name: a.tool })), status: 'pending' as const, updatedAt: new Date().toISOString() } : undefined;
      return { actions: toolActions.length ? toolActions : [{ type: 'message', content: text || '(empty response)' }], thinking: thinkingParts.join('') || undefined, continuation, usage, raw: { events, responseId } };
    },
  };
}
