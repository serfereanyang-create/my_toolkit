export type ProviderType = 'mock' | 'openai' | 'anthropic' | 'custom';
export type ApprovalMode = 'ask' | 'auto' | 'deny';
export type ActivityView = 'files' | 'search' | 'sessions' | 'settings';

export type ProviderConfig = {
  id: string;
  type: ProviderType;
  label: string;
  model: string;
  baseUrl: string;
  keyHint?: string;
};

export type DesktopSettings = {
  activeProviderId: string;
  approval: ApprovalMode;
  providers: ProviderConfig[];
  recentWorkspaces: string[];
};

export type TreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
};

export type EditorTab = {
  path: string;
  content: string;
  savedContent: string;
  language: string;
};

export type AgentEvent = {
  type: string;
  [key: string]: unknown;
};

export type ChatItem =
  | { id: string; kind: 'user'; text: string; ts?: number }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'tool'; status: 'running' | 'done' | 'failed'; tool: string; input?: unknown; output?: string; ok?: boolean }
  | { id: string; kind: 'approval'; requestId: string; tool: string; message: string; input?: unknown };

export type AppState = {
  workspaceRoot: string;
  activeView: ActivityView;
  settings: DesktopSettings | null;
  tree: TreeNode[];
  tabs: EditorTab[];
  activeTabPath: string;
  chat: ChatItem[];
  agentStatus: 'offline' | 'starting' | 'ready' | 'running';
  bottomOpen: boolean;
};
