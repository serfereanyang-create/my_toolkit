import type { ToolCall, ToolDefinition, ToolResult } from '../tools/types.js';
export type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolCalls?: ToolCall[] };
export type ProviderResponse = { text: string; toolCalls: ToolCall[] };
export interface Provider { complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ProviderResponse>; }
export type ToolExecution = { call: ToolCall; result: ToolResult };
