const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { apiKeyEnvVar } = require('./provider-map.cjs');

/** Must match the CLI's --delegation values (cli/src/cli/args.ts). */
const DELEGATION_LEVELS = new Set(['off', 'balanced', 'eager']);

class AgentBridge extends EventEmitter {
  constructor(options) {
    super();
    this.cliRoot = options.cliRoot;
    this.workspaceRoot = options.workspaceRoot;
    this.sessionDir = options.sessionDir;
    this.provider = options.provider;
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.approval = options.approval || 'ask';
    this.resumeSessionId = options.resumeSessionId || null;
    this.sessionId = this.resumeSessionId;
    this.reasoningEffort = options.reasoningEffort || 'auto';
    this.customProvider = options.customProvider === true;
    this.computerAnyApp = options.computerAnyApp === true;
    this.allowedApps = Array.isArray(options.allowedApps) ? options.allowedApps : [];
    this.excelAutomation = options.excelAutomation === true;
    // --background-browser-only implies --background-browser in the CLI too.
    this.backgroundBrowserOnly = options.backgroundBrowserOnly === true;
    this.backgroundBrowser = options.backgroundBrowser === true || this.backgroundBrowserOnly;
    this.toolScope = options.toolScope || 'auto';
    this.confirmPlan = options.confirmPlan === true;
    this.autoReview = options.autoReview === true;
    this.delegation = DELEGATION_LEVELS.has(options.delegation) ? options.delegation : undefined;
    this.contextWindowTokens = Number.isFinite(options.contextWindowTokens) && options.contextWindowTokens > 0
      ? Math.floor(options.contextWindowTokens)
      : undefined;
    this.spawnProcess = options.spawnProcess || spawn;
    this.killProcessTree = options.killTree || killTree;
    this.child = null;
    this.buffer = '';
    this.generation = 0;
    this.readyGeneration = 0;
    this.ready = false;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.readyTimer = null;
    // Detached children are still owned until they actually exit. Clearing
    // `child` on cancel must not make dispose()/restart() forget a live process.
    this.processes = new Map();
    this.taskBoard = null;
    this.requestTimeoutMs = Number.isSafeInteger(options.requestTimeoutMs) && options.requestTimeoutMs > 0 && options.requestTimeoutMs <= 2_147_483_647 ? options.requestTimeoutMs : 300_000;
    this.interruptTimeoutMs = Number.isSafeInteger(options.interruptTimeoutMs) && options.interruptTimeoutMs > 0 ? options.interruptTimeoutMs : 2000;
  }

