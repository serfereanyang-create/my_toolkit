import { useEffect, useReducer } from 'react';
import { CodeEditor } from './components/CodeEditor';
import { EditorTabs } from './components/EditorTabs';
import { FileTree } from './components/FileTree';
import { Layout } from './components/Layout';
import { SettingsPanel } from './components/SettingsPanel';
import { Welcome } from './components/Welcome';
import { desktop } from './lib/ipc';
import { appReducer, initialState, languageForPath } from './lib/state';

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);

  useEffect(() => {
    desktop.settings.get().then((settings) => dispatch({ type: 'settings/loaded', settings }));
    return desktop.agent.onEvent((event) => dispatch({ type: 'agent/event', event }));
  }, []);

  async function openWorkspace() {
    const result = await desktop.workspace.open();
    if (!result.canceled && result.root) {
      dispatch({ type: 'workspace/opened', root: result.root });
      const tree = await desktop.workspace.getTree('.');
      dispatch({ type: 'tree/loaded', tree });
    }
  }

  async function openFile(path: string) {
    const content = await desktop.fs.read(path);
    dispatch({ type: 'tab/opened', tab: { path, content, savedContent: content, language: languageForPath(path) } });
  }

  async function saveActiveFile() {
    const tab = state.tabs.find((item) => item.path === state.activeTabPath);
    if (!tab) return;
    await desktop.fs.write(tab.path, tab.content);
    dispatch({ type: 'tab/saved', path: tab.path, content: tab.content });
  }

  async function saveSettings(next: NonNullable<typeof state.settings>) {
    const settings = await desktop.settings.set(next);
    dispatch({ type: 'settings/loaded', settings });
  }

  async function saveApiKey(providerId: string, apiKey: string) {
    await desktop.secrets.setApiKey(providerId, apiKey);
    const settings = await desktop.settings.get();
    const providers = await Promise.all(settings.providers.map(async (provider) => {
      if (provider.type === 'mock') return provider;
      const keyState = await desktop.secrets.hasApiKey(provider.id);
      return { ...provider, keyHint: keyState.hint };
    }));
    dispatch({ type: 'settings/loaded', settings: { ...settings, providers } });
  }

  if (!state.workspaceRoot) return <main className="app-shell"><Welcome onOpenWorkspace={openWorkspace} /></main>;

  return (
    <Layout
      state={state}
      onViewChange={(view) => dispatch({ type: 'view/set', view })}
      sidebar={
        state.activeView === 'settings' && state.settings
          ? <SettingsPanel settings={state.settings} onSave={saveSettings} onSaveKey={saveApiKey} />
          : state.activeView === 'files'
            ? <FileTree tree={state.tree} onOpenFile={openFile} />
            : <div className="pane-title">{state.activeView}</div>
      }
      editor={
        <>
          <EditorTabs tabs={state.tabs} activePath={state.activeTabPath} onActivate={(path) => dispatch({ type: 'tab/activate', path })} />
          <CodeEditor
            tab={state.tabs.find((item) => item.path === state.activeTabPath)}
            onChange={(content) => state.activeTabPath && dispatch({ type: 'tab/changed', path: state.activeTabPath, content })}
            onSave={saveActiveFile}
          />
        </>
      }
      ai={<div className="ai-placeholder">Agent panel</div>}
      bottom={<div className="muted">Tool output</div>}
    />
  );
}
