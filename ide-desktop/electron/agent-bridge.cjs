const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');

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

    const env = { ...process.env };
    if (this.provider === 'openai' && this.apiKey) env.OPENAI_API_KEY = this.apiKey;
    if (this.provider === 'anthropic' && this.apiKey) env.ANTHROPIC_API_KEY = this.apiKey;

    this.child = spawn(process.execPath, args, {
      cwd: this.cliRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => this.emit('event', { type: 'error', message: redact(chunk) }));
    this.child.on('exit', (code) => {
      this.emit('event', { type: 'agent_offline', code });
      this.child = null;
    });
  }

  send(command) {
    if (!this.child || !this.child.stdin.writable) throw new Error('Agent bridge is not running');
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  prompt(text) {
    this.send({ type: 'user_message', text });
  }

  approve(requestId, decision) {
    this.send({ type: 'approval_response', requestId, decision });
  }

  cancel() {
    if (!this.child) return;
    this.child.kill();
    this.child = null;
    this.emit('event', { type: 'turn_done', status: 'cancelled' });
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
  if (event.type === 'assistant') return { type: 'assistant_message', text: event.content || '' };
  if (event.type === 'assistant_delta') return { type: 'assistant_delta', text: event.content || event.text || '' };
  return event;
}

function redact(value) {
  return String(value).replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1***');
}

module.exports = { AgentBridge, normalizeCliEvent, redact };
