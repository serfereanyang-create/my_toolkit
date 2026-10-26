import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';
import './conversation-shell.css';
import './settings-shell.css';
import './workspace-shell.css';
import './background-browser.css';
import './gui-control.css';

/*
 * Monaco 不在这里加载。
 *
 * 它曾经在这个文件的顶层 `import * as monaco from 'monaco-editor'`，于是整个
 * 编辑器连全部语言服务一起进了首屏 chunk——启动时先解析 5MB，哪怕这次根本没
 * 打开发编辑器。现在它住 `lib/monacoRuntime.ts`，只由编辑器组件按需拉。
 */

const reportGlobalError = (error: unknown, source: string) => {
  console.error(`[UI ${source}]`, error);
};

window.addEventListener('error', (event) => reportGlobalError(event.error ?? event.message, 'error'));
window.addEventListener('unhandledrejection', (event) => reportGlobalError(event.reason, 'unhandledrejection'));

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
