import React from 'react';
import { createRoot } from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

/*
 * Monaco must be served from the bundled package, not the default CDN.
 * @monaco-editor/react resolves monaco-editor through a loader that falls back
 * to jsdelivr; when that host is unreachable the editor sits on "Loading…"
 * forever with no error. Wiring the loader to the local ESM build keeps the
 * editor working fully offline, which is the normal case for this desktop app.
 *
 * Workers are created from same-origin blob URLs rather than `?worker` imports:
 * monaco-editor's package `exports` map rewrites every `./*` subpath to
 * `esm/vs/*.js`, so the deep `?worker` specifiers cannot be resolved by Rollup.
 */
declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (workerId: string, label: string) => Worker;
    };
  }
}

const workerUrls = import.meta.glob('/node_modules/monaco-editor/esm/vs/**/*.worker.js', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function workerUrlFor(label: string): string | undefined {
  if (label === 'json') return workerUrls['/node_modules/monaco-editor/esm/vs/language/json/json.worker.js'];
  if (label === 'css' || label === 'scss' || label === 'less') return workerUrls['/node_modules/monaco-editor/esm/vs/language/css/css.worker.js'];
  if (label === 'html' || label === 'handlebars' || label === 'razor') return workerUrls['/node_modules/monaco-editor/esm/vs/language/html/html.worker.js'];
  if (label === 'typescript' || label === 'javascript') return workerUrls['/node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js'];
  return workerUrls['/node_modules/monaco-editor/esm/vs/editor/editor.worker.js'];
}

window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    const url = workerUrlFor(label);
    if (!url) return new Worker('');
    return new Worker(url, { type: 'module' });
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
