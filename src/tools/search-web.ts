import type { ToolDefinition } from './types.js';

/*
 * web_search — a governed, model-callable web search tool.
 *
 * It queries the DuckDuckGo HTML endpoint (no API key required) and parses the
 * result list into { title, url, snippet } entries so the model can pick a
 * source and follow up with fetch_url.
 *
 * Security: risk = 'network'. The tool constructs the exact search-endpoint URL
 * itself and exposes it as the validated `url`, so the registry's network gate
 * (host allowlist + SSRF guard) runs against the real target before execute().
 * duckduckgo.com is on the default allowlist. The user's query only becomes a
 * query-string parameter — no arbitrary host is ever contacted from here.
 */

const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';
const TIMEOUT_MS = 30_000;
const MAX_RESULTS = 10;

export const webSearchTool: ToolDefinition<{ query: string; url: string; limit: number }> = {
  name: 'web_search',
  description:
    'Search the web and return a ranked list of results (title, url, snippet). Use this to find sources when you do not already have a URL, then call fetch_url on a chosen result. Query the open web via DuckDuckGo; no API key needed.',
  inputHint: '{ "query": "python requests latest documentation", "limit": 5 }',
  risk: 'network',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.query !== 'string' || record.query.trim() === '') throw new Error('query is required');
    const query = record.query.trim();
    const limit = typeof record.limit === 'number' && record.limit > 0 ? Math.min(Math.floor(record.limit), MAX_RESULTS) : 5;
    // Expose the concrete endpoint URL so the network gate checks the real host.
    const url = `${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}`;
    return { query, url, limit };
  },
  async execute(input) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(input.url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/html',
          // DuckDuckGo's HTML endpoint expects a browser-like UA for the lite results page.
          'user-agent': 'Mozilla/5.0 (compatible; ZCodeAgent/1.0)',
        },
      });
      if (response.status >= 300 && response.status < 400) {
        return { ok: false, output: `Search endpoint redirected (HTTP ${response.status}); cannot complete search.`, data: { query: input.query, status: response.status } };
      }
      if (!response.ok) {
        return { ok: false, output: `Search failed: HTTP ${response.status} ${response.statusText}`, data: { query: input.query, status: response.status } };
      }
      const html = await response.text();
      const results = parseDuckDuckGoResults(html).slice(0, input.limit);
      if (results.length === 0) {
        return { ok: true, output: `No results found for: ${input.query}`, data: { query: input.query, results: [] } };
      }
      const rendered = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join('\n');
      return {
        ok: true,
        output: `Search results for "${input.query}":\n${rendered}`,
        data: { query: input.query, results },
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        output: aborted ? `Search timed out after ${TIMEOUT_MS / 1000}s: ${input.query}` : `Search failed: ${error instanceof Error ? error.message : String(error)}`,
        data: { query: input.query },
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

type SearchResult = { title: string; url: string; snippet: string };

// Parse the DuckDuckGo HTML result list. Result anchors carry class
// "result__a" and the real URL is wrapped in a redirect (l/?uddg=<encoded>).
// Snippets carry class "result__snippet". Dependency-free regex extraction.
export function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  for (const match of html.matchAll(snippetRe)) {
    snippets.push(stripTags(match[1]));
  }
  let index = 0;
  for (const match of html.matchAll(anchorRe)) {
    const url = decodeResultUrl(match[1]);
    const title = stripTags(match[2]);
    if (!url || !title) {
      index += 1;
      continue;
    }
    results.push({ title, url, snippet: snippets[index] ?? '' });
    index += 1;
  }
  return results;
}

// DuckDuckGo wraps target URLs as //duckduckgo.com/l/?uddg=<encoded>&... —
// pull out and decode the uddg parameter. Falls back to the raw href.
function decodeResultUrl(href: string): string {
  const uddg = href.match(/[?&]uddg=([^&]+)/);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      return href;
    }
  }
  if (href.startsWith('//')) return `https:${href}`;
  return href;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
