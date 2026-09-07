import type { AgentAction, Provider, ProviderRequest, ProviderResponse } from './types.js';
import { buildToolSystemPrompt, iterateSseDataLines, parseToolActions, schemaFromInputHint } from './protocol.js';

export type GeminiProviderOptions = { apiKey?: string; baseUrl?: string; model: string };

type GeminiPart = { text?: string; thought?: boolean; functionCall?: { name?: string; args?: unknown }; functionResponse?: unknown };
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
  return out;
}

function toGeminiContents(request: ProviderRequest) {
  const contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = [];
  for (const message of request.messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [{ text: message.content }];
    if (contents.length > 0 && contents[contents.length - 1]!.role === role) contents[contents.length - 1]!.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents.length ? contents : [{ role: 'user' as const, parts: [{ text: 'Start.' }] }];
}

export function createGeminiProvider(options: GeminiProviderOptions): Provider {
  return {
    name: 'gemini',
    model: options.model,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      if (!options.apiKey) throw new Error('GEMINI_API_KEY is required for provider gemini');
      const base = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
      const url = `${base}/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`;
      const systemText = buildToolSystemPrompt(request.tools, request.projectContext, request.toolStrategy, { workspaceRoot: request.workspaceRoot, desktopBridge: request.desktopBridge });
      const declarations = request.tools.length > 0 ? [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: geminiSchema(schemaFromInputHint(tool.inputHint)) })) }] : undefined;
      const body: Record<string, unknown> = {
        systemInstruction: { role: 'system', parts: [{ text: systemText }] },
        contents: toGeminiContents(request),
        ...(declarations ? { tools: declarations } : {}),
        generationConfig: { temperature: request.reasoningEffort && request.reasoningEffort !== 'off' ? 1 : 0.2 },
      };
      if (request.reasoningEffort && request.reasoningEffort !== 'off') {
        const budgets: Record<string, number> = { low: 2048, medium: 8192, high: 16384, max: 24576 };
        body.generationConfig = { ...(body.generationConfig as object), thinkingConfig: { thinkingBudget: budgets[request.reasoningEffort] ?? 8192 } };
      }
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`Gemini request failed: ${response.status} ${await response.text()}`);
      const events: GeminiResponse[] = [];
      for await (const data of iterateSseDataLines(response)) {
        if (!data || data === '[DONE]') continue;
        try { events.push(JSON.parse(data) as GeminiResponse); } catch { /* ignore malformed event */ }
      }
      const parts = events.flatMap((e) => e.candidates?.[0]?.content?.parts ?? []);
      const textParts = parts.filter((p) => p.text && !p.thought).map((p) => p.text!);
      const thinking = parts.filter((p) => p.thought && p.text).map((p) => p.text!).join('') || undefined;
      const actions: AgentAction[] = parts.filter((p) => p.functionCall?.name).map((p) => ({ type: 'tool' as const, tool: p.functionCall!.name!, input: p.functionCall!.args ?? {} }));
      const usage = events.map((e) => e.usageMetadata).filter(Boolean).at(-1);
      return { actions: actions.length > 0 ? actions : parseToolActions(textParts.join('')), thinking, raw: { events }, usage: usage ? { inputTokens: usage.promptTokenCount ?? 0, outputTokens: usage.candidatesTokenCount ?? 0, ...(usage.cachedContentTokenCount !== undefined ? { cacheReadTokens: usage.cachedContentTokenCount } : {}) } : undefined };
    },
  };
}
