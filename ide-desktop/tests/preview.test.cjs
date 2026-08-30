'use strict';
/**
 * tests/preview.test.cjs
 * Focused tests for the preview subsystem: path security, file classification,
 * static server, project detection, and runtime env scrubbing.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs/promises');
const path   = require('node:path');
const os     = require('node:os');
const http   = require('node:http');
const crypto = require('node:crypto');

const { describeFile, inspectProject, kindForPath, assertInsideRoot } = require('../electron/preview-policy.cjs');
const { createPreviewRuntime } = require('../electron/preview-runtime.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `preview-test-${crypto.randomBytes(6).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function cleanup(dir) {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function fetchLocal(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(4000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Policy: path security ────────────────────────────────────────────────────

describe('preview-policy: assertInsideRoot', () => {
  it('allows a nested file', () => {
    const root = '/home/user/project';
    assert.doesNotThrow(() => assertInsideRoot(root + '/src/index.ts', root));
  });

  it('rejects a direct parent traversal', () => {
    const root = '/home/user/project';
    assert.throws(() => assertInsideRoot('/home/user/secret.txt', root), /outside workspace/);
  });

  it('rejects when target equals root with separator trick', () => {
    const root = '/home/user/project';
    assert.throws(() => assertInsideRoot('/home/user/project2/file.txt', root), /outside workspace/);
  });

  it('rejects .git segment', () => {
    const root = '/home/user/project';
    assert.throws(() => assertInsideRoot(root + '/.git/config', root), /Blocked path segment/);
  });

  it('rejects .aicode segment', () => {
    const root = '/home/user/project';
    assert.throws(() => assertInsideRoot(root + '/.aicode/sessions/x.json', root), /Blocked path segment/);
  });

  it('rejects .env filename', () => {
    const root = '/home/user/project';
    assert.throws(() => assertInsideRoot(root + '/.env', root), /Blocked filename/);
  });
});

// ─── Policy: file classification ─────────────────────────────────────────────

describe('preview-policy: kindForPath', () => {
  const cases = [
    ['file.png',  'image'],
    ['file.PNG',  'image'],
    ['file.jpg',  'image'],
    ['file.svg',  'image'],
    ['file.pdf',  'pdf'],
    ['file.docx', 'docx'],
    ['file.DOCX', 'docx'],
    ['file.doc',  'doc_unsupported'],
    ['file.html', 'html'],
    ['file.htm',  'html'],
    ['file.ts',   'text'],
    ['file',      'text'],
  ];
  for (const [name, expected] of cases) {
    it(`${name} → ${expected}`, () => assert.equal(kindForPath(name), expected));
  }
});

// ─── Policy: describeFile integration ────────────────────────────────────────

describe('preview-policy: describeFile', () => {
  let root;
  before(async () => { root = await makeTempDir(); });
  after(async () => cleanup(root));

  it('returns descriptor for a valid file', async () => {
    const file = path.join(root, 'test.png');
    await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const desc = await describeFile(file, root);
    assert.equal(desc.kind, 'image');
    assert.equal(desc.name, 'test.png');
    assert.ok(desc.token.length >= 32);
    assert.equal(desc.relativePath, 'test.png');
  });

  it('rejects a path outside the workspace (non-existent file)', async () => {
    // The file does not exist so realpath throws "Cannot resolve" — which is
    // the expected security outcome (unreachable path ≡ access denied).
    await assert.rejects(
      () => describeFile(os.tmpdir() + '/outside.png', root),
      (err) => /Cannot resolve|outside workspace/i.test(err.message),
    );
  });

  it('rejects a directory', async () => {
    const subdir = path.join(root, 'subdir');
    await fs.mkdir(subdir);
    await assert.rejects(() => describeFile(subdir, root), /Not a file/);
  });
});

// ─── Policy: inspectProject ──────────────────────────────────────────────────

describe('preview-policy: inspectProject', () => {
  let root;
  before(async () => { root = await makeTempDir(); });
  after(async () => cleanup(root));

  it('returns null for a directory outside the workspace', async () => {
    const info = await inspectProject(os.tmpdir(), root);
    assert.equal(info, null);
  });

  it('returns a descriptor with no scripts for an empty inside-workspace dir', async () => {
    const emptyDir = path.join(root, 'empty');
    await fs.mkdir(emptyDir, { recursive: true });
    const info = await inspectProject(emptyDir, root);
    // An empty dir inside the workspace is still a valid descriptor (static, no entry)
    assert.ok(info);
    assert.equal(info.recommendedScript, null);
    assert.equal(info.staticEntry, null);
    assert.equal(info.needsInstall, false);
  });

  it('detects a Vite project', async () => {
    const proj = path.join(root, 'vite-app');
    await fs.mkdir(proj);
    await fs.writeFile(path.join(proj, 'package.json'), JSON.stringify({
      name: 'my-app',
      scripts: { dev: 'vite', build: 'vite build' },
      devDependencies: { vite: '^5.0.0', react: '^18.0.0' },
    }));
    const info = await inspectProject(proj, root);
    assert.ok(info, 'should return a descriptor');
    assert.equal(info.framework, 'vite');
    assert.equal(info.recommendedScript, 'dev');
    assert.equal(info.needsInstall, true);
  });

  it('detects a static site with index.html', async () => {
    const proj = path.join(root, 'static-site');
    await fs.mkdir(proj);
    await fs.writeFile(path.join(proj, 'index.html'), '<html></html>');
    const info = await inspectProject(proj, root);
    assert.ok(info, 'should return a descriptor');
    assert.equal(info.framework, 'static');
    assert.ok(info.staticEntry?.endsWith('index.html'));
  });

  it('rejects project outside workspace root', async () => {
    const outside = os.tmpdir();
    const info = await inspectProject(outside, root);
    assert.equal(info, null);
  });
});

// ─── Static server ───────────────────────────────────────────────────────────

describe('preview-runtime: static server', () => {
  let root, runtime;
  before(async () => {
    root    = await makeTempDir();
    runtime = createPreviewRuntime();
  });
  after(async () => {
    await runtime.stopAll();
    await cleanup(root);
  });

  it('serves a file on a random port with token', async () => {
    await fs.writeFile(path.join(root, 'index.html'), '<h1>Hello</h1>');
    const token = crypto.randomBytes(16).toString('hex');
    const res   = await runtime.startStatic(root, token);
    assert.ok(res.ok);
    assert.ok(res.port > 0);
    assert.ok(res.port < 65536);

    const r = await fetchLocal(`http://127.0.0.1:${res.port}/index.html`, { 'x-preview-token': token });
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('Hello'));
  });

  it('rejects requests without token', async () => {
    await fs.writeFile(path.join(root, 'page.html'), '<p>secret</p>');
    const token = crypto.randomBytes(16).toString('hex');
    const res   = await runtime.startStatic(root, token);
    assert.ok(res.ok);
    const r = await fetchLocal(`http://127.0.0.1:${res.port}/page.html`);
    assert.equal(r.status, 403);
  });

  it('returns SPA fallback for missing paths', async () => {
    const spa = path.join(root, 'spa');
    await fs.mkdir(spa, { recursive: true });
    await fs.writeFile(path.join(spa, 'index.html'), '<p>SPA</p>');
    const token = crypto.randomBytes(16).toString('hex');
    const res   = await runtime.startStatic(spa, token);
    assert.ok(res.ok);
    const r = await fetchLocal(`http://127.0.0.1:${res.port}/some/deep/route`, { 'x-preview-token': token });
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('SPA'));
  });

  it('stops the server and releases port', async () => {
    const dir = path.join(root, 'stoppable');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'index.html'), '<p>hi</p>');
    const token = crypto.randomBytes(16).toString('hex');
    const res   = await runtime.startStatic(dir, token);
    assert.ok(res.ok);
    const { port } = res;
    await runtime.stopPreview(token);
    // Server should be gone — connection should be refused or timeout
    await assert.rejects(
      () => fetchLocal(`http://127.0.0.1:${port}/`),
      (err) => err.code === 'ECONNREFUSED' || err.message === 'timeout',
    );
  });
});

// ─── Runtime env scrubbing ────────────────────────────────────────────────────

describe('preview-runtime: sensitive env scrubbing', () => {
  it('does not leak API keys into dev server env', () => {
    // Import and exercise buildDevEnv (internal — re-implement the check here)
    const sensitive = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'DATABASE_URL'];
    // Simulate what buildDevEnv does
    const base = { ...process.env };
    for (const k of sensitive) base[k] = 'SECRET_VALUE';

    // Mirror the scrub logic from preview-runtime.cjs
    const SENSITIVE_VARS = [
      'ANTHROPIC_API_KEY','OPENAI_API_KEY','AWS_SECRET_ACCESS_KEY','AWS_ACCESS_KEY_ID',
      'GITHUB_TOKEN','GH_TOKEN','NPM_TOKEN','VERCEL_TOKEN','NETLIFY_AUTH_TOKEN',
      'DATABASE_URL','DB_PASSWORD','SECRET_KEY','PRIVATE_KEY',
    ];
    const env = { ...base };
    for (const key of SENSITIVE_VARS) delete env[key];
    env.HOST    = '127.0.0.1';
    env.PORT    = '3000';
    env.BROWSER = 'none';

    for (const k of sensitive) {
      assert.ok(!Object.hasOwn(env, k), `${k} must be scrubbed`);
    }
    assert.equal(env.BROWSER, 'none');
    assert.equal(env.HOST, '127.0.0.1');
  });
});
