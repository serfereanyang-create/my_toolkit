import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const mockApi = String.raw`
(() => {
  let tasks = [];
  const listeners = new Set();
  const changed = () => listeners.forEach((listener) => listener());
  const now = () => new Date().toISOString();
  const settings = {
    activeProviderId: 'mock',
    approval: 'auto',
    recentWorkspaces: ['C:\\GUI-Test'],
    preferences: { theme: 'dark', reasoningEffort: 'off', toolScope: 'auto' },
    providers: [{ id: 'mock', type: 'mock', label: 'Mock', model: 'mock-code-agent-v1', baseUrl: '' }],
  };
  window.zcodeDesktop = {
    workspace: {
      open: async () => ({ canceled: true }),
      setRoot: async (root) => ({ root }),
      restore: async () => ({ root: 'C:\\GUI-Test', restored: true }),
      getTree: async () => [],
    },
    fs: { read: async () => '', write: async (path) => ({ ok: true, path }) },
    settings: { get: async () => settings, set: async (next) => Object.assign(settings, next) },
    secrets: {
      setApiKey: async () => ({ configured: true, hint: 'mock' }),
      hasApiKey: async () => ({ configured: true, hint: 'mock' }),
    },
    connectivity: { test: async () => ({ ok: true, message: 'ok' }) },
    usage: {
      summary: async (days) => ({ days, daily: [], models: [], totals: { tokens: 0, rounds: 0 } }),
      cachePrediction: async () => ({ predicted: null, samples: 0, model: null, windowDays: 30 }),
    },
    sessions: {
      list: async () => [], listArchived: async () => [], load: async () => ({}),
      delete: async (id) => ({ ok: true, id }), rename: async (id, title) => ({ ok: true, id, title }),
      pin: async (id, pinned) => ({ ok: true, id, pinned }), archive: async (id, archived) => ({ ok: true, id, archived }),
      reveal: async () => ({ ok: true }),
    },
    automation: {
      list: async () => tasks,
      get: async (id) => tasks.find((task) => task.id === id) ?? null,
      create: async (input) => {
        const stamp = now();
        const task = { ...input, id: 'auto_gui_' + (tasks.length + 1), enabled: false, consecutiveFailures: 0, createdAt: stamp, updatedAt: stamp };
        tasks = [...tasks, task];
        changed();
        return task;
      },
      update: async (id, updates) => {
        let saved;
        tasks = tasks.map((task) => task.id === id ? (saved = { ...task, ...updates, id, updatedAt: now() }) : task);
        changed();
        return saved;
      },
      delete: async (id) => { const before = tasks.length; tasks = tasks.filter((task) => task.id !== id); changed(); return tasks.length !== before; },
      start: async (id) => { const task = tasks.find((item) => item.id === id); if (task) task.enabled = true; changed(); return task; },
      stop: async (id) => { const task = tasks.find((item) => item.id === id); if (task) task.enabled = false; changed(); return task; },
      run: async (id) => ({ ok: true, status: 'success', taskId: id }),
      history: async () => [],
      active: async () => tasks.filter((task) => task.enabled && task.trigger.type !== 'manual').map((task) => ({ id: task.id, type: task.trigger.type })),
      onChanged: (handler) => { listeners.add(handler); return () => listeners.delete(handler); },
    },
    agent: {
      start: async () => ({ ok: true }), prompt: async () => ({ ok: true }), setEffort: async (reasoningEffort) => ({ ok: true, reasoningEffort }),
      setToolScope: async (toolScope) => ({ ok: true, toolScope }), cancel: async () => ({ ok: true }), restart: async () => ({ ok: true }),
      approve: async () => ({ ok: true }), undo: async () => ({ ok: true }), onEvent: () => () => {},
    },
    window: { minimize: async () => ({ ok: true }), toggleMaximize: async () => ({ ok: true, maximized: false }), close: async () => ({ ok: true }) },
    clipboard: { write: async () => ({ ok: true }) },
    terminal: { create: async () => ({ id: 't1', cwd: 'C:\\GUI-Test', shell: 'cmd' }), write: async () => ({ ok: true }), resize: async () => ({ ok: true }), kill: async () => ({ ok: true }), onEvent: () => () => {} },
  };
})();
`;

export default defineConfig({
  plugins: [
    {
      name: 'gui-test-preload',
      transformIndexHtml: {
        order: 'pre',
        handler() {
          return [{ tag: 'script', children: mockApi, injectTo: 'head-prepend' }];
        },
      },
    },
    react(),
  ],
  base: './',
  server: { host: '127.0.0.1', port: 5187, strictPort: true },
});
