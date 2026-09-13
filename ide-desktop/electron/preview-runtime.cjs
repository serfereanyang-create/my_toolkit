/**
 * preview-runtime.cjs
 * Manages local HTTP servers for static file serving and supervised dev-server
 * child processes for Web app previews.
 */
'use strict';
const http    = require('node:http');
const fs      = require('node:fs');
const path    = require('node:path');
const { spawn } = require('node:child_process');
const crypto  = require('node:crypto');
const { assertInsideRoot } = require('./preview-policy.cjs');

let mimeTypes = null;
function getMime() {
  if (!mimeTypes) mimeTypes = require('mime-types');
  return mimeTypes;
}

// ─── Static HTTP server ───────────────────────────────────────────────────────

class StaticServer {
  constructor(rootDir, capabilityToken) {
    this.rootDir = fs.realpathSync(rootDir);
    this.token   = capabilityToken;
    this.server  = null;
    this.port    = null;
    this.watcher = null;
    this._reloadListeners = [];
  }

  onReload(fn) { this._reloadListeners.push(fn); return () => { this._reloadListeners = this._reloadListeners.filter(f => f !== fn); }; }
  _notifyReload() { for (const fn of this._reloadListeners) fn(); }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
      this.server.on('error', reject);
    });
  }

  _handle(req, res) {
    // Validate capability token from custom header (injected by guest session
    // webRequest). Never accept the token from a query string or URL path.
    if (req.headers['x-preview-token'] !== this.token) { res.writeHead(403); res.end('Forbidden'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('Method Not Allowed'); return; }

    let urlPath = String(req.url || '/').split('?')[0];
    try { urlPath = decodeURIComponent(urlPath); } catch { res.writeHead(400); res.end(); return; }
    if (!urlPath.startsWith('/')) { res.writeHead(400); res.end(); return; }

    // Resolve and validate the lexical path first. This blocks traversal even
    // when the requested resource does not exist and before SPA fallback.
    const target = path.resolve(this.rootDir, urlPath.replace(/^[/\\]+/, ''));
    try { assertInsideRoot(target, this.rootDir, { allowRoot: true }); } catch { res.writeHead(403); res.end('Forbidden'); return; }

    let realTarget = target;
    try { realTarget = fs.realpathSync(target); } catch { /* try index.html fallback */ }
    try { assertInsideRoot(realTarget, this.rootDir, { allowRoot: true }); } catch { res.writeHead(403); res.end('Forbidden'); return; }

    // SPA fallback must always map to this server's own root, not the process
    // cwd or the URL's parent. Canonicalize it too to prevent symlink escape.
    let servePath = realTarget;
    let stat;
    try { stat = fs.statSync(servePath); } catch { stat = null; }
    if (!stat || stat.isDirectory()) {
      const indexPath = path.join(this.rootDir, 'index.html');
      try {
        const realIndex = fs.realpathSync(indexPath);
        assertInsideRoot(realIndex, this.rootDir);
        servePath = realIndex;
        stat = fs.statSync(servePath);
      } catch {
        res.writeHead(404); res.end('Not found'); return;
      }
    }

    if (!stat.isFile()) { res.writeHead(403); res.end(); return; }
    if (stat.size > 50 * 1024 * 1024) { res.writeHead(413); res.end(); return; }

    const mime = getMime().lookup(servePath) || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(servePath).pipe(res);
  }

  async stop() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    await new Promise((resolve) => { this.server ? this.server.close(resolve) : resolve(); });
    this.server = null;
    this.port   = null;
  }
}

// ─── Dev-server process manager ───────────────────────────────────────────────

const SENSITIVE_VARS = [
  'ANTHROPIC_API_KEY','OPENAI_API_KEY','AWS_SECRET_ACCESS_KEY','AWS_ACCESS_KEY_ID',
  'GITHUB_TOKEN','GH_TOKEN','NPM_TOKEN','VERCEL_TOKEN','NETLIFY_AUTH_TOKEN',
  'DATABASE_URL','DB_PASSWORD','SECRET_KEY','PRIVATE_KEY',
];

function buildDevEnv(port) {
  const env = { ...process.env };
  for (const key of SENSITIVE_VARS) delete env[key];
  // Override to keep dev server on loopback only
  env.HOST = '127.0.0.1';
  env.PORT = String(port);
  env.BROWSER = 'none';
  env.CI = '1'; // suppress interactive prompts
  return env;
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

async function waitReady(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 400));
    const alive = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (alive) return true;
  }
  return false;
}

