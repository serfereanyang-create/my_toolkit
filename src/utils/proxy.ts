/**
 * Outbound HTTP(S) proxy resolution.
 *
 * Node's global fetch does NOT read HTTPS_PROXY / HTTP_PROXY: undici only looks
 * at the environment when node itself was started with `--use-env-proxy`, and
 * that flag is Node 24+. The desktop app spawns this CLI as a plain
 * `node dist/src/index.js`, so on a machine that only reaches the internet
 * through a proxy (Clash, a corporate gateway) every web tool failed with
 * `fetch failed: UND_ERR_CONNECT_TIMEOUT` while curl worked fine.
 *
 * So we resolve the proxy ourselves and hand undici a dispatcher (see
 * utils/net.ts). Precedence, highest first:
 *
 *   1. AICODE_PROXY               — what the desktop injects from its settings
 *   2. HTTPS_PROXY / https_proxy
 *   3. HTTP_PROXY  / http_proxy
 *   4. ALL_PROXY   / all_proxy
 *   5. `network.proxy` in .aicode/config.json (settings fallback, supplied by
 *      the caller through the `fallback` argument)
 *
 * NO_PROXY / no_proxy always wins for the hosts it names, and a value of
 * `off` / `none` / `direct` in ANY variable means "no proxy" — explicit beats
 * inherited, so a shell that exports HTTPS_PROXY globally can still run the CLI
 * direct.
 */

export type ProxySource = 'AICODE_PROXY' | 'HTTPS_PROXY' | 'HTTP_PROXY' | 'ALL_PROXY' | 'settings';

export type ResolvedProxy = {
  /** Proxy endpoint, always with a scheme, e.g. http://127.0.0.1:7897 */
  url: string;
  /** Which knob said so — shown in tool errors so the user can find it. */
  source: ProxySource;
};

const DIRECT_WORDS = new Set(['off', 'none', 'direct', 'no', 'false', '0']);

/**
 * Normalise a proxy string into something undici's ProxyAgent accepts.
 * Returns null for junk or for a scheme we cannot proxy (socks5:// is common in
 * v2ray-style tools but undici has no SOCKS connector — better to say nothing
 * than to fail every request with an opaque error).
 */
export function normalizeProxyUrl(raw: string | undefined | null): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (DIRECT_WORDS.has(value.toLowerCase())) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url.href.replace(/\/+$/, '');
}

function isDirectWord(raw: string | undefined | null): boolean {
  return DIRECT_WORDS.has((raw ?? '').trim().toLowerCase());
}

/** The env knob that supplied the proxy, in precedence order. */
const ENV_ORDER: Array<{ names: string[]; source: ProxySource }> = [
  { names: ['AICODE_PROXY', 'aicode_proxy'], source: 'AICODE_PROXY' },
  { names: ['HTTPS_PROXY', 'https_proxy'], source: 'HTTPS_PROXY' },
  { names: ['HTTP_PROXY', 'http_proxy'], source: 'HTTP_PROXY' },
  { names: ['ALL_PROXY', 'all_proxy'], source: 'ALL_PROXY' },
];

/**
 * Read the proxy out of the environment alone. `off`/`none` anywhere in the
 * chain short-circuits to null so an explicit "direct" is respected.
 */
export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedProxy | null {
  for (const { names, source } of ENV_ORDER) {
    for (const name of names) {
      const raw = env[name];
      if (!raw || !raw.trim()) continue;
      if (isDirectWord(raw)) return null;
      const url = normalizeProxyUrl(raw);
      // Present but unusable (a socks:// value, a typo): keep walking? No — a
      // set-but-broken variable is a mistake the user should see, and silently
      // falling through to the next one hides it. Treat it as "no proxy" but
      // let the caller learn about it through describeEnvProxy().
      if (url) return { url, source };
      return { url: '', source };
    }
  }
  return null;
}

/** True when any proxy variable says "direct" — an explicit choice wins. */
export function envSaysDirect(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const { names } of ENV_ORDER) {
    for (const name of names) {
      const raw = env[name];
      if (raw && isDirectWord(raw)) return true;
    }
  }
  return false;
}

/** Human-readable state of the environment proxy, for error messages. */
export function describeEnvProxy(env: NodeJS.ProcessEnv = process.env): string {
  for (const { names } of ENV_ORDER) {
    for (const name of names) {
      const raw = env[name];
      if (!raw || !raw.trim()) continue;
      if (isDirectWord(raw)) return `${name}=${raw} (direct, proxy disabled)`;
      if (!normalizeProxyUrl(raw)) return `${name}=${raw} (unusable — only http:// and https:// proxies are supported)`;
      return `${name}=${normalizeProxyUrl(raw)}`;
    }
  }
  return '';
}

/**
 * NO_PROXY matching. Accepts the shapes people actually write:
 *   *                    → everything bypasses the proxy
 *   .corp.example        → corp.example and its subdomains
 *   example.com:8080     → that host+port only
 *   127.0.0.1,localhost  → comma (or space) separated list
 * CIDR ranges are not supported — they are not portable in NO_PROXY anyway.
 */
export function hostBypassesProxy(host: string, noProxy: string | undefined, port?: string): boolean {
  const list = (noProxy ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return false;
  const target = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  for (const entry of list) {
    if (entry === '*') return true;
    // IPv6 with brackets, or host:port.
    const bare = entry.replace(/^\[|\]$/g, '');
    const hasPort = /:\d+$/.test(bare) && !/^[0-9a-f:]+$/i.test(bare);
    const entryHost = hasPort ? bare.replace(/:\d+$/, '') : bare;
    const entryPort = hasPort ? bare.replace(/^.*:(\d+)$/, '$1') : undefined;
    if (entryPort && port && entryPort !== port) continue;
    const suffix = entryHost.replace(/^\./, '').replace(/^\*\./, '');
    if (!suffix) continue;
    if (target === suffix || target.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

/**
 * Resolve the proxy to use for one target URL.
 *
 * `fallback` is the settings value (`network.proxy`), used only when no
 * environment variable speaks. Returns null when the request should go direct.
 */
export function resolveProxy(
  target: string | URL,
  env: NodeJS.ProcessEnv = process.env,
  fallback?: string | null,
): ResolvedProxy | null {
  // `AICODE_PROXY=off` (or any "direct" word) must not be overridden by the
  // settings value: the environment is the more explicit statement.
  if (envSaysDirect(env)) return null;
  const fromEnv = proxyFromEnv(env);
  let resolved: ResolvedProxy | null = fromEnv && fromEnv.url ? fromEnv : null;
  if (!resolved) {
    // A set-but-unusable env value is NOT overridden by settings: the user's
    // environment is the more explicit statement, and silently substituting a
    // different proxy would be worse than the clear error.
    if (fromEnv) return null;
    const url = normalizeProxyUrl(fallback);
    if (url) resolved = { url, source: 'settings' };
  }
  if (!resolved) return null;

  let host = '';
  let port: string | undefined;
  try {
    const parsed = target instanceof URL ? target : new URL(String(target));
    host = parsed.hostname;
    port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  } catch {
    return resolved; // unparseable target: let fetch report it, proxy choice is moot
  }
  if (hostBypassesProxy(host, env.NO_PROXY ?? env.no_proxy, port)) return null;
  // Loopback never goes through the proxy: a local dev server is not something
  // the proxy could reach even if it wanted to.
  if (/^(localhost|127(\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/i.test(host)) return null;
  return resolved;
}
