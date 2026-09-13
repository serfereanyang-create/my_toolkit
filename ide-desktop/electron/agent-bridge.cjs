const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { apiKeyEnvVar } = require('./provider-map.cjs');

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
    // Provider-agnostic reasoning tier ('off'|'low'|'medium'|'high'|'max').
    // Passed at spawn as the initial value and updated live per prompt.
    this.reasoningEffort = options.reasoningEffort || 'auto';
    this.customProvider = options.customProvider === true;
    this.computerAnyApp = options.computerAnyApp === true;
    this.allowedApps = Array.isArray(options.allowedApps) ? options.allowedApps : [];
    this.excelAutomation = options.excelAutomation === true;
    this.toolScope = options.toolScope || 'auto';
    this.confirmPlan = options.confirmPlan === true;
    // Token size of the active model's context window. When known, the CLI's
    // pre-turn auto-compact (90% threshold) becomes active in this bridge via
    // AICODE_CONTEXT_WINDOW; undefined leaves compaction manual-only.
    this.contextWindowTokens = Number.isFinite(options.contextWindowTokens) && options.contextWindowTokens > 0
      ? Math.floor(options.contextWindowTokens)
      : undefined;
    this.child = null;
    this.buffer = '';
    // Every child process gets its own generation. A killed process can emit
    // `exit` after a replacement has already been spawned; stale callbacks must
    // never clear or report on the replacement child.
    this.generation = 0;
    this.readyGeneration = 0;
    this.ready = false;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.readyTimer = null;
  }

  start() {
    if (this.child) return this.readyPromise || Promise.resolve();
    const generation = ++this.generation;
    this.buffer = '';
    this.readyGeneration = generation;
    this.ready = false;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Callers that use the historical fire-and-forget start() API must not
    // create an unhandled rejection if the child fails before bridge_ready.
    this.readyPromise.catch(() => {});
    this.readyTimer = setTimeout(() => {
      if (this.generation !== generation || this.readyGeneration !== generation || this.ready) return;
      const error = new Error('Timed out waiting for agent bridge_ready');
      const child = this.child;
      this.child = null;
      this.generation += 1;
      this.rejectReady(generation, error);
      if (child && !child.killed) child.kill();
      this.emit('event', { type: 'error', message: error.message });
      this.emit('event', { type: 'agent_offline', code: -1 });
    }, 15000);
    if (typeof this.readyTimer.unref === 'function') this.readyTimer.unref();

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
    if (this.customProvider) args.push('--custom-provider');
    if (this.computerAnyApp) args.push('--computer-any-app');
    if (this.allowedApps.length > 0) args.push('--allowed-apps', this.allowedApps.join(','));
    if (this.excelAutomation) args.push('--excel');
    if (this.resumeSessionId) args.push('--resume', this.resumeSessionId);
    if (this.reasoningEffort && this.reasoningEffort !== 'off') args.push('--reasoning-effort', this.reasoningEffort);
    if (this.toolScope) args.push('--tool-scope', this.toolScope);
    if (this.confirmPlan) args.push('--confirm-plan');

    const env = { ...process.env };
    // When the desktop app is launched via the packaged shortcut, process.execPath
    // is the Electron binary, not node. Spawning it on the CLI entry would boot a
    // second GUI instance instead of running the script. ELECTRON_RUN_AS_NODE=1
    // makes that same binary behave as a plain Node runtime so the bridge child
    // runs the CLI and streams JSON events back. Harmless under `node` in tests.
    env.ELECTRON_RUN_AS_NODE = '1';
    // Bug-13 fix: use the shared apiKeyEnvVar() helper from provider-map instead
    // of duplicating the openai/anthropic conditional here.
    const envVar = apiKeyEnvVar(this.provider);
    if (envVar && this.apiKey) env[envVar] = this.apiKey;
    // The CLI reads AICODE_CONTEXT_WINDOW (autoCompact.resolveContextWindowTokens)
    // to arm pre-turn auto-compaction. Never inherit a stale value from the
    // parent env — the desktop setting is the single source of truth.
    delete env.AICODE_CONTEXT_WINDOW;
    if (this.contextWindowTokens) env.AICODE_CONTEXT_WINDOW = String(this.contextWindowTokens);

    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: this.cliRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.generation += 1;
      this.rejectReady(generation, error);
      throw error;
    }
    this.attach(child, generation);
    return this.readyPromise;
  }

  /**
   * Wire one child process into the bridge. Every handler closes over its own
   * child AND its generation, so once cancel()/dispose()/restart replaces the
   * child, all events from the stale process are dropped: the old bridge can
   * never mark a freshly started one offline or leak old turn output.
   */
  attach(child, generation = ++this.generation) {
    this.child = child;

    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (chunk) => this.handleStdout(chunk, generation, child));
    child.stderr.setEncoding?.('utf8');
    child.stderr.on('data', (chunk) => {
      // An old child may flush stderr after restart. Never surface stale errors
      // or let them affect the replacement bridge.
      if (generation !== this.generation || this.child !== child) return;
      const text = String(chunk);
      // Suppress Node.js ExperimentalWarning lines line-wise — they are
      // informational and must never surface as agent errors. Matching per
      // line keeps a real error that shares a chunk with a warning visible.
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        if (line.includes('ExperimentalWarning') || (line.includes('(node:') && line.includes('Warning:'))) continue;
        // The trailing explainer line Node/Electron prints after any warning
        // ("(Use `electron --trace-warnings ...` to show where the warning was
        // created)") is not an error either.
        if (line.includes('--trace-warnings')) continue;
        this.emit('event', { type: 'error', message: redact(line) });
      }
    });
    child.once('error', (error) => {
      if (generation !== this.generation || this.child !== child) return;
      this.child = null;
      this.generation += 1;
      this.clearReadyWait(generation);
      this.rejectReady(generation, error);
      this.emit('event', { type: 'error', message: redact(error.message) });
      this.emit('event', { type: 'agent_offline', code: -1 });
    });
    child.once('exit', (code) => {
      // The child that was cancelled/replaced is intentionally stale. Its exit
      // event must not null out or report offline for the current generation.
      if (generation !== this.generation || this.child !== child) return;
      // Flush a trailing event that never received its newline before death;
      // dropping it would silently lose e.g. the final turn_done.
      this.flushStdoutBuffer();
      this.child = null;
      this.generation += 1;
      this.clearReadyWait(generation);
      this.rejectReady(generation, new Error(`Agent bridge exited before bridge_ready (code ${code ?? 'unknown'})`));
      this.ready = false;
      this.emit('event', { type: 'agent_offline', code });
    });
  }

  async waitUntilReady() {
    if (!this.child) throw new Error('Agent bridge is not running');
    // Keep direct/manual AgentBridge users compatible: a child assigned without
    // start() has no readiness handshake to await and is already usable.
    if (this.ready || !this.readyPromise) return;
    await this.readyPromise;
    if (!this.child || !this.ready) throw new Error('Agent bridge is not ready');
  }

  send(command) {
    if (!this.child || !this.child.stdin.writable) throw new Error('Agent bridge is not running');
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async prompt(text, files, toolScope) {
    await this.waitUntilReady();
    // Carry the current effort tier with each message so the live change takes
    // effect on the very next turn without restarting the child.
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
    // Update the running child too (no-op if not started; start() will pass it).
    if (this.child && this.ready && this.child.stdin.writable) {
      this.send({ type: 'set_effort', reasoningEffort });
    }
  }

  setToolScope(toolScope) {
    this.toolScope = toolScope;
    if (this.child && this.ready && this.child.stdin.writable) {
      this.send({ type: 'set_tool_scope', toolScope });
    }
  }

  async approve(requestId, decision) {
    await this.waitUntilReady();
    this.send({ type: 'approval_response', requestId, decision });
  }

  // Revert one turn's file writes by their CLI checkpoint ids. The CLI replies
  // with an `undo_done` event carrying the same undoId so the renderer can
  // match the result back to the turn card that requested the undo.
  async undo(checkpointIds, undoId) {
    await this.waitUntilReady();
    this.send({
      type: 'undo',
      undoId: undoId ?? `undo_${Date.now()}`,
      checkpointIds: Array.isArray(checkpointIds) ? checkpointIds : [],
    });
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
    if (resolve) resolve();
  }

  rejectReady(generation, error) {
    if (generation !== this.readyGeneration) return;
    this.clearReadyWait(generation);
    const reject = this.readyReject;
    this.readyResolve = null;
    this.readyReject = null;
    if (reject) reject(error);
  }

  cancel() {
    const child = this.child;
    if (!child) return;
    // Invalidate this generation before killing the process. Windows may emit
    // `exit` after a replacement has spawned; its stale callback is ignored.
    const generation = this.generation;
    this.generation += 1;
    this.child = null;
    this.ready = false;
    this.rejectReady(generation, new Error('Agent bridge cancelled'));
    if (!child.killed) killTree(child);
    // Emit turn_done synchronously so the UI stops the spinner immediately,
    // then emit agent_offline so the next prompt correctly starts a new bridge.
    this.emit('event', { type: 'turn_done', status: 'cancelled' });
    this.emit('event', { type: 'agent_offline', code: -1 });
  }

  async restart() {
    this.cancel();
    return this.start();
  }

  dispose() {
    const child = this.child;
    if (!child) return;
    const generation = this.generation;
    this.generation += 1;
    this.child = null;
    this.ready = false;
    this.rejectReady(generation, new Error('Agent bridge disposed'));
    // Ask for a graceful shutdown, then guarantee termination. The CLI releases
    // its stdin on `shutdown`, but a hard-kill fallback avoids leaking a child
    // process if the graceful path stalls.
    try {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    } catch {
      // stdin already closed; fall through to kill.
    }
    const killTimer = setTimeout(() => {
      if (!child.killed) killTree(child);
    }, 1000);
    if (typeof killTimer.unref === 'function') killTimer.unref();
    child.once('exit', () => clearTimeout(killTimer));
  }

  handleStdout(chunk, generation = this.generation, child = this.child) {
    if (generation !== this.generation || child !== this.child) return;
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = normalizeCliEvent(JSON.parse(line));
        if (event.type === 'bridge_ready') this.resolveReady(generation);
        this.emit('event', event);
      } catch {
        // Not JSON: library chatter on stdout (tool progress logs like
        // "[GraphBuilder] ...", dependency warnings). The protocol handshake is
        // bridge_ready; a broken protocol surfaces as a start timeout, so
        // chatty lines must not become conversation errors.
      }
    }
  }

  /** Parse and emit any complete JSON line left in the buffer (child died). */
  flushStdoutBuffer() {
    const rest = this.buffer;
    this.buffer = '';
    if (!rest.trim()) return;
    try {
      this.emit('event', normalizeCliEvent(JSON.parse(rest)));
    } catch {
      // Trailing garbage without a newline — same policy as chatty lines.
    }
  }
}

/**
 * Terminate a child and its whole process tree. `child.kill()` alone leaves
 * CLI-spawned shell grandchildren running on Windows; taskkill /T reaches them.
 */
function killTree(child) {
  if (!child.pid) {
    child.kill?.();
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch {
      // taskkill unavailable — fall through to the plain kill.
    }
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
