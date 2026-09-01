/**
 * language-server.cjs
 * Manages the editor language-intelligence bridge child process (hover,
 * go-to-definition, find-references, completions) backed by the real
 * TypeScript compiler. The bridge is a persistent Node process
 * (cli/src/cli/languageBridge.ts compiled to dist/src/cli/languageBridge.js)
 * that receives JSON requests over stdin and returns JSON over stdout.
 *
 * Mirrors fim-server.cjs: one long-lived child, request/response correlated by
 * a random id, per-request timeout, lazy start, crash-resilient.
 */
'use strict';
const { spawn }    = require('node:child_process');
const path         = require('node:path');
const crypto       = require('node:crypto');
const EventEmitter = require('node:events');

class LanguageServer extends EventEmitter {
  constructor({ cliRoot }) {
    super();
    this.cliRoot   = cliRoot;
    this.child     = null;
    this.buffer    = '';
    this.pending   = new Map(); // id → { resolve, reject, timer }
    this._starting = null;
  }

  async start() {
    if (this.child) return;
    if (this._starting) return this._starting;

    this._starting = new Promise((resolve, reject) => {
      const entryJs = path.join(this.cliRoot, 'dist', 'src', 'cli', 'languageBridge.js');
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

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
        if (msg) console.warn('[language-server] stderr:', msg);
      });
      this.child.on('exit', (code) => {
        this.child = null;
        this._starting = null;
        for (const [, { reject: rej, timer }] of this.pending) {
          clearTimeout(timer);
          rej(new Error(`language bridge exited with code ${code}`));
        }
        this.pending.clear();
        this.emit('exit', code);
      });
      this.child.on('error', (err) => {
        this.child = null;
        this._starting = null;
        reject(err);
      });

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
        else entry.resolve(msg.result);
      } catch { /* ignore malformed */ }
    }
  }

  /**
   * @param {'hover'|'definition'|'references'|'completions'} method
   * @param {{ workspaceRoot, path, line, column }} req
   */
  async query(method, req) {
    await this.start();
    return new Promise((resolve, reject) => {
      const id = crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('language query timed out'));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify({ id, method, ...req }) + '\n');
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
}

function createLanguageServer(opts) { return new LanguageServer(opts); }
module.exports = { createLanguageServer, LanguageServer };
