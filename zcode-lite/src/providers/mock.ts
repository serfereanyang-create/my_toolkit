import type { Provider, ChatMessage, ProviderResponse } from './types.js';
import type { ToolDefinition } from '../tools/types.js';
export class MockProvider implements Provider {
  async complete(messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ProviderResponse> {
    const last = messages.at(-1); if (last?.role === 'tool') return { text: `Mock completed.\n${last.content}`, toolCalls: [] };
    const prompt = [...messages].reverse().find(m => m.role === 'user')?.content.toLowerCase() ?? '';
    if (prompt.includes('list') && prompt.includes('file')) return { text: '', toolCalls: [{ id: 'mock-list', name: 'list_files', input: {} }] };
    if (prompt.includes('read') && /[\w.-]+\.[\w-]+/.test(prompt)) return { text: '', toolCalls: [{ id: 'mock-read', name: 'read_file', input: { path: prompt.match(/[\w.-]+\.[\w-]+/)?.[0] ?? 'README.md' } }] };
    return { text: `Mock response: ${[...messages].reverse().find(m => m.role === 'user')?.content ?? ''}`, toolCalls: [] };
  }
}
