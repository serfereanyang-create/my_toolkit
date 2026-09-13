import type { AppConfig } from '../config/types.js';
import type { Provider, ChatMessage, ProviderResponse } from './types.js';
import type { ToolDefinition } from '../tools/types.js';
export class AnthropicProvider implements Provider {
  constructor(private readonly config: AppConfig) {}
  async complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ProviderResponse> {
    if (!this.config.apiKey) throw new Error('Missing API key for anthropic');
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/v1/messages`, { method: 'POST', headers: { 'x-api-key': this.config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: this.config.model, max_tokens: 2048, messages: messages.filter(m => m.role !== 'system').map(toAnthropicMessage), tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) }), signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`anthropic request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const json = await response.json() as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> }; const content = json.content ?? [];
    return { text: content.filter(x => x.type === 'text').map(x => x.text ?? '').join(''), toolCalls: content.filter(x => x.type === 'tool_use').map(x => ({ id: x.id ?? crypto.randomUUID(), name: x.name ?? '', input: x.input ?? {} })) };
  }
}
function toAnthropicMessage(message: ChatMessage): unknown {
  if (message.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }] };
  if (message.role === 'assistant' && message.toolCalls?.length) return { role: 'assistant', content: [{ type: 'text', text: message.content || '' }, ...message.toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input }))] };
  return { role: message.role, content: message.content };
}
