/**
 * Proxy-aware fetch for every outbound request the tools make.
 *
 * Why this exists: `fetch()` in Node ignores HTTPS_PROXY / HTTP_PROXY (undici
 * only honours them under `--use-env-proxy`, Node 24+, and the desktop spawns
 * us without it). Every web tool therefore went direct and died with
 * `UND_ERR_CONNECT_TIMEOUT` on machines that need a proxy to get out — while
 * the very same URL fetched fine through curl. `netFetch` resolves the proxy
 * (see utils/proxy.ts) and routes the request through undici's ProxyAgent.
 *
 * undici is loaded lazily: the CLI must not pay for a second HTTP stack on
 * startup when most sessions never touch the network.
 */
import type { Dispatcher } from 'undici';
import { describeEnvProxy, resolveProxy, type ResolvedProxy } from './proxy.js';

type UndiciModule = typeof import('undici');
type UndiciRequestInit = import('undici').RequestInit;

let undiciModule: UndiciModule | null = null;
async function loadUndici(): Promise<UndiciModule> {
  if (!undiciModule) undiciModule = await import('undici');
  return undiciModule;
}

/** One dispatcher per proxy endpoint — keep-alive connections are reused. */
const dispatchers = new Map<string, Dispatcher>();

/** `network.proxy` from the config file: the settings fallback, set once at startup. */
let proxyFallback: string | null = null;

/** Record the settings-level proxy (`network.proxy`). Env variables still win. */
export function configureNetworkProxy(proxy: string | null | undefined): void {
  proxyFallback = proxy?.trim() ? proxy.trim() : null;
}

export function configuredProxyFallback(): string | null {
  return proxyFallback;
}

/** Which proxy a request to `url` would use right now (for diagnostics/tests). */
export function proxyFor(url: string): ResolvedProxy | null {
  return resolveProxy(url, process.env, proxyFallback);
}

async function dispatcherFor(proxy: string): Promise<Dispatcher> {
  const existing = dispatchers.get(proxy);
  if (existing) return existing;
  const undici = await loadUndici();
  const agent = new undici.ProxyAgent(proxy);
  dispatchers.set(proxy, agent);
  return agent;
}

/**
 * fetch(), but through the proxy the environment/settings ask for.
 *
 * `init` accepts the global RequestInit as well as undici's: @types/node ships
 * its own copy of the fetch types (undici-types) with a FormData that is not
 * the FormData undici's package declares, so callers typed against the global
 * one could not be passed straight through.
 *
 * The return type is the global `Response` so existing call sites keep working;
 * undici's Response is the very object Node's fetch hands back, the types just
 * live in a different package.
 */
export async function netFetch(url: string, init: RequestInit | UndiciRequestInit = {}): Promise<Response> {
  const proxy = resolveProxy(url, process.env, proxyFallback);
  // No proxy → the global fetch. It is the same undici inside Node, it keeps
  // the undici module out of the startup path, and it keeps
  // `globalThis.fetch = stub` working for tests and for embedders.
  if (!proxy) return globalThis.fetch(url, init as RequestInit);
  const undici = await loadUndici();
  const options = { ...init } as unknown as UndiciRequestInit;
  options.dispatcher = await dispatcherFor(proxy.url);
  return (await undici.fetch(url, options)) as unknown as Response;
}

/** Tear down keep-alive sockets (tests, and a clean exit path). */
export async function closeNetworkAgents(): Promise<void> {
  const agents = [...dispatchers.values()];
  dispatchers.clear();
  await Promise.all(agents.map((agent) => agent.close().catch(() => {})));
}

/**
 * Turn a fetch failure into something a user can act on.
 *
 * `fetch failed` on its own is the least useful error in Node: the real code
 * hides in `error.cause`, and the fix (configure a proxy) is never hinted at.
 */
export function explainNetworkFailure(error: unknown, url: string): string {
  const err = error as { message?: string; code?: string; cause?: { message?: string; code?: string; errors?: Array<{ code?: string; message?: string }> } } | undefined;
  const cause = err?.cause;
  const nested = Array.isArray(cause?.errors) ? cause.errors : [];
  const code = err?.code ?? cause?.code ?? nested[0]?.code ?? '';
  const detail = cause?.message ?? nested[0]?.message ?? err?.message ?? String(error);

  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = url;
  }

  const proxy = resolveProxy(url, process.env, proxyFallback);
  const envProxy = describeEnvProxy(process.env);
  const viaProxy = proxy
    ? `it went through the proxy ${proxy.url} (${proxy.source === 'settings' ? 'network.proxy in config' : proxy.source})`
    : envProxy
      ? `no proxy was used (${envProxy})`
      : 'no proxy is configured for this process';

  const hintFor = (kind: string): string => {
    if (kind === 'proxy') {
      return `${viaProxy}. Check that the proxy is running and that its rules let ${host} through; set AICODE_PROXY=off for a direct connection.`;
    }
    if (kind === 'dns') {
      return `${viaProxy}. The host name did not resolve — check DNS, and if this machine only reaches the internet through a proxy, set AICODE_PROXY (or HTTPS_PROXY) so the lookup happens at the proxy.`;
    }
    return `${viaProxy}. If this machine only reaches the internet through a proxy, set AICODE_PROXY=http://host:port (or HTTPS_PROXY), or "network.proxy" in .aicode/config.json.`;
  };

  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|timeout/i.test(`${code} ${detail}`)) {
    return `connect timed out talking to ${host} (${code || 'timeout'}: ${detail}). ${hintFor(proxy ? 'proxy' : 'direct')}`;
  }
  if (/ECONNREFUSED/i.test(`${code} ${detail}`)) {
    return `connection refused by ${host} (ECONNREFUSED). ${hintFor('direct')}`;
  }
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH/i.test(`${code} ${detail}`)) {
    return `cannot reach ${host} (${code}: ${detail}). ${hintFor('dns')}`;
  }
  if (/self.signed|CERT_|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(`${code} ${detail}`)) {
    return `TLS certificate rejected for ${host} (${code || detail}). ${hintFor(proxy ? 'proxy' : 'direct')}`;
  }
  return `${code ? `${code}: ` : ''}${detail}. ${hintFor(proxy ? 'proxy' : 'direct')}`;
}
