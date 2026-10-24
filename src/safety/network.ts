/**
 * Outbound-network verdicts, shared by the tool gateway and the shell analyser.
 *
 * These lived in policy.ts. They moved here because `commandAnalysis.ts` needs
 * them too (a `curl` inside `run_command` must answer to the same allowlist as
 * `fetch_url`), and policy.ts already imports the analyser — importing back
 * would be a cycle. policy.ts re-exports them, so existing call sites are
 * unchanged.
 */

export type NetworkVerdict = { ok: boolean; host?: string; reason: string };

/**
 * Decide whether an outbound request may leave the machine.
 *
 *   1. Only http(s). Arbitrary schemes reach OS handlers and other protocols.
 *   2. Host must not be a private / loopback / link-local literal (SSRF guard).
 *      Literal IPs are checked directly; hostnames are checked for the obvious
 *      localhost forms. DNS is NOT resolved here (that happens at fetch time),
 *      so this blocks the blatant cases without a network round-trip.
 *   3. Host must match the allowlist (exact host or a parent domain suffix).
 */
export function evaluateNetworkTarget(rawUrl: string, allowlist: string[]): NetworkVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `unsupported protocol ${url.protocol}` };
  }
  const host = url.hostname.toLowerCase();
  if (isBlockedNetworkHost(host)) {
    return { ok: false, host, reason: 'target resolves to a private or loopback address (SSRF blocked)' };
  }
  if (!hostMatchesAllowlist(host, allowlist)) {
    return { ok: false, host, reason: 'host is not in the network allowlist' };
  }
  return { ok: true, host, reason: 'host is in the network allowlist' };
}

/**
 * Block loopback, private, link-local, and other non-public literal addresses,
 * plus localhost hostnames. Best-effort SSRF guard against literal targets;
 * DNS-based rebinding is out of scope for a pre-flight check.
 */
export function isBlockedNetworkHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '') return true;
  // Strip IPv6 brackets if present.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  // IPv6 loopback / unique-local / link-local.
  if (bare === '::1' || bare === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(bare)) return true; // fc00::/7 unique local
  if (/^fe80:/i.test(bare)) return true; // link-local
  // IPv4 literal checks.
  const v4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1, 5).map((n) => Number(n));
    if (octets.some((n) => n > 255)) return true; // malformed → block
    const [a, b] = octets;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  }
  return false;
}

// A host matches when it equals an allowlist entry or is a subdomain of one.
// Entries are compared case-insensitively; a leading dot is tolerated.
export function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase().replace(/^\./, '');
    if (!entry) continue;
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}
