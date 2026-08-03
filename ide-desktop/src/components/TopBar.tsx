import type { AppState } from '../types';

export function TopBar({ state }: { state: AppState }) {
  const provider = state.settings?.providers.find((item) => item.id === state.settings?.activeProviderId);
  return (
    <header className="top-bar">
      <div className="workspace-label">{state.workspaceRoot || 'No workspace'}</div>
      <div className="status-chips">
        <span>{provider?.label || 'Mock'}</span>
        <span>{provider?.model || 'mock-code-agent-v1'}</span>
        <span>{state.settings?.approval || 'ask'}</span>
        <span>{state.agentStatus}</span>
      </div>
    </header>
  );
}