class DevServerProcess {
  constructor(projectDir, script, pkgManager) {
    this.projectDir = projectDir;
    this.script     = script;
    this.pkgManager = pkgManager;
    this.port       = null;
    this.child      = null;
    this.status     = 'stopped'; // stopped | starting | running | error
    this._logListeners  = [];
    this._stateListeners = [];
  }

  onLog(fn)   { this._logListeners.push(fn);   return () => { this._logListeners   = this._logListeners.filter(f => f !== fn); }; }
  onState(fn) { this._stateListeners.push(fn); return () => { this._stateListeners = this._stateListeners.filter(f => f !== fn); }; }

  _emit(state) { this.status = state.status ?? this.status; for (const fn of this._stateListeners) fn(state); }
  _log(line)   { for (const fn of this._logListeners) fn(line); }

  async start() {
    if (this.child) return { ok: true, port: this.port };
    this._emit({ status: 'starting' });
    this.port = await pickFreePort();
    const env = buildDevEnv(this.port);

    let cmd, args;
    if (this.pkgManager === 'pnpm') { cmd = 'pnpm'; args = ['run', this.script, '--', `--port=${this.port}`, '--host=127.0.0.1']; }
    else if (this.pkgManager === 'yarn') { cmd = 'yarn'; args = [this.script]; }
    else { cmd = 'npm'; args = ['run', this.script, '--', `--port=${this.port}`, '--host=127.0.0.1']; }

    this.child = spawn(cmd, args, { cwd: this.projectDir, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    const onData = (buf) => { const lines = buf.toString().split(/\r?\n/).filter(Boolean); lines.forEach(l => this._log(l)); };
    this.child.stdout?.on('data', onData);
    this.child.stderr?.on('data', onData);
    this.child.on('error', (err) => this._emit({ status: 'error', error: err.message }));
    this.child.on('exit', (code) => { this.child = null; this._emit({ status: code === 0 ? 'stopped' : 'error', code }); });

    const ready = await waitReady(this.port, 35000);
    if (!ready) { await this.stop(); return { ok: false, error: 'Dev server did not start in time' }; }
    this._emit({ status: 'running', port: this.port });
    return { ok: true, port: this.port };
  }

  async stop() {
    if (!this.child) return;
    this.child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 800));
    try { if (this.child) this.child.kill('SIGKILL'); } catch { /* already gone */ }
    this.child = null;
    this._emit({ status: 'stopped' });
  }
}

// ─── PreviewRuntime facade ────────────────────────────────────────────────────

class PreviewRuntime {
  constructor() {
    this._servers  = new Map(); // token → StaticServer
    this._devProcs = new Map(); // token → DevServerProcess
  }

  async startStatic(rootDir, token) {
    const existing = this._servers.get(token);
    if (existing?.port) return { ok: true, port: existing.port, token };
    const srv = new StaticServer(rootDir, token);
    const port = await srv.start();
    this._servers.set(token, srv);
    return { ok: true, port, token };
  }

  getStaticServer(token) { return this._servers.get(token); }

  async startDevServer(projectDir, script, pkgManager, token) {
    let proc = this._devProcs.get(token);
    if (proc?.status === 'running') return { ok: true, port: proc.port, token };
    if (proc) await proc.stop();
    proc = new DevServerProcess(projectDir, script, pkgManager);
    this._devProcs.set(token, proc);
    return proc.start();
  }

  getDevProcess(token) { return this._devProcs.get(token); }

  async stopPreview(token) {
    const srv = this._servers.get(token);
    if (srv) { await srv.stop(); this._servers.delete(token); }
    const proc = this._devProcs.get(token);
    if (proc) { await proc.stop(); this._devProcs.delete(token); }
  }

  async stopAll() {
    const tasks = [];
    for (const [, srv]  of this._servers)  tasks.push(srv.stop());
    for (const [, proc] of this._devProcs) tasks.push(proc.stop());
    await Promise.allSettled(tasks);
    this._servers.clear();
    this._devProcs.clear();
  }
}

function createPreviewRuntime() { return new PreviewRuntime(); }
module.exports = { createPreviewRuntime, StaticServer, DevServerProcess };
