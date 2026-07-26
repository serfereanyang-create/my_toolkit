import type { ApprovalMode, ProviderName } from '../providers/types.js';

export type CliArgs = {
  provider?: ProviderName;
  model?: string;
  baseUrl?: string;
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
};

export type FileProfileConfig = {
  provider?: ProviderName;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  approval?: ApprovalMode;
  sessionDir?: string;
  maxSteps?: number;
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
  approval: ApprovalMode;
  workspaceRoot: string;
  sessionDir: string;
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
};
