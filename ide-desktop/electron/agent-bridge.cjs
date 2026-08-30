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
    this.child = null;
    this.buffer = '';
  }

  start() {
    if (this.child) return;
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

    this.child = spawn(process.execPath, args, {
      cwd: this.cliRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      // Suppress Node.js ExperimentalWarning lines — they are informational and
      // must never surface as agent errors that block or corrupt the conversation.
      if (text.includes('ExperimentalWarning') || text.includes('(node:') && text.includes('Warning:')) return;
      this.emit('event', { type: 'error', message: redact(text) });
    });
    this.child.on('exit', (code) => {
      this.emit('event', { type: 'agent_offline', code });
      this.child = null;
    });
  }

  send(command) {
    if (!this.child || !this.child.stdin.writable) throw new Error('Agent bridge is not running');
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  prompt(text, files, toolScope) {
    // Carry the current effort tier with each message so the live change takes
    // effect on the very next turn without restarting the child.
    const command = { type: 'user_message', text };
    if (this.reasoningEffort) command.reasoningEffort = this.reasoningEffort;
    if (toolScope || this.toolScope) command.toolScope = toolScope || this.toolScope;
    if (files && files.length > 0) command.files = files;
    this.send(command);
  }

  taskBoardAction(action, taskId) {
    this.send({ type: 'task_board_action', action, taskId });
  }

  automationTask(taskId, goal) {
    this.send({ type: 'automation_task', taskId, goal });
  }

  setEffort(reasoningEffort) {
    this.reasoningEffort = reasoningEffort;
    // Update the running child too (no-op if not started; start() will pass it).
    if (this.child && this.child.stdin.writable) {
      this.send({ type: 'set_effort', reasoningEffort });
    }
  }

  setToolScope(toolScope) {
    this.toolScope = toolScope;
    if (this.child && this.child.stdin.writable) {
      this.send({ type: 'set_tool_scope', toolScope });
    }
  }

  approve(requestId, decision) {
    this.send({ type: 'approval_response', requestId, decision });
  }

  // Revert one turn's file writes by their CLI checkpoint ids. The CLI replies
  // with an `undo_done` event carrying the real reverted count.
  undo(checkpointIds) {
    this.send({ type: 'undo', checkpointIds: Array.isArray(checkpointIds) ? checkpointIds : [] });
  }

  cancel() {
    if (!this.child) return;
    // Kill the child first so the natural 'exit' handler does not fire
    // agent_offline a second time after we emit it here.
    const child = this.child;
    this.child = null;
    child.kill();
    // Emit turn_done synchronously so the UI stops the spinner immediately,
    // then emit agent_offline so App.tsx sets agentStatus='offline' and the
    // next prompt correctly re-starts the bridge instead of calling prompt()
    // on a dead child.
    this.emit('event', { type: 'turn_done', status: 'cancelled' });
    this.emit('event', { type: 'agent_offline', code: -1 });
  }

  restart() {
    this.cancel();
    this.start();
  }

  dispose() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    // Ask for a graceful shutdown, then guarantee termination. The CLI releases
    // its stdin on `shutdown`, but a hard-kill fallback avoids leaking a child
    // process if the graceful path stalls.
    try {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    } catch {
      // stdin already closed; fall through to kill.
    }
    const killTimer = setTimeout(() => {
      if (!child.killed) child.kill();
    }, 1000);
    if (typeof killTimer.unref === 'function') killTimer.unref();
    child.once('exit', () => clearTimeout(killTimer));
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.emit('event', normalizeCliEvent(JSON.parse(line)));
      } catch (error) {
        this.emit('event', { type: 'error', message: `Invalid agent event: ${error.message}` });
      }
    }
  }
}

function normalizeCliEvent(event) {
  if (event.type === 'assistant') return { ...event, type: 'assistant_message', text: event.content || event.text || '' };
  if (event.type === 'assistant_delta') return { ...event, type: 'assistant_delta', text: event.content || event.text || '' };
  return event;
}

function redact(value) {
  return String(value).replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1***');
}

module.exports = { AgentBridge, normalizeCliEvent, redact };
