export type ProviderName = 'mock' | 'openai' | 'grok' | 'glm' | 'kimi' | 'deepseek' | 'anthropic';
export type ApprovalMode = 'ask' | 'auto' | 'deny';

export type ProviderConfig = { model?: string; baseUrl?: string; apiKey?: string };
export type FileConfig = {
  provider?: ProviderName;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  approval?: ApprovalMode;
  workspaceRoot?: string;
  maxSteps?: number;
  networkAllowlist?: string[];
  providers?: Partial<Record<ProviderName, ProviderConfig>>;
};
export type AppConfig = {
  provider: ProviderName;
  model: string;
  baseUrl: string;
  apiKey?: string;
  approval: ApprovalMode;
  workspaceRoot: string;
  maxSteps: number;
  networkAllowlist: string[];
};
