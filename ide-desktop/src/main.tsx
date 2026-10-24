import React from 'react';
import { createRoot } from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';
import './conversation-shell.css';
import './settings-shell.css';
import './workspace-shell.css';
import './background-browser.css';
import './gui-control.css';

/*
 * Monaco must be served from the bundled package, not the default CDN.
 * @monaco-editor/react resolves monaco-editor through a loader that falls back
 * to jsdelivr; when that host is unreachable the editor sits on "Loading…"
 * forever with no error. Wiring the loader to the local ESM build keeps the
 * editor working fully offline, which is the normal case for this desktop app.
 */
declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (workerId: string, label: string) => Worker;
    };
  }
}

type MonacoWorkerFactory = new (options?: WorkerOptions) => Worker;
const workerFactories = import.meta.glob([
  '/node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
  '/node_modules/monaco-editor/esm/vs/language/json/json.worker.js',
  '/node_modules/monaco-editor/esm/vs/language/css/css.worker.js',
  '/node_modules/monaco-editor/esm/vs/language/html/html.worker.js',
  '/node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js',
], {
  query: '?worker',
  import: 'default',
  eager: true,
}) as Record<string, MonacoWorkerFactory>;

function workerFactoryFor(label: string): MonacoWorkerFactory | undefined {
  if (label === 'json') return workerFactories['/node_modules/monaco-editor/esm/vs/language/json/json.worker.js'];
  if (label === 'css' || label === 'scss' || label === 'less') return workerFactories['/node_modules/monaco-editor/esm/vs/language/css/css.worker.js'];
  if (label === 'html' || label === 'handlebars' || label === 'razor') return workerFactories['/node_modules/monaco-editor/esm/vs/language/html/html.worker.js'];
  if (label === 'typescript' || label === 'javascript') return workerFactories['/node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js'];
  return workerFactories['/node_modules/monaco-editor/esm/vs/editor/editor.worker.js'];
}

window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    const WorkerFactory = workerFactoryFor(label);
    if (!WorkerFactory) throw new Error(`没有找到 ${label} 的编辑器 worker`);
    return new WorkerFactory({ name: label });
  },
};

loader.config({ monaco });

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
