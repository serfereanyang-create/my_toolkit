const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const chokidar = require('chokidar');
const { Cron } = require('croner');

// Internal event bus for automation ↔ agentManager signaling.
// Using a dedicated EventEmitter avoids coupling to mainWindow's lifecycle:
// if the window is closed and recreated the listener on the old BrowserWindow
// would be silently lost (Bug-12 fix).
const automationBus = new EventEmitter();
automationBus.setMaxListeners(20);

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[A-Za-z0-9_.-]+$/;
const TRIGGER_TYPES = new Set(['cron', 'file_watch', 'git_event', 'manual']);
const FILE_EVENTS = new Set(['create', 'modify', 'delete']);
const GIT_EVENTS = new Set(['commit', 'push', 'pull']);

function createAutomationService({ workspace, agentManager, mainWindow }) {
  const active = new Map();
  const pendingRuns = new Map();
  const running = new Set();
  let root = '';

  function ensureRoot() {
    if (!root) throw new Error('No workspace open');
    return root;
  }

  function automationDir() {
    return path.join(ensureRoot(), '.aicode', 'automation');
  }

  function tasksFile() {
    return path.join(automationDir(), 'tasks.json');
  }

  function historyFile(taskId) {
    assertTaskId(taskId);
    return path.join(automationDir(), 'history', `${taskId}.json`);
  }

  async function readTasks() {
    try {
      const parsed = JSON.parse(await fs.readFile(tasksFile(), 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function writeTasks(tasks) {
    await fs.mkdir(automationDir(), { recursive: true });
    await fs.writeFile(tasksFile(), `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
    emitChanged();
  }

  async function saveTask(task) {
    const tasks = await readTasks();
    const index = tasks.findIndex((item) => item.id === task.id);
    if (index >= 0) tasks[index] = task;
    else tasks.push(task);
    await writeTasks(tasks);
    return task;
  }

  async function getTask(taskId) {
    assertTaskId(taskId);
    return (await readTasks()).find((item) => item.id === taskId) || null;
  }

  async function requireTask(taskId) {
    const task = await getTask(taskId);
    if (!task) throw new Error('Automation task not found');
    return task;
  }

  async function createTask(input) {
    const now = new Date().toISOString();
    const task = normalizeTask({
      id: `auto_${randomUUID().slice(0, 8)}`,
      name: input && input.name,
      description: input && input.description,
      enabled: false,
      trigger: input && input.trigger,
      action: input && input.action,
      createdAt: now,
      updatedAt: now,
      consecutiveFailures: 0,
    });
    return await saveTask(task);
  }

  async function updateTask(taskId, updates) {
    const task = await requireTask(taskId);
    const wasEnabled = task.enabled;
    if (wasEnabled) await deactivate(taskId);
    const next = normalizeTask({
      ...task,
      ...(updates || {}),
      id: task.id,
      enabled: wasEnabled,
      createdAt: task.createdAt,
      updatedAt: new Date().toISOString(),
    });
    await saveTask(next);
    if (wasEnabled) await activate(next);
    return next;
  }

  async function deleteTask(taskId) {
    await deactivate(taskId);
    const tasks = await readTasks();
    const next = tasks.filter((item) => item.id !== taskId);
    if (next.length === tasks.length) return false;
    await writeTasks(next);
    await fs.rm(historyFile(taskId), { force: true });
    return true;
  }

  async function startTask(taskId) {
    const task = await requireTask(taskId);
    task.enabled = true;
    task.updatedAt = new Date().toISOString();
    await saveTask(task);
    await activate(task);
    return task;
  }

  async function stopTask(taskId) {
    const task = await requireTask(taskId);
    await deactivate(taskId);
    task.enabled = false;
    task.updatedAt = new Date().toISOString();
    await saveTask(task);
    return task;
  }

  async function runTask(taskId, reason = { type: 'manual' }) {
    const task = await requireTask(taskId);
    if (running.has(taskId)) return { ok: false, status: 'busy', taskId };
    running.add(taskId);
    const startedAt = new Date().toISOString();

    // Avoid the "async executor" anti-pattern: unhandled throws inside an async
    // executor are swallowed by the Promise constructor and never reject the
    // outer promise.  Instead wrap in a plain Promise and forward via callbacks.
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRuns.delete(taskId);
        finishRun(taskId, 'failed', 'Automation timed out', startedAt, reason)
          .then(resolve, reject);
      }, 60 * 60 * 1000);
      if (typeof timeout.unref === 'function') timeout.unref();
      pendingRuns.set(taskId, { resolve, timeout, startedAt, reason });

      agentManager.automationTask(taskId, task.action.goal).catch((error) => {
        clearTimeout(timeout);
        pendingRuns.delete(taskId);
        finishRun(taskId, 'failed', errorMessage(error), startedAt, reason)
          .then(resolve, reject);
      });
    });
  }

  async function finishRun(taskId, status, reason, startedAt, trigger) {
    running.delete(taskId);
    const task = await getTask(taskId);
    const finishedAt = new Date().toISOString();
    const normalizedStatus = status === 'ok' ? 'success' : status === 'busy' ? 'blocked' : 'failed';
    const result = { taskId, status: normalizedStatus, reason: reason || undefined, startedAt, finishedAt, trigger };
    await appendHistory(taskId, result);

    if (task) {
      const previousFailures = Number(task.consecutiveFailures) || 0;
      task.lastRunAt = finishedAt;
      task.lastRunStatus = normalizedStatus;
      task.lastRunError = result.reason;
      task.consecutiveFailures = normalizedStatus === 'success' ? 0 : previousFailures + 1;
      if (task.consecutiveFailures >= 3) {
        task.enabled = false;
        await deactivate(taskId);
      }
      task.updatedAt = finishedAt;
      await saveTask(task);
    }
    return { ok: normalizedStatus === 'success', ...result };
  }

  async function appendHistory(taskId, result) {
    const file = historyFile(taskId);
    let history = [];
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      history = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    history.push(result);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(history.slice(-100), null, 2)}\n`, 'utf8');
  }

  async function getHistory(taskId, limit = 20) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    try {
      const parsed = JSON.parse(await fs.readFile(historyFile(taskId), 'utf8'));
      return (Array.isArray(parsed) ? parsed : []).slice(-safeLimit).reverse();
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function activate(task) {
    await deactivate(task.id);
    if (!task.enabled || task.trigger.type === 'manual') return;

    if (task.trigger.type === 'cron') {
      const job = new Cron(task.trigger.expression, { protect: true }, () => {
        void runTask(task.id, { type: 'cron', expression: task.trigger.expression });
      });
      active.set(task.id, { type: 'cron', dispose: () => job.stop() });
      return;
    }

    if (task.trigger.type === 'file_watch') {
      const eventMap = { add: 'create', change: 'modify', unlink: 'delete' };
      const watcher = chokidar.watch(task.trigger.patterns, {
        cwd: ensureRoot(),
        ignoreInitial: true,
        ignored: ['**/node_modules/**', '**/.git/**', '**/.aicode/**', '**/dist/**', '**/build/**'],
      });
      let timer;
      const changed = new Set();
      watcher.on('all', (event, filePath) => {
        const mapped = eventMap[event];
        if (!mapped || !task.trigger.events.includes(mapped)) return;
        changed.add(String(filePath).replace(/\\/g, '/'));
        clearTimeout(timer);
        timer = setTimeout(() => {
          const files = [...changed];
          changed.clear();
          void runTask(task.id, { type: 'file_watch', event: mapped, files });
        }, task.trigger.debounceMs);
      });
      active.set(task.id, {
        type: 'file_watch',
        dispose: async () => {
          clearTimeout(timer);
          await watcher.close();
        },
      });
      return;
    }

    if (task.trigger.type === 'git_event') {
      const state = await gitState(ensureRoot());
      const interval = setInterval(async () => {
        try {
          const next = await gitState(ensureRoot());
          if (task.trigger.branches.length > 0 && !task.trigger.branches.includes(next.branch)) {
            Object.assign(state, next);
            return;
          }
          const event = classifyGitEvent(state, next, task.trigger.events);
          Object.assign(state, next);
          if (event) void runTask(task.id, { type: 'git_event', event, branch: next.branch, head: next.head });
        } catch {
          // A transient git/network error should not disable the monitor.
        }
      }, task.trigger.pollIntervalMs);
      if (typeof interval.unref === 'function') interval.unref();
      active.set(task.id, { type: 'git_event', dispose: () => clearInterval(interval) });
    }
  }

  async function deactivate(taskId) {
    const entry = active.get(taskId);
    if (!entry) return;
    active.delete(taskId);
    await entry.dispose();
  }

  async function setWorkspace(nextRoot) {
    await disposeAll();
    root = path.resolve(nextRoot);
    const tasks = await readTasks();
    for (const task of tasks) {
      if (!task.enabled) continue;
      try {
        await activate(normalizeTask(task));
      } catch (error) {
        task.enabled = false;
        task.lastRunStatus = 'failed';
        task.lastRunError = errorMessage(error);
        task.updatedAt = new Date().toISOString();
        await saveTask(task);
      }
    }
  }

  async function disposeAll() {
    const ids = [...active.keys()];
    for (const id of ids) await deactivate(id);
    for (const [taskId, pending] of pendingRuns) {
      clearTimeout(pending.timeout);
      pending.resolve({
        ok: false,
        taskId,
        status: 'blocked',
        reason: 'Automation stopped because the workspace changed or the app closed',
        startedAt: pending.startedAt,
        finishedAt: new Date().toISOString(),
        trigger: pending.reason,
      });
    }
    pendingRuns.clear();
    running.clear();
  }

  // Bug-12 fix: use the module-level automationBus EventEmitter instead of
  // mainWindow.on().  mainWindow is a BrowserWindow — if it is destroyed and
  // recreated the listener registered here would be silently orphaned.
  automationBus.on('automation.done', (event) => {
    const pending = pendingRuns.get(event.taskId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingRuns.delete(event.taskId);
    void finishRun(event.taskId, event.status, event.reason, pending.startedAt, pending.reason).then(pending.resolve);
  });

  function emitChanged() {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('automation.changed');
  }

  return {
    setWorkspace,
    list: readTasks,
    get: getTask,
    create: createTask,
    update: updateTask,
    delete: deleteTask,
    start: startTask,
    stop: stopTask,
    run: runTask,
    history: getHistory,
    active: () => [...active.entries()].map(([id, entry]) => ({ id, type: entry.type })),
    disposeAll,
  };
}

function normalizeTask(input) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Automation name is required');
  const trigger = normalizeTrigger(input.trigger);
  const goal = String(input.action && input.action.goal || '').trim();
  if (!goal) throw new Error('Automation goal is required');
  return {
    id: String(input.id),
    name: name.slice(0, 120),
    description: String(input.description || '').slice(0, 500),
    enabled: Boolean(input.enabled),
    trigger,
    action: { type: 'task_board', goal: goal.slice(0, 8000), confirmPlan: true },
    lastRunAt: input.lastRunAt,
    lastRunStatus: input.lastRunStatus,
    lastRunError: input.lastRunError,
    consecutiveFailures: Math.max(0, Number(input.consecutiveFailures) || 0),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function normalizeTrigger(trigger) {
  if (!trigger || !TRIGGER_TYPES.has(trigger.type)) throw new Error('Invalid automation trigger');
  if (trigger.type === 'cron') {
    const expression = String(trigger.expression || '').trim();
    if (expression.split(/\s+/).length !== 5) throw new Error('Cron expression must have five fields');
    new Cron(expression, { paused: true });
    return { type: 'cron', expression };
  }
  if (trigger.type === 'file_watch') {
    const patterns = (Array.isArray(trigger.patterns) ? trigger.patterns : []).map(String).map((item) => item.trim()).filter(Boolean).slice(0, 20);
    if (patterns.length === 0) throw new Error('At least one file pattern is required');
    if (patterns.some((item) => path.isAbsolute(item) || item.split(/[\\/]/).includes('..'))) throw new Error('File patterns must stay inside the workspace');
    const events = (Array.isArray(trigger.events) ? trigger.events : []).filter((item) => FILE_EVENTS.has(item));
    if (events.length === 0) throw new Error('At least one file event is required');
    return { type: 'file_watch', patterns, events: [...new Set(events)], debounceMs: Math.max(100, Math.min(60000, Number(trigger.debounceMs) || 1000)) };
  }
  if (trigger.type === 'git_event') {
    const events = (Array.isArray(trigger.events) ? trigger.events : []).filter((item) => GIT_EVENTS.has(item));
    if (events.length === 0) throw new Error('At least one Git event is required');
    const branches = (Array.isArray(trigger.branches) ? trigger.branches : []).map(String).map((item) => item.trim()).filter((item) => /^[A-Za-z0-9._/-]+$/.test(item)).slice(0, 20);
    return { type: 'git_event', events: [...new Set(events)], branches, pollIntervalMs: Math.max(5000, Math.min(300000, Number(trigger.pollIntervalMs) || 30000)) };
  }
  return { type: 'manual' };
}

async function gitState(root) {
  const branch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })).stdout.trim();
  const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  let remote = '';
  try {
    remote = (await execFileAsync('git', ['rev-parse', `origin/${branch}`], { cwd: root })).stdout.trim();
  } catch {
    remote = '';
  }
  return { branch, head, remote };
}

function classifyGitEvent(previous, next, watchedEvents) {
  const events = new Set(watchedEvents);
  if (events.has('pull') && previous.head && previous.remote && next.head === next.remote && next.head !== previous.head && next.remote !== previous.remote) {
    return 'pull';
  }
  if (events.has('push') && previous.head && previous.remote && next.head === next.remote && next.head === previous.head && next.remote !== previous.remote) {
    return 'push';
  }
  if (events.has('commit') && previous.head && next.head !== previous.head) {
    return 'commit';
  }
  return undefined;
}

async function requireTaskFromList(tasks, taskId) {
  assertTaskId(taskId);
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw new Error('Automation task not found');
  return task;
}

function assertTaskId(taskId) {
  if (!SAFE_ID.test(String(taskId))) throw new Error('Invalid automation task id');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = { createAutomationService, normalizeTask, normalizeTrigger, classifyGitEvent, automationBus };
