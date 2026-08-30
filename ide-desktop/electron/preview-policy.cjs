/**
 * preview-policy.cjs
 * File classification and path-security validation for the preview subsystem.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

// Mapping from preview kind → file extensions (lowercase, no leading dot)
const KIND_MAP = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'],
  pdf:   ['pdf'],
  docx:  ['docx'],
  doc_unsupported: ['doc', 'odt', 'rtf'],
  html:  ['html', 'htm'],
};
// Reverse map: ext → kind
const EXT_TO_KIND = {};
for (const [kind, exts] of Object.entries(KIND_MAP)) {
  for (const e of exts) EXT_TO_KIND[e] = kind;
}

// Path segments and filenames that are always blocked regardless of workspace
const BLOCKED_SEGMENTS = new Set(['.git', '.aicode', 'node_modules', '.ssh', '.gnupg']);
const BLOCKED_NAMES = new Set(['.env', '.env.local', '.env.production', '.env.development',
  '.env.staging', '.netrc', 'id_rsa', 'id_ed25519', 'credentials']);

function kindForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  return EXT_TO_KIND[ext] || 'text';
}

/** Throw if targetAbs is not safely inside rootAbs (synchronous). */
function assertInsideRoot(targetAbs, rootAbs) {
  const rel = path.relative(rootAbs, targetAbs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path is outside workspace root');
  }
  for (const seg of rel.split(path.sep)) {
    if (BLOCKED_SEGMENTS.has(seg)) throw new Error(`Blocked path segment: ${seg}`);
    if (BLOCKED_NAMES.has(seg))    throw new Error(`Blocked filename: ${seg}`);
  }
}

/**
 * Resolve, canonicalize, security-check, and stat a file.
 * Returns a PreviewDescriptor including a fresh random token.
 */
async function describeFile(absolutePath, workspaceRoot) {
  let real, realRoot;
  try { real = await fs.realpath(absolutePath); } catch { throw new Error(`Cannot resolve: ${absolutePath}`); }
  try { realRoot = await fs.realpath(workspaceRoot); } catch { realRoot = workspaceRoot; }

  assertInsideRoot(real, realRoot);

  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error('Not a file');

  const kind  = kindForPath(real);
  const token = crypto.randomBytes(20).toString('hex');
  return {
    absolutePath: real,
    relativePath: path.relative(realRoot, real),
    name:  path.basename(real),
    ext:   path.extname(real).toLowerCase(),
    kind,
    size:  stat.size,
    token,
  };
}

/**
 * Inspect a directory for web-app project characteristics.
 * Returns a ProjectDescriptor or null if nothing recognisable found.
 */
async function inspectProject(dirPath, workspaceRoot) {
  let real, realRoot;
  try { real = await fs.realpath(dirPath); } catch { return null; }
  try { realRoot = await fs.realpath(workspaceRoot); } catch { realRoot = workspaceRoot; }

  const rel = path.relative(realRoot, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  const pkgPath = path.join(real, 'package.json');
  let pkg = null;
  try { pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')); } catch { /* not a Node project */ }

  const has = async (name) => { try { await fs.access(path.join(real, name)); return true; } catch { return false; } };
  const hasNodeModules = await has('node_modules');
  const hasLockNpm    = await has('package-lock.json');
  const hasLockPnpm   = await has('pnpm-lock.yaml');
  const hasLockYarn   = await has('yarn.lock');
  const hasDistIndex  = await has('dist/index.html') || await has('build/index.html') || await has('out/index.html');
  const hasIndexHtml  = await has('index.html');
  const lockfile = hasLockPnpm ? 'pnpm-lock.yaml' : hasLockYarn ? 'yarn.lock' : hasLockNpm ? 'package-lock.json' : null;
  const pkgManager = hasLockPnpm ? 'pnpm' : hasLockYarn ? 'yarn' : 'npm';

  // Detect framework from dependencies
  let framework = 'static';
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['next']) framework = 'next';
    else if (deps['vite']) framework = 'vite';
    else if (deps['react-scripts']) framework = 'cra';
    else if (deps['@sveltejs/kit'] || deps['svelte']) framework = 'svelte';
    else if (deps['nuxt']) framework = 'nuxt';
    else if (deps['vue']) framework = 'vue';
  }

  // Script selection
  let recommendedScript = null;
  if (pkg?.scripts) {
    const s = pkg.scripts;
    if (framework === 'next' && s.dev) recommendedScript = 'dev';
    else if (framework === 'vite' && s.dev) recommendedScript = 'dev';
    else if (framework === 'cra'  && s.start) recommendedScript = 'start';
    else if (s.dev) recommendedScript = 'dev';
    else if (s.start) recommendedScript = 'start';
    else if (s.preview) recommendedScript = 'preview';
    else if (s.serve) recommendedScript = 'serve';
  }

  // Static: already-built site
  let staticEntry = null;
  if (!recommendedScript && hasIndexHtml) staticEntry = path.join(real, 'index.html');
  if (!recommendedScript && hasDistIndex) {
    for (const d of ['dist', 'build', 'out']) {
      if (await has(`${d}/index.html`)) { staticEntry = path.join(real, d, 'index.html'); break; }
    }
  }

  return {
    absolutePath: real,
    relativePath: rel,
    name: pkg?.name || path.basename(real),
    framework,
    pkgManager,
    lockfile,
    hasNodeModules,
    scripts: pkg?.scripts || {},
    recommendedScript,
    staticEntry,
    needsInstall: !!pkg && !hasNodeModules,
    token: crypto.randomBytes(20).toString('hex'),
  };
}

module.exports = { kindForPath, assertInsideRoot, describeFile, inspectProject, BLOCKED_SEGMENTS };
