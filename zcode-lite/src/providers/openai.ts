import type { AppConfig } from '../config/types.js';
import type { Provider, ChatMessage, ProviderResponse } from './types.js';
import type { ToolDefinition } from '../tools/types.js';
export class OpenAiProvider implements Provider {
  constructor(private readonly config: AppConfig) {}
  async complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ProviderResponse> {
    if (!this.config.apiKey) throw new Error(`Missing API key for ${this.config.provider}`);
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: this.config.model, messages: messages.map(m => ({ role: m.role === 'tool' ? 'tool' : m.role, content: m.content, tool_call_id: m.toolCallId, tool_calls: m.toolCalls?.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) })), tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: 'auto' }), signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`${this.config.provider} request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const json = await response.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> }; const message = json.choices?.[0]?.message; if (!message) throw new Error('Provider response has no message');
    return { text: message.content ?? '', toolCalls: (message.tool_calls ?? []).map(call => ({ id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) })) };
  }
}
function parseArguments(value: string): Record<string, unknown> { try { const parsed: unknown = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { throw new Error('Provider returned invalid tool arguments'); } }
