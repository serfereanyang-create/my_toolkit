import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

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
