import type { AgentEvent, DesktopSettings, TreeNode } from '../types';

type ZCodeDesktopApi = {
  workspace: {
    open(): Promise<{ canceled: boolean; root?: string }>;
    setRoot(root: string): Promise<{ root: string }>;
    getTree(relativePath?: string): Promise<TreeNode[]>;
  };
  fs: {
    read(relativePath: string): Promise<string>;
    write(relativePath: string, content: string): Promise<{ ok: boolean; path: string }>;
  };
  settings: {
    get(): Promise<DesktopSettings>;
    set(next: Partial<DesktopSettings>): Promise<DesktopSettings>;
  };
  secrets: {
    setApiKey(providerId: string, apiKey: string): Promise<{ configured: boolean; hint: string }>;
    hasApiKey(providerId: string): Promise<{ configured: boolean; hint: string }>;
  };
  agent: {
    start(): Promise<{ ok: boolean }>;
    prompt(text: string): Promise<{ ok: boolean }>;
    cancel(): Promise<{ ok: boolean }>;
    restart(): Promise<{ ok: boolean }>;
    approve(requestId: string, decision: 'allow_once' | 'allow_session' | 'deny'): Promise<{ ok: boolean }>;
    onEvent(handler: (event: AgentEvent) => void): () => void;
  };
};

declare global {
  interface Window {
    zcodeDesktop: ZCodeDesktopApi;
  }
}

export const desktop = window.zcodeDesktop;
