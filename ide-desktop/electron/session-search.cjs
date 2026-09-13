// Iteration 16 — cross-session transcript search (main process).
//
// Finds sessions whose messages contain a phrase, ranked by recency and hit
// count. Reuses the same skip/binary rules as the workspace scanner but walks
// .aicode/sessions JSON records instead of source files: for each session it
// scans user/assistant messages, extracts ±1 context lines around the hit
// (messages are stored one logical line each; long ones are wrapped into
// display lines at match time so previews stay narrow).
//
// Safety: session ids are file names — the listing step already whitelists
// *.json in the sessions dir, and results only ever expose the derived id,
// never a path the renderer can feed back into fs APIs unchecked.

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_MESSAGE_CHARS = 400_000; // per-message scan cap; giant blobs skipped
const MAX_SESSIONS_SCANNED = 500;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSessionMatcher(query, options) {
  const source = options.regex ? String(query) : escapeRegExp(String(query));
  if (options.regex) {
    try { new RegExp(source); } catch (error) {
      const wrapped = new Error(`无效的正则表达式：${error.message}`);
      wrapped.code = 'BAD_REGEX';
      throw wrapped;
    }
  }
  const pattern = options.wholeWord ? `\\b(?:${source})\\b` : source;
  return new RegExp(pattern, options.caseSensitive ? 'g' : 'gi');
}

/** One display line around a match, with match bounds for highlighting. */
function extractMatches(content, matcher, options, maxHitsPerMessage) {
  const hits = [];
  matcher.lastIndex = 0;
  let match;
  const lines = content.split('\n');
  const context = options.context === undefined ? 1 : options.context;
  const matchedLines = new Set();
  while ((match = matcher.exec(content)) !== null) {
    // Locate the source line for this byte offset.
    let lineNo = 0;
    let consumed = 0;
    for (let li = 0; li < lines.length; li += 1) {
      const next = consumed + lines[li].length + 1;
      if (match.index < next) { lineNo = li; break; }
      consumed = next;
    }
    if (!matchedLines.has(lineNo)) {
      matchedLines.add(lineNo);
      const from = Math.max(0, lineNo - context);
      const to = Math.min(lines.length - 1, lineNo + context);
      hits.push({
        roleOffsetLine: lineNo + 1,
        matchedText: match[0],
        context: lines.slice(from, to + 1).map((text, ci) => ({
          line: from + ci + 1,
          text: text.length > 320 ? text.slice(0, 320) + '…' : text,
          matched: from + ci === lineNo,
        })),
      });
      if (hits.length >= maxHitsPerMessage) break;
    }
    if (match[0].length === 0) matcher.lastIndex += 1; // zero-width guard
  }
  return hits;
}

/**
 * Search every session transcript for `query`.
 *
 * @param {string} sessionsDir  absolute .aicode/sessions directory
 * @param {string} query
 * @param {object} options { caseSensitive, wholeWord, regex, maxResults,
 *                           context, roles: ['user','assistant',...] }
 */
async function searchSessions(sessionsDir, query, options = {}) {
  const started = Date.now();
  const maxResults = Math.min(Math.max(1, options.maxResults || 80), 500);
  const allowedRoles = new Set(options.roles && options.roles.length
    ? options.roles
    : ['user', 'assistant']);
  const matcher = buildSessionMatcher(String(query || ''), options);
  let entries;
  try {
    entries = await fs.readdir(sessionsDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { results: [], sessionsScanned: 0, elapsedMs: 0 };
    throw error;
  }
  const files = entries.filter((name) => name.endsWith('.json') && !name.startsWith('.'));
  const results = [];
  let scanned = 0;
  let truncated = false;
  let corrupted = 0;

  for (const name of files.slice(0, MAX_SESSIONS_SCANNED)) {
    const id = name.replace(/\.json$/, '');
    let record;
    try {
      record = JSON.parse(await fs.readFile(path.join(sessionsDir, name), 'utf8'));
    } catch {
      corrupted += 1;
      continue;
    }
    scanned += 1;
    const messages = Array.isArray(record.messages) ? record.messages : [];
    const sessionHits = [];
    for (let mi = 0; mi < messages.length; mi += 1) {
      const message = messages[mi];
      if (!message || typeof message.content !== 'string') continue;
      if (!allowedRoles.has(message.role)) continue;
      if (message.content.length > MAX_MESSAGE_CHARS) continue;
      const hits = extractMatches(message.content, matcher, options, 6);
      for (const hit of hits) {
        sessionHits.push({
          messageIndex: mi,
          role: message.role,
          createdAt: message.createdAt || record.updatedAt || '',
          ...hit,
        });
      }
    }
    if (!sessionHits.length) continue;
    results.push({
      sessionId: id,
      updatedAt: record.updatedAt || record.createdAt || '',
      model: record.model || '',
      hitCount: sessionHits.length,
      hits: sessionHits.slice(0, 12),
    });
    if (results.length >= maxResults) { truncated = true; break; }
  }

  // Rank: hit count desc, then recency desc — the session you were just in
  // with most matches tops the list.
  results.sort((a, b) => b.hitCount - a.hitCount || String(b.updatedAt).localeCompare(String(a.updatedAt)));

  return {
    query: String(query || ''),
    options: {
      caseSensitive: Boolean(options.caseSensitive),
      wholeWord: Boolean(options.wholeWord),
      regex: Boolean(options.regex),
      roles: [...allowedRoles],
    },
    results,
    sessionsScanned: scanned,
    corrupted,
    truncated,
    elapsedMs: Date.now() - started,
  };
}

module.exports = { searchSessions };
