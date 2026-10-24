/**
 * preview-policy.cjs
 * File classification and path-security validation for the preview subsystem.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

// Mapping from preview kind → file extensions (lowercase, no leading dot)
//
// `xlsx` and `pptx` are the OOXML formats the panes can parse. Their pre-OOXML
// counterparts (.xls/.ppt) and the OpenDocument ones are listed as unsupported
// rather than left to fall through to `text`: they are binary, so the fallback
// would hand the code editor a file it refuses to open, and the user would get
// no explanation at all. `doc_unsupported` is the shared "binary office file we
// cannot render, offer the system application" kind.
const KIND_MAP = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'],
  pdf:   ['pdf'],
  docx:  ['docx'],
  xlsx:  ['xlsx'],
  pptx:  ['pptx'],
  doc_unsupported: ['doc', 'odt', 'rtf', 'xls', 'ods', 'ppt', 'odp'],
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

function isBlockedSegment(segment) {
  const normalized = String(segment).toLowerCase();
  return BLOCKED_SEGMENTS.has(normalized) || BLOCKED_NAMES.has(normalized);
}

/** Throw if targetAbs is not safely inside rootAbs (synchronous). */
function assertInsideRoot(targetAbs, rootAbs, options = {}) {
  const rel = path.relative(rootAbs, targetAbs);
  const allowRoot = options.allowRoot === true;
  if ((!allowRoot && !rel) || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path is outside workspace root');
  }
  if (options.rejectBlocked !== false) {
    for (const seg of rel ? rel.split(path.sep) : []) {
      const normalized = String(seg).toLowerCase();
      if (BLOCKED_SEGMENTS.has(normalized)) throw new Error(`Blocked path segment: ${seg}`);
      if (BLOCKED_NAMES.has(normalized))    throw new Error(`Blocked filename: ${seg}`);
    }
  }
}

/**
 * Resolve a renderer-supplied path against a canonical workspace root.
 * Existing symlinks are resolved before the containment check. For a write
 * target that does not exist yet, every existing parent is canonicalized so a
 * symlink cannot redirect the eventual file outside the workspace.
 */
async function resolveWorkspacePath(candidate, workspaceRoot, options = {}) {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new Error('Path is required');
  }

  const realRoot = await fs.realpath(workspaceRoot);
  const rootStat = await fs.stat(realRoot);
  if (!rootStat.isDirectory()) throw new Error('Workspace root is not a directory');

  const lexicalTarget = path.resolve(realRoot, candidate);
  // Reject a lexically escaping path BEFORE touching the filesystem. Otherwise a
  // candidate like `../../other/file` is only rejected after realpath fails, so
  // the caller learns ENOENT (the file does not exist) instead of "outside the
  // workspace" (it is not yours to ask about) — an existence oracle for every
  // path on the machine, plus a raw absolute path in the error.
  assertInsideRoot(lexicalTarget, realRoot, {
    allowRoot: options.allowRoot === true,
    rejectBlocked: options.rejectBlocked !== false,
  });
  let realTarget;
  try {
    realTarget = await fs.realpath(lexicalTarget);
  } catch (error) {
    if (options.mustExist !== false || error?.code !== 'ENOENT') throw error;

    // Walk up to the nearest existing parent, then append the missing pieces
    // to that canonical parent. This also handles a new file below a symlink.
    const missing = [];
    let cursor = lexicalTarget;
    while (true) {
      try {
        const realParent = await fs.realpath(cursor);
        realTarget = missing.reduce((current, segment) => path.join(current, segment), realParent);
        break;
      } catch (parentError) {
        if (parentError?.code !== 'ENOENT') throw parentError;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw error;
        missing.unshift(path.basename(cursor));
        cursor = parent;
      }
    }
  }

  assertInsideRoot(realTarget, realRoot, {
    allowRoot: options.allowRoot === true,
    rejectBlocked: options.rejectBlocked !== false,
  });
  return { root: realRoot, path: realTarget };
}

/**
 * Resolve, canonicalize, security-check, and stat a file.
 * Returns a PreviewDescriptor including a fresh random token.
 */
async function describeFile(absolutePath, workspaceRoot) {
  let resolved;
  try { resolved = await resolveWorkspacePath(absolutePath, workspaceRoot); }
  // This string reaches the renderer as the body of a failed open, next to
  // Chinese UI text, and used to spell out an absolute path the user never
  // typed. Name the input instead.
  catch { throw new Error('无法在工作区内定位这个文件，它可能已被移动或删除'); }

  const stat = await fs.stat(resolved.path);
  if (!stat.isFile()) throw new Error('该路径不是文件');

  const kind  = kindForPath(resolved.path);
  const token = crypto.randomBytes(20).toString('hex');
  return {
    absolutePath: resolved.path,
    relativePath: path.relative(resolved.root, resolved.path),
    name:  path.basename(resolved.path),
    ext:   path.extname(resolved.path).toLowerCase(),
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
  let resolved;
  try {
    resolved = await resolveWorkspacePath(dirPath, workspaceRoot, { allowRoot: true });
  } catch {
    return null;
  }
  const real = resolved.path;
  const realRoot = resolved.root;
  let dirStat;
  try { dirStat = await fs.stat(real); } catch { return null; }
  if (!dirStat.isDirectory()) return null;

  const rel = path.relative(realRoot, real);
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

  // Static: already-built site. Canonicalize the selected index as well so a
  // symlinked build output cannot make the preview serve outside the workspace.
  let staticEntry = null;
  if (!recommendedScript) {
    const candidates = hasIndexHtml
      ? ['index.html']
      : hasDistIndex
        ? ['dist/index.html', 'build/index.html', 'out/index.html']
        : [];
    for (const candidate of candidates) {
      try {
        const entry = await resolveWorkspacePath(path.join(real, candidate), realRoot);
        const entryStat = await fs.stat(entry.path);
        if (entryStat.isFile()) { staticEntry = entry.path; break; }
      } catch { /* broken or unsafe candidate */ }
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

module.exports = { kindForPath, assertInsideRoot, resolveWorkspacePath, describeFile, inspectProject, BLOCKED_SEGMENTS };