  async waitForExit(child, timeoutMs = 1500) {
    const record = this.processes.get(child);
    if (!child || record?.exited || (child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) return true;
    // Manually assigned test/legacy bridges have no OS process to wait on.
    if (!child.pid) return true;
    return await new Promise((resolve) => {
      let timer;
      const done = () => finish(true);
      const finish = (exited) => {
        clearTimeout(timer);
        child.removeListener?.('exit', done);
        child.removeListener?.('close', done);
        resolve(exited);
      };
      child.once?.('exit', done);
      child.once?.('close', done);
      timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  setResumeSessionId(resumeSessionId) {
    this.resumeSessionId = resumeSessionId || null;
  }

  isRunning() { return this.processes.get(this.child)?.turnActive === true; }

  /** Build only flags implemented by the CLI; preferences never become raw argv. */
  buildArgs() {
    const args = [
      path.join(this.cliRoot, 'dist', 'src', 'index.js'),
      '--desktop-bridge',
      '--provider', this.provider,
      '--model', this.model,
      '--approval', this.approval,
      '--workspace', this.workspaceRoot,
      '--session-dir', this.sessionDir,
    ];
    if (this.baseUrl) args.push('--base-url', this.baseUrl);
    args.push('--request-timeout-ms', String(this.requestTimeoutMs));
    if (this.customProvider) args.push('--custom-provider');
    if (this.computerAnyApp) args.push('--computer-any-app');
    if (this.allowedApps.length > 0) args.push('--allowed-apps', this.allowedApps.join(','));
    if (this.excelAutomation) args.push('--excel');
    if (this.backgroundBrowser) args.push('--background-browser');
    if (this.backgroundBrowserOnly) args.push('--background-browser-only');
    if (this.resumeSessionId) args.push('--resume', this.resumeSessionId);
    if (this.reasoningEffort && this.reasoningEffort !== 'off') args.push('--reasoning-effort', this.reasoningEffort);
    if (this.toolScope) args.push('--tool-scope', this.toolScope);
    if (this.confirmPlan) args.push('--confirm-plan');
    if (this.autoReview) args.push('--auto-review');
    if (this.delegation) args.push('--delegation', this.delegation);
    return args;
  }

  start() {
    if (this.child) return this.readyPromise || Promise.resolve({ sessionId: this.sessionId });
    const stopping = [...this.processes.values()].filter((record) => !record.exited);
    if (stopping.length) {
      return Promise.all(stopping.map((record) => this.stopChild(record.child, false))).then(() => this.start());
    }
    const generation = ++this.generation;
    this.taskBoard = null;
    this.buffer = '';
    this.sessionId = this.resumeSessionId;
    this.readyGeneration = generation;
    this.ready = false;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Fire-and-forget callers must not create an unhandled start rejection.
    this.readyPromise.catch(() => {});
    this.readyTimer = setTimeout(() => {
      if (this.generation !== generation || this.readyGeneration !== generation || this.ready) return;
      const error = new Error('Timed out waiting for agent bridge_ready');
      const child = this.child;
      this.detach(child, error);
      this.emit('event', { type: 'error', message: error.message });
      const record = this.processes.get(child);
      if (record) this.emitOffline(record, -1);
      if (child) void this.stopChild(child, false).catch(() => {});
    }, 15000);
    this.readyTimer.unref?.();

    const env = { ...process.env };
    // In a packaged app process.execPath is Electron; this prevents a second GUI.
    env.ELECTRON_RUN_AS_NODE = '1';
    const envVar = apiKeyEnvVar(this.provider);
    if (envVar && this.apiKey) env[envVar] = this.apiKey;
    delete env.AICODE_CONTEXT_WINDOW;
    if (this.contextWindowTokens) env.AICODE_CONTEXT_WINDOW = String(this.contextWindowTokens);

    let child;
    try {
      child = this.spawnProcess(process.execPath, this.buildArgs(), {
        cwd: this.cliRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.generation += 1;
      this.rejectReady(generation, error);
      this.emit('event', { type: 'error', message: redact(error.message) });
      this.emit('event', { type: 'agent_offline', code: -1, ...(this.sessionId ? { sessionId: this.sessionId } : {}) });
      throw error;
    }
    this.attach(child, generation);
    return this.readyPromise;
  }

  /** Stale turn output is dropped, but exit always closes the original session. */
  attach(child, generation = ++this.generation) {
    this.child = child;
    const record = { child, generation, sessionId: this.resumeSessionId, exited: false, offline: false, stopping: false, stopPromise: null };
    this.processes.set(child, record);
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (chunk) => this.handleStdout(chunk, generation, child));
    child.stderr.setEncoding?.('utf8');
    child.stderr.on('data', (chunk) => {
      if (generation !== this.generation || this.child !== child) return;
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (line.includes('ExperimentalWarning') || (line.includes('(node:') && line.includes('Warning:'))) continue;
        if (line.includes('--trace-warnings')) continue;
        this.emit('event', { type: 'error', message: redact(line) });
      }
    });
    child.once('error', (error) => {
      if (generation !== this.generation || this.child !== child) return;
      this.detach(child, error);
      this.emit('event', { type: 'error', message: redact(error.message) });
      this.emitOffline(record, -1);
      // A failed spawn has no pid/exit; a running process reporting an error
      // is still owned and must be terminated rather than silently forgotten.
      if (!child.pid) this.finishChild(record, -1);
      else void this.stopChild(child, false).catch(() => {});
    });
    child.once('exit', (code) => this.finishChild(record, code));
    child.once('close', (code) => this.finishChild(record, code));
  }

  detach(child, error) {
    if (!child || this.child !== child) return;
    const generation = this.generation;
    this.generation += 1;
    this.child = null;
    this.ready = false;
    this.buffer = '';
    this.rejectReady(generation, error);
  }

  emitOffline(record, code) {
    if (record.offline) return;
    record.offline = true;
    this.emit('event', {
      type: 'agent_offline', code,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(record.stopping || record.interrupting ? { expected: true } : {}),
    });
  }

  finishChild(record, code) {
    if (record.exited) return;
    record.exited = true;
    if (record.generation === this.generation && this.child === record.child) {
      this.flushStdoutBuffer(record.child);
      this.detach(record.child, new Error(`Agent bridge exited before bridge_ready (code ${code ?? 'unknown'})`));
    }
    this.processes.delete(record.child);
    // Intentionally detached children still report offline for THEIR session,
    // never for a replacement child. cancel() has already emitted it once.
    this.emitOffline(record, code);
  }

  async waitUntilReady() {
    const child = this.child;
    const generation = this.generation;
    if (!child) throw new Error('Agent bridge is not running');
    if (!this.ready && this.readyPromise) await this.readyPromise;
    if (this.child !== child || this.generation !== generation || (this.readyPromise && !this.ready)) {
      throw new Error('Agent bridge is not ready');
    }
  }

  send(command) {
    if (!this.child || !this.child.stdin.writable) throw new Error('Agent bridge is not running');
    if (['user_message', 'task_board_action', 'automation_task'].includes(command.type)) {
      const record = this.processes.get(this.child);
      if (record) { record.turnActive = true; record.suppressOutput = false; }
    }
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async prompt(text, files, toolScope) {
    await this.waitUntilReady();
    const command = { type: 'user_message', text };
    if (this.reasoningEffort) command.reasoningEffort = this.reasoningEffort;
    if (toolScope || this.toolScope) command.toolScope = toolScope || this.toolScope;
    if (files && files.length > 0) command.files = files;
    this.send(command);
  }

  async taskBoardAction(action, taskId) {
    await this.waitUntilReady();
    this.send({ type: 'task_board_action', action, taskId });
  }

  async automationTask(taskId, goal) {
    await this.waitUntilReady();
    this.send({ type: 'automation_task', taskId, goal });
  }

  setEffort(reasoningEffort) {
    this.reasoningEffort = reasoningEffort;
    if (this.child && this.ready && this.child.stdin.writable) this.send({ type: 'set_effort', reasoningEffort });
  }

  setToolScope(toolScope) {
    this.toolScope = toolScope;
    if (this.child && this.ready && this.child.stdin.writable) this.send({ type: 'set_tool_scope', toolScope });
  }

  async approve(requestId, decision) {
    await this.waitUntilReady();
    this.send({ type: 'approval_response', requestId, decision });
  }

  async guardConfirmation(requestId, selectedLabel) {
    await this.waitUntilReady();
    this.send({ type: 'guard_confirmation_response', requestId, selectedLabel });
  }

  async sendHostToolResponse(requestId, result) {
    await this.waitUntilReady();
    this.send({ type: 'host_tool_response', requestId, result });
  }

  async undo(checkpointIds, undoId) {
    await this.waitUntilReady();
    this.send({ type: 'undo', undoId: undoId ?? `undo_${Date.now()}`, checkpointIds: Array.isArray(checkpointIds) ? checkpointIds : [] });
  }

  clearReadyWait(generation) {
    if (generation !== undefined && generation !== this.readyGeneration) return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  resolveReady(generation) {
    if (generation !== this.readyGeneration || this.ready) return;
    this.clearReadyWait(generation);
    this.ready = true;
    const resolve = this.readyResolve;
    this.readyResolve = null;
    this.readyReject = null;
    if (resolve) resolve({ sessionId: this.sessionId });
  }

  rejectReady(generation, error) {
    if (generation !== this.readyGeneration) return;
    this.clearReadyWait(generation);
    const reject = this.readyReject;
    this.readyResolve = null;
    this.readyReject = null;
    if (reject) reject(error);
  }

  interrupt() {
    const child = this.child;
    if (!child) {
      const owned = [...this.processes.values()].filter(record => !record.exited);
      return owned.length ? Promise.all(owned.map(record => this.stopChild(record.child, false))).then(() => ({ mode: 'terminated' })) : Promise.resolve({ mode: 'idle' });
    }
    const record = this.processes.get(child) || this.manualRecord(child);
    if (!this.ready) return this.cancel().then(() => ({ mode: 'terminated' }));
    if (!record.turnActive) return Promise.resolve({ mode: 'idle' });
    if (record.interruptPromise) return record.interruptPromise;
    record.interrupting = true;
    record.suppressOutput = true;
    record.interruptPromise = new Promise((resolve, reject) => {
      let forced = false;
      const cleanup = () => { clearTimeout(timer); this.removeListener('event', onEvent); child.removeListener?.('exit', onExit); child.removeListener?.('close', onExit); };
      const finish = result => { cleanup(); resolve(result); };
      const onExit = () => { if (!forced) finish({ mode: 'terminated' }); };
      const onEvent = event => {
        if (forced || child !== this.child || record.generation !== this.generation) return;
        if (event.type === 'turn_done') finish({ mode: 'cooperative' });
        else if (event.type === 'agent_offline') finish({ mode: 'terminated' });
      };
      const force = () => {
        if (forced) return;
        forced = true;
        cleanup();
        this.stopChild(child, false).then(() => {
          this.emit('event', { type: 'turn_done', status: 'cancelled', ...(this.sessionId ? { sessionId: this.sessionId } : {}) });
          finish({ mode: 'terminated' });
        }, error => { cleanup(); reject(error); });
      };
      const timer = setTimeout(force, this.interruptTimeoutMs);
      this.on('event', onEvent);
      child.once?.('exit', onExit);
      child.once?.('close', onExit);
      try { this.send({ type: 'cancel', ...(this.sessionId ? { sessionId: this.sessionId } : {}) }); }
      catch { force(); }
    }).finally(() => { record.interrupting = false; record.interruptPromise = null; });
    return record.interruptPromise;
  }

  /** Detach synchronously, terminate asynchronously; never lose ownership. */
  cancel() {
    const child = this.child;
    if (!child) return Promise.all([...this.processes.values()].map((record) => this.stopChild(record.child, false)));
    const record = this.processes.get(child) || this.manualRecord(child);
    record.stopping = true;
    this.detach(child, new Error('Agent bridge cancelled'));
    if (record.turnActive) this.emit('event', { type: 'turn_done', status: 'cancelled' });
    record.turnActive = false;
    this.emitOffline(record, -1);
    const stopping = this.stopChild(child, false);
    stopping.catch(() => {});
    return stopping;
  }

  async restart(resumeSessionId) {
    this.setResumeSessionId(resumeSessionId === undefined ? this.sessionId : resumeSessionId);
    await this.cancel();
    await this.dispose();
    return this.start();
  }

  manualRecord(child) {
    const record = { child, generation: this.generation, sessionId: this.sessionId, exited: false, offline: false, stopping: false, stopPromise: null };
    this.processes.set(child, record);
    return record;
  }

  stopChild(child, graceful) {
    const record = this.processes.get(child) || this.manualRecord(child);
    if (record.exited) return Promise.resolve();
    if (record.stopPromise) return record.stopPromise;
    record.stopping = true;
    this.detach(child, new Error('Agent bridge disposed'));
    record.stopPromise = (async () => {
      let killTimer;
      try {
        if (graceful) {
          try {
            if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
          } catch { /* stdin closed; the hard-kill fallback still runs. */ }
          killTimer = setTimeout(() => this.killProcessTree(child), 1000);
        } else {
          this.killProcessTree(child);
        }
        let exited = await this.waitForExit(child);
        if (!exited) {
          this.killProcessTree(child);
          exited = await this.waitForExit(child);
        }
        if (!exited) throw new Error(`Agent child ${child.pid} did not exit after termination`);
        this.finishChild(record, child.exitCode ?? -1);
      } finally {
        clearTimeout(killTimer);
        // A failed kill is retryable; do not permit a fresh start until it exits.
        record.stopPromise = null;
      }
    })();
    record.stopPromise.catch(() => {});
    return record.stopPromise;
  }

  async dispose() {
    if (this.child && !this.processes.has(this.child)) this.manualRecord(this.child);
    // Teardown waits for every owned child, but a child that refuses to die is
    // not an error a caller can act on — the process is exiting, or the next
    // start() must be the one to insist. It is not forgotten either: the record
    // stays in `processes`, so start() still refuses to spawn over it.
    await Promise.all([...this.processes.values()].map((record) =>
      this.stopChild(record.child, true).catch(() => undefined)));
  }

  emitCliEvent(event, generation, child) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
    if (event.type === 'task_board_updated') this.taskBoard = event;
    const current = this.processes.get(child);
    if (current) {
      if (event.type === 'turn_start') current.turnActive = true;
      if (event.type === 'turn_done') current.turnActive = false;
      if (current.suppressOutput && ['assistant_delta', 'assistant_message', 'thinking_delta', 'tool_start'].includes(event.type)) return;
    }
    if (event.type === 'bridge_ready') {
      const record = this.processes.get(child);
      this.sessionId = event.sessionId || this.resumeSessionId;
      if (record) record.sessionId = this.sessionId;
      this.resolveReady(generation);
    }
    this.emit('event', event);
    if (event.type === 'host_tool_request') this.emit('host_tool_request', event);
    if (event.type === 'host_tool_cancel') this.emit('host_tool_cancel', event);
  }

  handleStdout(chunk, generation = this.generation, child = this.child) {
    if (generation !== this.generation || child !== this.child) return;
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (generation !== this.generation || child !== this.child) break;
      if (!line.trim()) continue;
      let event;
      try { event = normalizeCliEvent(JSON.parse(line)); } catch { continue; }
      // Listener failures are not JSON/protocol errors and must not be swallowed.
      this.emitCliEvent(event, generation, child);
    }
  }

  /** Parse a complete JSON event that never received its newline before exit. */
  flushStdoutBuffer(child = this.child) {
    const rest = this.buffer;
    this.buffer = '';
    if (!rest.trim()) return;
    let event;
    try { event = normalizeCliEvent(JSON.parse(rest)); } catch { return; }
    this.emitCliEvent(event, this.generation, child);
  }
}

/** Terminate CLI-spawned shell grandchildren too (especially on Windows). */
function killTree(child) {
  if (!child.pid) {
    child.kill?.();
    return;
  }
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => child.kill?.());
      return;
    } catch { /* taskkill unavailable: fall through. */ }
  }
  child.kill?.();
}

function normalizeCliEvent(event) {
  if (event.type === 'assistant') {
    const { content, text, ...rest } = event;
    return { ...rest, type: 'assistant_message', text: content || text || '' };
  }
  if (event.type === 'assistant_delta') {
    const { content, text, ...rest } = event;
    return { ...rest, type: 'assistant_delta', text: content || text || '' };
  }
  return event;
}

function redact(value) {
  return String(value).replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1***');
}

module.exports = { AgentBridge, normalizeCliEvent, redact };
