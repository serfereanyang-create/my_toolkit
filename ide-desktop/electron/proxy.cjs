/*
 * Outbound proxy for the whole app: the Chromium side (app window, preview
 * pane, background browser) and the CLI child process.
 *
 * Why it lives in the main process and runs before `app.whenReady()`:
 *
 *   - Chromium only reads `--proxy-server` at network-service startup, so the
 *     switch has to be appended before the first window (hence before ready).
 *   - The agent bridge spawns the CLI with `{...process.env}`, so putting the
 *     resolved proxy into `process.env.AICODE_PROXY` is all it takes for the
 *     CLI's web tools to use the same route (see cli/src/utils/proxy.ts).
 *
 * A machine behind Clash / a corporate gateway had every "联网" channel fail:
 * `web_search` → `fetch failed`, `fetch_url` → blocked host, and the background
 * browser → ERR_CONNECTION_TIMED_OUT, because nothing in the app ever told
 * Chromium or Node about the proxy sitting at 127.0.0.1:7897.
 *
 * Precedence matches the CLI exactly: AICODE_PROXY, then HTTPS_PROXY, then
 * HTTP_PROXY, then ALL_PROXY, then `network.proxy` from settings.json. NO_PROXY
 * is honoured, and `off`/`none`/`direct` in any variable means "no proxy".
 */

const fs = require('node:fs');
const path = require('node:path');

const DIRECT_WORDS = new Set(['off', 'none', 'direct', 'no', 'false', '0']);

const ENV_ORDER = [
  ['AICODE_PROXY', 'aicode_proxy'],
  ['HTTPS_PROXY', 'https_proxy'],
  ['HTTP_PROXY', 'http_proxy'],
  ['ALL_PROXY', 'all_proxy'],
];

// Loopback must never go through the proxy: the preview pane and the app's own
// local servers live there, and routing them through a remote proxy breaks them.
const LOCAL_BYPASS = ['<local>', '127.0.0.1', 'localhost', '[::1]'];

/** `127.0.0.1:7897`, `http://127.0.0.1:7897/` → `http://127.0.0.1:7897`. */
function normalizeProxyUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (DIRECT_WORDS.has(value.toLowerCase())) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url.href.replace(/\/+$/, '');
}

function proxyFromEnv(env) {
  for (const [name, lower] of ENV_ORDER) {
    const raw = env[name] ?? env[lower];
    if (raw === undefined || String(raw).trim() === '') continue;
    if (DIRECT_WORDS.has(String(raw).trim().toLowerCase())) return null;
    const url = normalizeProxyUrl(raw);
    return url ? { url, source: name } : null;
  }
  return null;
}

/** `network.proxy` in ~/.config/<app>/settings.json — the settings fallback. */
function proxyFromSettings(userDataDir) {
  if (!userDataDir) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'));
    const url = normalizeProxyUrl(parsed?.network?.proxy);
    return url ? { url, source: 'settings.network.proxy' } : null;
  } catch {
    return null; // no settings file, or unreadable: env is all we have
  }
}

/** `--proxy-bypass-list` / proxyBypassRules value: loopback + NO_PROXY entries. */
function bypassRules(env = process.env) {
  const entries = [...LOCAL_BYPASS];
  for (const raw of String(env.NO_PROXY ?? env.no_proxy ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    // Chromium wants `*.example.com`, NO_PROXY settles for `.example.com`.
    entries.push(entry.startsWith('.') ? `*${entry}` : entry);
  }
  return entries.join(';');
}

/** Chromium per-scheme rules for an http:// proxy endpoint: `http=h:p;https=h:p`. */
function proxyRulesFor(url) {
  const parsed = new URL(url);
  const hostPort = `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  return { hostPort, proxyRules: `http=${hostPort};https=${hostPort}` };
}

let state = { url: null, source: null, hostPort: null, proxyRules: null, bypassRules: bypassRules() };

function getProxyState() {
  return { ...state };
}

/**
 * Resolve the proxy and apply it to Chromium. MUST run before `app.whenReady()`
 * resolves and before any BrowserWindow/session is created.
 */
function applyEarly(app, options = {}) {
  const env = options.env ?? process.env;
  const userDataDir = options.userDataDir ?? (app && app.getPath ? app.getPath('userData') : null);
  const resolved = proxyFromEnv(env) ?? proxyFromSettings(userDataDir);
  const bypass = bypassRules(env);
  if (!resolved) {
    state = { url: null, source: null, hostPort: null, proxyRules: null, bypassRules: bypass };
    return getProxyState();
  }
  const { hostPort, proxyRules } = proxyRulesFor(resolved.url);
  state = { url: resolved.url, source: resolved.source, hostPort, proxyRules, bypassRules: bypass };
  if (app && app.commandLine) {
    app.commandLine.appendSwitch('proxy-server', `http://${hostPort}`);
    app.commandLine.appendSwitch('proxy-bypass-list', bypass);
  }
  // The CLI child inherits process.env, so one assignment covers
  // web_search / fetch_url / download_file / the shell it spawns.
  env.AICODE_PROXY = resolved.url;
  return getProxyState();
}

/**
 * Explicit per-session proxy. The command-line switch covers every session the
 * process creates, but a `memory:` partition for the background browser is its
 * own network context — set it there too so the hidden browser cannot silently
 * fall back to a direct connection.
 */
function applyToSession(ses, options = {}) {
  if (!ses || typeof ses.setProxy !== 'function') return Promise.resolve();
  const current = options.state ?? state;
  if (!current.proxyRules) {
    return ses.setProxy({ mode: 'system' }).catch(() => {});
  }
  return ses
    .setProxy({ mode: 'fixed_servers', proxyRules: current.proxyRules, proxyBypassRules: current.bypassRules })
    .catch(() => {
      /* A refused session proxy must not take the app down; the global switch stands. */
    });
}

module.exports = {
  applyEarly,
  applyToSession,
  bypassRules,
  getProxyState,
  normalizeProxyUrl,
  proxyFromEnv,
  proxyFromSettings,
};
