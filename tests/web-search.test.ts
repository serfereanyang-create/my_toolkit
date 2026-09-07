import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDuckDuckGoResults, webSearchTool } from '../src/tools/search-web.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

// A trimmed sample of the DuckDuckGo HTML result markup.
const SAMPLE_HTML = `
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frequests.readthedocs.io%2Fen%2Flatest%2F&rut=x">Requests: HTTP for Humans</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frequests.readthedocs.io%2F">Requests is an elegant and simple HTTP library for Python.</a>
</div>
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpypi.org%2Fproject%2Frequests%2F&rut=y">requests · PyPI</a>
  <a class="result__snippet" href="#">Python HTTP for Humans.</a>
</div>
`;

test('parseDuckDuckGoResults extracts title, decoded url, and snippet', () => {
  const results = parseDuckDuckGoResults(SAMPLE_HTML);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'Requests: HTTP for Humans');
  assert.equal(results[0].url, 'https://requests.readthedocs.io/en/latest/');
  assert.match(results[0].snippet, /HTTP library for Python/);
  assert.equal(results[1].url, 'https://pypi.org/project/requests/');
});

test('web_search validate builds the search endpoint url and clamps limit', () => {
  const parsed = webSearchTool.validate({ query: 'python requests docs', limit: 99 });
  assert.match(parsed.url, /^https:\/\/html\.duckduckgo\.com\/html\/\?q=/);
  assert.match(parsed.url, /python%20requests%20docs/);
  assert.equal(parsed.limit, 10); // clamped to MAX_RESULTS
});

test('web_search validate rejects an empty query', () => {
  assert.throws(() => webSearchTool.validate({ query: '  ' }), /query is required/);
});

test('web_search is gated by the network allowlist (denied when host not allowed)', async () => {
  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    'web_search',
    { query: 'anything' },
    { workspaceRoot: process.cwd(), approval: 'auto', networkAllowlist: ['example.com'] },
  );
  // duckduckgo.com is not in this restricted allowlist → blocked before any fetch.
  assert.equal(result.ok, false);
  assert.match(result.output, /blocked|allowlist/i);
});
