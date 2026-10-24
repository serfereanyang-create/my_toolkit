'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { assertInsideRoot, resolveWorkspacePath } = require('./preview-policy.cjs');
const { createBackgroundProcessJob } = require('./background-process-job.cjs');
const { parseKeyChord } = require('./background-input.cjs');

const TOOLS = new Set(['open', 'windows', 'inspect', 'click', 'fill', 'type', 'key', 'screenshot', 'close'].map(name => `background_app_${name}`));
const TIMEOUT_MS = 30_000;

async function storageDirectory(root, segments) {
  const realRoot = await fs.realpath(root);
  let directory = realRoot;
  for (const segment of segments) {
    directory = path.join(directory, segment);
    try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    directory = await fs.realpath(directory);
    assertInsideRoot(directory, realRoot, { rejectBlocked: false });
  }
  return directory;
}

async function resolveProject(root, candidate) {
  if (typeof candidate !== 'string' || !candidate || path.isAbsolute(candidate) || candidate.includes('\0')) throw new Error('需要工作区相对项目路径（根目录使用 .）。');
  const { path: project } = await resolveWorkspacePath(path.resolve(root, candidate), root, { allowRoot: true });
  const { path: manifestPath } = await resolveWorkspacePath(path.join(project, 'package.json'), root);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (typeof manifest.main !== 'string' || !manifest.main) throw new Error('项目 package.json 需要 Electron main 入口；请先构建应用。');
  const { path: entry } = await resolveWorkspacePath(path.resolve(project, manifest.main), root);
  assertInsideRoot(entry, project);
  const extension = path.extname(entry).toLowerCase();
  if (!['.js', '.cjs', '.mjs'].includes(extension)) throw new Error('需要构建后的 Electron JavaScript 入口（.js、.cjs 或 .mjs），不支持任意原生应用。');
  if (!(await fs.stat(entry)).isFile()) throw new Error('Electron main 入口不是文件。');
  let moduleFormat = extension === '.mjs' ? 'module' : 'commonjs';
  if (extension === '.js') {
    let directory = path.dirname(entry);
    while (true) {
      try {
        const { path: packagePath } = await resolveWorkspacePath(path.join(directory, 'package.json'), root);
        const nearestPackage = JSON.parse(await fs.readFile(packagePath, 'utf8'));
        moduleFormat = nearestPackage.type === 'module' ? 'module' : 'commonjs';
        break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (directory === project) break;
      directory = path.dirname(directory);
    }
  }
  return { project, entry, moduleFormat };
}

function validateInput(tool, input) {
  if (!TOOLS.has(tool)) throw new Error('不支持的后台应用工具。');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数必须是对象。');
  const operation = tool.slice('background_app_'.length);
  const allowed = operation === 'open' ? ['path', 'width', 'height'] : ['appId', ...(['close', 'windows'].includes(operation) ? [] : ['windowId']), ...(operation === 'click' ? ['selector', 'x', 'y', 'button', 'double'] : []), ...(operation === 'fill' ? ['selector', 'value'] : []), ...(operation === 'type' ? ['selector', 'text'] : []), ...(operation === 'key' ? ['key', 'selector'] : [])];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('包含不支持的参数。');
  if (operation === 'open') {
    if (typeof input.path !== 'string' || !input.path) throw new Error('需要项目路径。');
    for (const key of ['width', 'height']) if (input[key] !== undefined && (!Number.isInteger(input[key]) || input[key] < 100 || input[key] > 4096)) throw new Error('截图尺寸必须为 100–4096 的整数。');
  } else {
    if (typeof input.appId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.appId)) throw new Error('无效的后台应用 ID。');
    if (input.windowId !== undefined && (!Number.isSafeInteger(input.windowId) || input.windowId < 1)) throw new Error('无效的窗口 ID。');
  }
  for (const key of ['selector', 'key']) if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key] || input[key].length > 2048)) throw new Error(`无效的 ${key}。`);
  if (operation === 'click') {
    const selector = Object.hasOwn(input, 'selector');
    const coordinates = Object.hasOwn(input, 'x') || Object.hasOwn(input, 'y');
    if (selector === coordinates) throw new Error('点击需要且只能指定 selector 或 x/y 坐标。');
    if (coordinates && (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0 || input.x > 16384 || input.y > 16384)) throw new Error('无效的截图点击坐标。');
    if (input.button !== undefined && !['left', 'middle', 'right'].includes(input.button)) throw new Error('无效的鼠标按键。');
    if (input.double !== undefined && typeof input.double !== 'boolean') throw new Error('double 必须是布尔值。');
  }
  if (operation === 'fill' && typeof input.selector !== 'string') throw new Error('需要元素选择器。');
  if (operation === 'fill' && (typeof input.value !== 'string' || input.value.length > 100_000)) throw new Error('无效的填写内容。');
  if (operation === 'type' && (typeof input.text !== 'string' || !input.text || input.text.length > 100_000)) throw new Error('需要 1–100000 字符的输入文字。');
  if (operation === 'key') parseKeyChord(input.key);
  return operation;
}

