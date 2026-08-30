/**
 * fim-server.cjs
 * Manages the FIM (fill-in-middle) bridge child process for Tab autocomplete.
 * The bridge is a persistent Node process (cli/src/cli/fimBridge.ts compiled
 * to dist/src/cli/fimBridge.js) that receives JSON requests over stdin and
 * returns JSON responses over stdout.
 */
'use strict';
const { spawn }    = require('node:child_process');
const path         = require('node:path');
const crypto       = require('node:crypto');
const EventEmitter = require('node:events');

class FimServer extends EventEmitter {
  constructor({ cliRoot, provider, apiKey, baseUrl, model, maxTokens }) {
    super();
    this.cliRoot    = cliRoot;
    this.provider   = provider;
    this.apiKey     = apiKey;
    this.baseUrl    = baseUrl;
    this.model      = model;
    this.maxTokens  = maxTokens ?? 128;
    this.child      = null;
    this.buffer     = '';
    this.pending    = new Map(); // id → { resolve, reject, timer }
    this._starting  = null;
  }

  /** Start the bridge if not running. Returns after first successful line. */
  async start() {
    if (this.child) return;
    if (this._starting) return this._starting;

    this._starting = new Promise((resolve, reject) => {
      const entryJs = path.join(this.cliRoot, 'dist', 'src', 'cli', 'fimBridge.js');
      const env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        FIM_PROVIDER: this.provider ?? 'openai',
        FIM_API_KEY:  this.apiKey  ?? '',
        FIM_BASE_URL: this.baseUrl ?? '',
        FIM_MODEL:    this.model   ?? 'deepseek-coder',
        FIM_MAX_TOKENS: String(this.maxTokens),
      };

      this.child = spawn(process.execPath, [entryJs], {
        env,
        cwd: this.cliRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk) => this._handleOutput(chunk));
      this.child.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) console.warn('[fim-server] stderr:', msg);
      });
      this.child.on('exit', (code) => {
        this.child = null;
        this._starting = null;
        for (const [, { reject: rej, timer }] of this.pending) {
          clearTimeout(timer);
          rej(new Error(`FIM bridge exited with code ${code}`));
        }
        this.pending.clear();
        this.emit('exit', code);
      });
      this.child.on('error', (err) => {
        this.child = null;
        this._starting = null;
        reject(err);
      });

      // Resolve once child process starts (not waiting for a ready message)
      setTimeout(resolve, 100);
    });

    await this._starting;
    this._starting = null;
  }

  _handleOutput(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const entry = this.pending.get(msg.id);
        if (!entry) continue;
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error));
        else entry.resolve({ insert: msg.insert ?? '', latencyMs: msg.latencyMs ?? 0, truncated: !!msg.truncated });
      } catch { /* ignore malformed */ }
    }
  }

  /**
   * Send a FIM request.
   * @param {{ prefix, suffix, language?, filepath?, maxTokens? }} req
   * @returns {Promise<{ insert: string, latencyMs: number, truncated: boolean }>}
   */
  async complete(req) {
    await this.start();
    return new Promise((resolve, reject) => {
      const id = crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('FIM completion timed out'));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify({ id, ...req }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  stop() {
    if (!this.child) return;
    try { this.child.kill(); } catch { /* ignore */ }
    this.child = null;
  }

  /** Re-configure credentials without restarting (takes effect on next start). */
  configure({ provider, apiKey, baseUrl, model, maxTokens }) {
    this.provider  = provider  ?? this.provider;
    this.apiKey    = apiKey    ?? this.apiKey;
    this.baseUrl   = baseUrl   ?? this.baseUrl;
    this.model     = model     ?? this.model;
    this.maxTokens = maxTokens ?? this.maxTokens;
    // Restart to pick up new settings
    this.stop();
  }
}

function createFimServer(opts) { return new FimServer(opts); }
module.exports = { createFimServer, FimServer };
