import type { AgentAction, Provider, ProviderRequest, ProviderResponse } from './types.js';
import { controlledProvider } from './requestControl.js';
import { createStreamMetrics } from './streamMetrics.js';
import { buildToolSystemPrompt, iterateSseDataLines, parseToolActions, readProviderJson, resolveProviderBodyKind, toolInputSchema } from './protocol.js';
import { geminiThinkingBudget, isReasoningParamRejection } from './reasoning.js';
import { netFetch } from '../utils/net.js';

export type GeminiProviderOptions = { apiKey?: string; baseUrl?: string; model: string };

type GeminiPart = { text?: string; thought?: boolean; functionCall?: { name?: string; args?: unknown }; functionResponse?: unknown; inlineData?: { mimeType: string; data: string } };
type GeminiResponse = {
  candidates?: Array<{ content?: { role?: string; parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
};

function geminiSchema(value: Record<string, unknown>): Record<string, unknown> {
  const type = typeof value.type === 'string' ? value.type.toUpperCase() : 'OBJECT';
  const out: Record<string, unknown> = { ...value, type };
  if (value.properties && typeof value.properties === 'object') {
    out.properties = Object.fromEntries(Object.entries(value.properties as Record<string, unknown>).map(([k, v]) => [k, geminiSchema(v as Record<string, unknown>)]));
  }
  if (Array.isArray(value.items)) out.items = geminiSchema(value.items[0] as Record<string, unknown>);
  else if (value.items && typeof value.items === 'object') out.items = geminiSchema(value.items as Record<string, unknown>);
  return out;
}

function toGeminiContents(request: ProviderRequest) {
  const contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = [];
  for (const message of request.messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = message.parts?.length
      ? message.parts.map(part => part.type === 'image' ? { inlineData: { mimeType: part.mediaType, data: part.data } } : { text: part.text })
      : [{ text: message.content }];
    if (message.role === 'tool' && message.parts?.length) parts.unshift({ text: message.name ? `[tool:${message.name}] ${message.content}` : message.content });
    if (contents.length > 0 && contents[contents.length - 1]!.role === role) contents[contents.length - 1]!.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents.length ? contents : [{ role: 'user' as const, parts: [{ text: 'Start.' }] }];
}

export function createGeminiProvider(options: GeminiProviderOptions): Provider {
  const provider: Provider = {
    name: 'gemini',
    model: options.model,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      if (!options.apiKey) throw new Error('GEMINI_API_KEY is required for provider gemini');
      const base = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
      const url = `${base}/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`;
      const systemText = buildToolSystemPrompt(request.tools, request.projectContext, request.toolStrategy, { workspaceRoot: request.workspaceRoot, desktopBridge: request.desktopBridge, delegation: request.delegation });
      // Caller-supplied system messages used to be dropped entirely (the loop in
      // toGeminiContents skips the role, and only the built-in prompt reached
      // systemInstruction). They are session-stable instructions, so they lead
      // the systemInstruction prefix.
      const callerSystem = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => (typeof message.content === 'string' ? message.content.trim() : ''))
        .filter(Boolean)
        .join('\n\n');
      const systemInstruction = [callerSystem, systemText].filter((part) => part && part.trim()).join('\n\n');
      const declarations = request.tools.length > 0 ? [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, ...(tool.inputSchema ? { parametersJsonSchema: tool.inputSchema } : { parameters: geminiSchema(toolInputSchema(tool)) }) })) }] : undefined;
      const budget = geminiThinkingBudget(request.reasoningEffort);
      const body: Record<string, unknown> = {
        systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
        contents: toGeminiContents(request),
        ...(declarations ? { tools: declarations } : {}),
        generationConfig: {
          temperature: budget ? 1 : 0.2,
          ...(budget ? { thinkingConfig: { thinkingBudget: budget } } : {}),
        },
      };
      const metrics = createStreamMetrics('sse');
      let response = await netFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey }, body: JSON.stringify(body), signal: request.signal });
      if (!response.ok) {
        const errorText = await response.text();
        // A relay/model that rejects thinkingConfig outright: drop it once rather
        // than failing a turn the caller could have run without reasoning. Only a
        // 4xx that names the field downgrades — a 401/429 must surface as-is.
        if (budget !== undefined && isReasoningParamRejection(response.status, errorText)) {
          const retryBody = { ...body, generationConfig: { temperature: 0.2 } };
          response = await netFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey }, body: JSON.stringify(retryBody), signal: request.signal });
          if (!response.ok) throw new Error(`Gemini request failed: ${response.status} ${await response.text()}`);
        } else {
          throw new Error(`Gemini request failed: ${response.status} ${errorText}`);
        }
      }
      const bodyKind = await resolveProviderBodyKind(response);
      const events: GeminiResponse[] = [];
      if (bodyKind !== 'sse') {
        // Gemini answers a streamGenerateContent request in plain JSON when the
        // endpoint ignores `alt=sse`; the old path read every chunk as SSE and
        // produced "(empty response)" while dropping usage.
        const parsed = await readProviderJson(response, 'Gemini');
        metrics.event();
        events.push(...(Array.isArray(parsed) ? parsed as GeminiResponse[] : [parsed as GeminiResponse]));
      } else {
        for await (const data of iterateSseDataLines(response, undefined, request.signal, (data) => { if (data && data !== '[DONE]') metrics.event(); })) {
          if (data === '[DONE]') break;
          if (!data) continue;
          let event: GeminiResponse;
          try { event = JSON.parse(data) as GeminiResponse; } catch { continue; }
          events.push(event);
          for (const part of event.candidates?.[0]?.content?.parts ?? []) {
            if (part.text && part.thought) { metrics.output(part.text); request.onThinkingDelta?.(part.text); }
            else if (part.text) { metrics.output(part.text); request.onTextDelta?.(part.text); }
          }
        }
      }
      const parts = events.flatMap((e) => e.candidates?.[0]?.content?.parts ?? []);
      const textParts = parts.filter((p) => p.text && !p.thought).map((p) => p.text!);
      const thinking = parts.filter((p) => p.thought && p.text).map((p) => p.text!).join('') || undefined;
      const actions: AgentAction[] = parts.filter((p) => p.functionCall?.name).map((p) => ({ type: 'tool' as const, tool: p.functionCall!.name!, input: p.functionCall!.args ?? {} }));
      const usage = events.map((e) => e.usageMetadata).filter(Boolean).at(-1);
      // `promptTokenCount` includes the cached content; keep the shared shape
      // net-of-cache so cache-hit rate and cost are not double counted.
      const promptTokens = usage?.promptTokenCount ?? 0;
      const completionTokens = usage?.candidatesTokenCount ?? 0;
      const cached = usage?.cachedContentTokenCount;
      // A relay that emits `"usageMetadata": {}` used to produce a fabricated
      // zero-usage entry; report nothing rather than a precise-looking 0.
      const usageBlock = usage && (promptTokens > 0 || completionTokens > 0)
        ? {
            inputTokens: cached === undefined ? promptTokens : Math.max(0, promptTokens - cached),
            outputTokens: completionTokens,
            ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
          }
        : undefined;
      return { actions: actions.length > 0 ? actions : parseToolActions(textParts.join('')), thinking, raw: { events }, usage: usageBlock, streamMetrics: metrics.finish() };
    },
  };
  return controlledProvider(provider);
}
