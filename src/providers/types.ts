export type ProviderName = 'mock' | 'openai' | 'anthropic';

export type ApprovalMode = 'ask' | 'auto' | 'deny';

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';

export type AgentMessage = {
  role: AgentRole;
  content: string;
  name?: string;
  createdAt: string;
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
