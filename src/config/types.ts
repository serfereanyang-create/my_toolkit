import type { ApprovalMode, ProviderName, ReasoningEffort } from '../providers/types.js';
import type { ToolScope } from '../tools/scope.js';

export type CliArgs = {
  provider?: ProviderName;
  model?: string;
  baseUrl?: string;
  customProvider?: boolean;
  computerAnyApp?: boolean;
  excelAutomation?: boolean;
  allowedApps?: string[];
  approval?: ApprovalMode;
  workspace?: string;
  sessionDir?: string;
  resumeSessionId?: string;
  prompt?: string;
  maxSteps?: number;
  noBanner?: boolean;
  version?: boolean;
  json?: boolean;
  noColor?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
  ci?: boolean;
  noInput?: boolean;
  configPath?: string;
  profile?: string;
  doctor?: boolean;
  completionShell?: 'bash' | 'zsh' | 'fish' | 'powershell';
  confirmPlan?: boolean;
  desktopBridge?: boolean;
  usageLog?: string;
  reasoningEffort?: ReasoningEffort;
  toolScope?: ToolScope;
};

export type FileProfileConfig = {
  provider?: ProviderName;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  approval?: ApprovalMode;
  sessionDir?: string;
  maxSteps?: number;
  reasoningEffort?: ReasoningEffort;
  /** Network egress policy for the fetch_url tool. */
  network?: { enabled?: boolean; allowlist?: string[] };
};

export type FileConfig = FileProfileConfig & {
  defaultProfile?: string;
  profiles?: Record<string, FileProfileConfig>;
};

export type AppConfig = {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  customProvider?: boolean;
  computerAnyApp?: boolean;
  excelAutomation?: boolean;
  allowedApps?: string[];
  approval: ApprovalMode;
  workspaceRoot: string;
  sessionDir: string;
  network?: { enabled?: boolean; allowlist?: string[] };
  resumeSessionId?: string;
  prompt?: string;
  maxSteps: number;
  noBanner: boolean;
  version?: boolean;
  json?: boolean;
  noColor?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
  ci?: boolean;
  noInput?: boolean;
  configPath?: string;
  profile?: string;
  doctor?: boolean;
  completionShell?: 'bash' | 'zsh' | 'fish' | 'powershell';
  confirmPlan?: boolean;
  desktopBridge?: boolean;
  usageLog?: string;
  reasoningEffort?: ReasoningEffort;
  toolScope?: ToolScope;
};
