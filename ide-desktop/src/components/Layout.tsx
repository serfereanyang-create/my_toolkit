import type { ReactNode } from 'react';
import type { AppState } from '../types';
import { ActivityBar } from './ActivityBar';
import { TopBar } from './TopBar';

export function Layout({ state, onViewChange, sidebar, editor, ai, bottom }: {
  state: AppState;
  onViewChange: (view: AppState['activeView']) => void;
  sidebar: ReactNode;
  editor: ReactNode;
  ai: ReactNode;
  bottom: ReactNode;
}) {
  return (
    <main className="ide-shell">
      <TopBar state={state} />
      <ActivityBar active={state.activeView} onChange={onViewChange} />
      <aside className="sidebar">{sidebar}</aside>
      <section className="editor-area">{editor}</section>
      <aside className="ai-area">{ai}</aside>
      <section className="bottom-panel">{bottom}</section>
    </main>
  );
}
