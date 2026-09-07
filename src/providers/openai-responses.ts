import type { AgentAction, Provider, ProviderRequest, ProviderResponse } from './types.js';
import { fetchWithRetry, iterateSseDataLines, toOpenAIResponsesTools } from './protocol.js';
import { openaiReasoningEffort } from './reasoning.js';

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
      const system = request.messages.find((message) => message.role === 'system')?.content;
      const input = request.continuation?.toolOutputs?.length
        ? request.continuation.toolOutputs.map((item) => ({ type: 'function_call_output', call_id: item.callId, output: item.output }))
        : request.messages.filter((message) => message.role !== 'system').map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }));
      const body: Record<string, unknown> = { model: options.model, input, tools: toOpenAIResponsesTools(request.tools), tool_choice: 'auto' };
      if (request.continuation?.responseId) body.previous_response_id = request.continuation.responseId;
      if (system) body.instructions = system;
      const effort = openaiReasoningEffort(request.reasoningEffort);
      if (effort) body.reasoning = { effort };
      body.stream = true;
      const response = await fetchWithRetry(`${base}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`OpenAI Responses request failed: ${response.status} ${await response.text()}`);

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
          if (typeof event.delta === 'string') thinkingParts.push(event.delta);
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
