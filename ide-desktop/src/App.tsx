import { useEffect, useReducer } from 'react';
import { Layout } from './components/Layout';
import { Welcome } from './components/Welcome';
import { desktop } from './lib/ipc';
import { appReducer, initialState } from './lib/state';

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);

  useEffect(() => {
    desktop.settings.get().then((settings) => dispatch({ type: 'settings/loaded', settings }));
    return desktop.agent.onEvent((event) => dispatch({ type: 'agent/event', event }));
  }, []);

  async function openWorkspace() {
    const result = await desktop.workspace.open();
    if (!result.canceled && result.root) dispatch({ type: 'workspace/opened', root: result.root });
  }

  if (!state.workspaceRoot) return <main className="app-shell"><Welcome onOpenWorkspace={openWorkspace} /></main>;

  return (
    <Layout
      state={state}
      onViewChange={(view) => dispatch({ type: 'view/set', view })}
      sidebar={<div className="pane-title">{state.activeView}</div>}
      editor={<div className="empty-editor">Open a file from the sidebar.</div>}
      ai={<div className="ai-placeholder">Agent panel</div>}
      bottom={<div className="muted">Tool output</div>}
    />
  );
}
