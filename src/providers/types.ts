export type ProviderName = 'mock' | 'openai' | 'openai-responses' | 'anthropic' | 'gemini' | 'grok' | 'glm' | 'kimi' | 'deepseek';

export type ApprovalMode = 'ask' | 'auto' | 'deny' | 'plan';

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; path?: string };

export type AgentMessage = {
  displayText?: string;
  interrupted?: boolean;
  role: AgentRole;
  content: string;
  name?: string;
  createdAt: string;
  /** Optional multimodal parts (vision images). content remains a text summary for tools/logs. */
  parts?: MessagePart[];
};

export type ResponsesContinuation = {
  responseId: string;
  pendingCalls?: Array<{ callId: string; name: string }>;
  toolOutputs?: Array<{ callId: string; output: string }>;
  status?: 'pending' | 'ready' | 'completed' | 'failed';
  updatedAt?: string;
};

export type AgentAction =
  | { type: 'message'; content: string }
  | { type: 'tool'; tool: string; input: unknown; callId?: string };

/**
 * Model reasoning/thinking effort tier requested by the user. Provider-agnostic;
 * each provider maps it to its own native parameter (Anthropic thinking
 * budget_tokens, OpenAI reasoning_effort) and silently downgrades if the
 * endpoint rejects it. 'off' means send no thinking parameter at all.
 */
export type ReasoningEffort = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max';

export type ProviderRequest = {
  signal?: AbortSignal;
  timeoutMs?: number;
  messages: AgentMessage[];
  tools: ProviderToolSpec[];
  workspaceRoot: string;
  projectContext?: string;
  toolStrategy?: string;
  /** Optional streaming callback for assistant text deltas. */
  onTextDelta?: (delta: string) => void;
  /** Streaming callback for reasoning/thinking deltas (separate from the answer). */
  onThinkingDelta?: (delta: string) => void;
  /** Requested reasoning effort tier; provider maps it to its native param. */
  reasoningEffort?: ReasoningEffort;
  /** True when this CLI process is running as the agent backend for the desktop IDE. */
  desktopBridge?: boolean;
  /**
   * How readily the agent should delegate to sub-agents. Absent means the
   * documented default; the value only selects which delegation block goes into
   * the stable system prompt, so it must not vary within a session or the
   * cached prefix is lost.
   */
  delegation?: import('../config/types.js').DelegationLevel;
  /** True when the wire provider is a user-configured custom endpoint. */
  customProvider?: boolean;
  /** Responses continuation state for the next function_call_output turn. */
  continuation?: ResponsesContinuation;
};

export type ProviderToolSpec = {
  name: string;
  description: string;
  inputHint: string;
  inputSchema?: Record<string, unknown>;
  risk: 'read' | 'write' | 'shell' | 'network';
};

/** Real token usage reported by the provider API for a single completion. */
export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt cache (Anthropic cache_read_input_tokens / OpenAI cached_tokens). */
  cacheReadTokens?: number;
  /** Tokens written to the provider's prompt cache this turn (Anthropic cache_creation_input_tokens). */
  cacheCreationTokens?: number;
  /**
   * Agent-side estimate of how much of the prompt is reusable from the previous
   * turn's packed prompt prefix. Independent from provider-reported cache data.
   */
  localCachePredictedRate?: number;
};

export type ProviderResponse = {
  actions: AgentAction[];
  raw?: unknown;
  /** Optional provider reasoning/thinking text, kept separate from final answer. */
  thinking?: string;
  /** Real token usage extracted from the provider response, when available. */
  usage?: ProviderUsage;
  /** Timing and cadence facts for streamed provider responses. */
  streamMetrics?: import('./streamMetrics.js').StreamMetrics;
  continuation?: ResponsesContinuation;
};

export type Provider = {
  name: ProviderName;
  model: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
};