class BackgroundAppService {
  constructor({ executable = process.execPath, timeoutMs = TIMEOUT_MS } = {}) {
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.apps = new Map();
    this.disposed = false;
    this.generation = 0;
    this.sessionGenerations = new Map();
  }

  async open(sessionId, root, input, generation, sessionGeneration, signal) {
    signal?.throwIfAborted();
    const { project, entry, moduleFormat } = await resolveProject(root, input.path);
    const appId = crypto.randomUUID();
    const profile = await storageDirectory(root, ['.aicode', 'background-apps', appId]);
    signal?.throwIfAborted();
    if (this.disposed || this.generation !== generation || this.sessionGenerations.get(sessionId) !== sessionGeneration) throw new Error('后台应用启动已取消。');
    if ([...this.apps.values()].filter(app => app.sessionId === sessionId).length >= 2) throw new Error('每个会话最多同时运行两个后台应用，请先关闭。');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const child = spawn(this.executable, [path.join(__dirname, 'background-app-entry.mjs'), JSON.stringify({ project, entry, moduleFormat, profile, waitForHost: true, width: input.width, height: input.height })], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const instance = { child, sessionId, root, pending: new Map(), errors: '', sequence: 0, queue: Promise.resolve(), closed: false };
    this.apps.set(appId, instance);
    const ready = new Promise((resolve, reject) => {
      instance.pending.set('ready', { resolve, reject, timer: setTimeout(() => reject(new Error('后台应用启动超时；请检查构建入口。')), this.timeoutMs) });
    });
    const fail = error => {
      instance.closed = true;
      this.apps.delete(appId);
      for (const pending of instance.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      instance.pending.clear();
      void instance.job?.close();
    };
    child.stdout.on('data', () => {});
    child.stderr.on('data', chunk => { instance.errors = (instance.errors + chunk.toString()).slice(-4000); });
    child.on('message', message => {
      if (message?.id === 'bootstrap' && !instance.setup) {
        instance.setup = (async () => {
          try {
            instance.job = await createBackgroundProcessJob(child.pid, profile);
            if (instance.closed || instance.stopping || this.disposed) { await instance.job?.close(); return; }
            child.send({ operation: 'start' }, error => {
              if (error) instance.pending.get('ready')?.reject(error);
            });
          } catch (error) { instance.pending.get('ready')?.reject(error); }
        })();
        return;
      }
      const pending = instance.pending.get(message?.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      instance.pending.delete(message.id);
      if (message.error) pending.reject(new Error(String(message.error)));
      else pending.resolve(message.result);
    });
    child.once('error', fail);
    child.once('exit', (code, signal) => fail(new Error(`后台应用已退出（${code ?? signal}）。${instance.errors}`)));
    const abort = () => { void this.stop(instance); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const result = await ready;
      signal?.throwIfAborted();
      return { ok: true, output: '已在独立数据目录中隐藏运行真实 Electron 应用。', data: { ...result, appId, hidden: true } };
    } catch (error) { await this.stop(instance); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }

  request(instance, operation, input) {
    if (instance.closed || !instance.child.connected) return Promise.reject(new Error('后台应用已断开。'));
    const id = String(++instance.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        instance.pending.delete(id);
        reject(new Error('后台应用操作超时，已结束该后台进程。'));
        void this.stop(instance);
      }, this.timeoutMs);
      instance.pending.set(id, { resolve, reject, timer });
      instance.child.send({ id, operation, input }, error => {
        if (!error) return;
        const pending = instance.pending.get(id);
        if (!pending) return;
        clearTimeout(timer);
        instance.pending.delete(id);
        reject(error);
      });
    });
  }

  async stop(instance) {
    if (instance.stopping) return instance.stopping;
    instance.stopping = (async () => {
      if (!instance.closed) await new Promise(resolve => {
        const timer = setTimeout(() => {
          if (instance.job) void instance.job.close();
          else instance.child.kill();
        }, 1500);
        instance.child.once('exit', () => { clearTimeout(timer); resolve(); });
        if (instance.child.connected) instance.child.send({ operation: 'close' }, () => {});
        else instance.child.kill();
      });
      await instance.setup;
      await instance.job?.close();
    })();
    return instance.stopping;
  }

  async execute({ sessionId, workspaceRoot, tool, input, signal }) {
    try {
      signal?.throwIfAborted();
      if (this.disposed) throw new Error('后台应用服务已经退出。');
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('需要所属会话。');
      const operation = validateInput(tool, input);
      const generation = this.generation;
      const sessionGeneration = this.sessionGenerations.get(sessionId);
      const root = await fs.realpath(workspaceRoot);
      if (operation === 'open') return await this.open(sessionId, root, input, generation, sessionGeneration, signal);
      const instance = this.apps.get(input.appId);
      if (!instance || instance.sessionId !== sessionId || instance.root !== root) throw new Error('后台应用不存在，或不属于当前会话与工作区。');
      if (operation === 'close') { await this.stop(instance); return { ok: true, output: '已关闭后台应用。' }; }
      const perform = async () => {
        signal?.throwIfAborted();
        const abort = () => { void this.stop(instance); };
        signal?.addEventListener('abort', abort, { once: true });
        try {
        const result = await this.request(instance, operation, input);
        signal?.throwIfAborted();
        if (operation !== 'screenshot') return { ok: true, output: JSON.stringify(result), data: { ...result, appId: input.appId, hidden: true } };
        if (typeof result.png !== 'string' || result.png.length > 64 * 1024 * 1024) throw new Error('截图数据无效或过大。');
        const png = Buffer.from(result.png, 'base64');
        if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('后台应用未返回有效 PNG。');
        const directory = await storageDirectory(root, ['.aicode', 'screenshots']);
        const name = `app-${crypto.randomUUID()}.png`;
        signal?.throwIfAborted();
        await fs.writeFile(path.join(directory, name), png, { flag: 'wx' });
        const relative = `.aicode/screenshots/${name}`;
        const { png: _png, ...metadata } = result;
        return { ok: true, output: `已截取后台应用真实画面（${result.width}×${result.height}）：${relative}`, data: { ...metadata, appId: input.appId, hidden: true, computerImage: { mediaType: 'image/png', data: result.png, path: relative } } };
        } finally { signal?.removeEventListener('abort', abort); }
      };
      const result = instance.queue.then(perform);
      instance.queue = result.catch(() => {});
      return await result;
    } catch (error) { return { ok: false, output: `后台应用：${error.message}` }; }
  }

  async closeSession(sessionId) { this.sessionGenerations.set(sessionId, (this.sessionGenerations.get(sessionId) ?? 0) + 1); await Promise.all([...this.apps.values()].filter(instance => instance.sessionId === sessionId).map(instance => this.stop(instance))); }
  async disposeAll() { this.generation += 1; await Promise.all([...this.apps.values()].map(instance => this.stop(instance))); }
  dispose() { this.disposed = true; return this.disposeAll(); }
}

module.exports = { BackgroundAppService, resolveProject, validateInput, storageDirectory };
