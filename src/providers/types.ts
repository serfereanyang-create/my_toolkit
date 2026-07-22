export type ProviderName = 'mock' | 'openai' | 'anthropic';

export type ApprovalMode = 'ask' | 'auto' | 'deny';

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; path?: string };

export type AgentMessage = {
  role: AgentRole;
  content: string;
  name?: string;
  createdAt: string;
  /** Optional multimodal parts (vision images). content remains a text summary for tools/logs. */
  parts?: MessagePart[];
};

export type AgentAction =
  | { type: 'message'; content: string }
  | { type: 'tool'; tool: string; input: unknown };

export type ProviderRequest = {
  messages: AgentMessage[];
  tools: ProviderToolSpec[];
  workspaceRoot: string;
  projectContext?: string;
  toolStrategy?: string;
  /** Optional streaming callback for assistant text deltas. */
  onTextDelta?: (delta: string) => void;
};

export type ProviderToolSpec = {
  name: string;
  description: string;
  inputHint: string;
  risk: 'read' | 'write' | 'shell';
};

export type ProviderResponse = {
  actions: AgentAction[];
  raw?: unknown;
};

export type Provider = {
  name: ProviderName;
  model: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
};
