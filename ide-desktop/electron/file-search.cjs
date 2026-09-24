/*
 * Workspace fuzzy file search — ported from zcode's workspaceFileSearch
 * (packages/shared) plus a candidate walker that respects common ignore dirs.
 *
 * Scoring follows the upstream contract: prefix < substring < subsequence, ties
 * broken by index order, with a binary-insertion top-K so keystroke searches
 * stay O(n log K) instead of sorting the whole candidate list per key.
 */

const { readdir } = require('node:fs/promises');
const { join } = require('node:path');

const WORKSPACE_FILE_SEARCH_DISPLAY_CAP = 1000;
const MAX_CANDIDATES = 100_000;

// Directories that are never useful in a file quickpick; walking them wastes
// the candidate budget and floods results with vendored noise.
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next',
  '.cache', '.aicode', 'target', 'coverage', '__pycache__', '.venv', 'venv',
  '.gradle', '.idea', '.vs', '.zcode',
]);

function mapEntriesToCandidates(entries) {
  return entries.map((entry) => {
    const lowercaseRelativePath = entry.relativePath.trim().toLowerCase();
    return {
      id: entry.relativePath,
      name: entry.name,
      path: entry.path,
      relativePath: entry.relativePath,
      type: entry.type,
      lowercaseName: entry.name.trim().toLowerCase(),
      lowercaseRelativePath,
      lowercasePath: entry.path.trim().toLowerCase(),
    };
  });
}

function scoreNormalizedFuzzyMatch(normalizedText, normalizedQuery) {
  if (!normalizedText) return null;
  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }
  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }
  let score = 200;
  let searchStart = 0;
  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) return null;
    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }
  return score + (normalizedText.length - normalizedQuery.length);
}

function getCandidateScore(candidate, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return 0;
  const nameScore = scoreNormalizedFuzzyMatch(candidate.lowercaseName, normalizedQuery);
  const relativePathScore = scoreNormalizedFuzzyMatch(candidate.lowercaseRelativePath, normalizedQuery);
  const pathScore = scoreNormalizedFuzzyMatch(candidate.lowercasePath, normalizedQuery);
  // Keyword tier (+300) covers queries that hit across directory segments.
  const keywordScore = Math.min(
    relativePathScore !== null ? relativePathScore + 300 : Number.POSITIVE_INFINITY,
    pathScore !== null ? pathScore + 300 : Number.POSITIVE_INFINITY,
  );
  const bestScore = Math.min(
    nameScore ?? Number.POSITIVE_INFINITY,
    relativePathScore !== null ? relativePathScore + 25 : Number.POSITIVE_INFINITY,
    keywordScore,
  );
  return Number.isFinite(bestScore) ? bestScore : null;
}

function sortDefaultCandidates(candidates) {
  return candidates
    .map((candidate, index) => ({ candidate, index, priority: candidate.type === 'directory' ? 1 : 0 }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ candidate }) => candidate);
}

function compareScored(left, right) {
  if (left.score !== right.score) return left.score - right.score;
  if (left.index !== right.index) return left.index - right.index;
  return left.candidate.name.localeCompare(right.candidate.name);
}

function findInsertionIndex(bestMatches, scored) {
  let low = 0;
  let high = bestMatches.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareScored(scored, bestMatches[mid]) < 0) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low === bestMatches.length ? -1 : low;
}

function filterCandidates(candidates, query, options = {}) {
  const limit = options.limit ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
  const effectiveLimit = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : limit;
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    return options.requireQuery ? [] : sortDefaultCandidates(candidates).slice(0, effectiveLimit);
  }

  const bestMatches = [];
  for (const [index, candidate] of candidates.entries()) {
    const score = getCandidateScore(candidate, normalizedQuery);
    if (score === null) continue;
    const scored = { candidate, index, score };
    const worst = bestMatches[bestMatches.length - 1];
    if (worst !== undefined && bestMatches.length >= effectiveLimit && compareScored(scored, worst) >= 0) {
      continue;
    }
    const insertionIndex = findInsertionIndex(bestMatches, scored);
    if (insertionIndex === -1) {
      if (bestMatches.length < effectiveLimit) bestMatches.push(scored);
      continue;
    }
    bestMatches.splice(insertionIndex, 0, scored);
    if (bestMatches.length > effectiveLimit) bestMatches.pop();
  }
  return bestMatches.map(({ candidate }) => candidate);
}

// ---------------------------------------------------------------------------
// Candidate collection: recursive walk with ignore rules and a hard cap.
// ---------------------------------------------------------------------------

async function walkWorkspace(rootPath, relativePath = '') {
  const entries = [];
  let dirEntries;
  try {
    dirEntries = await readdir(relativePath ? join(rootPath, relativePath) : rootPath, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const dirEntry of dirEntries) {
    if (entries.length >= MAX_CANDIDATES) return entries;
    const name = dirEntry.name;
    if (relativePath === '' && name.startsWith('.')) continue;
    if (dirEntry.isDirectory()) {
      if (IGNORED_DIRS.has(name)) continue;
      const relativeChild = relativePath ? `${relativePath}/${name}` : name;
      entries.push({ name, path: join(rootPath, relativeChild), relativePath: relativeChild, type: 'directory' });
      entries.push(...await walkWorkspace(rootPath, relativeChild));
      continue;
    }
    if (!dirEntry.isFile() && !dirEntry.isSymbolicLink()) continue;
    const relativeChild = relativePath ? `${relativePath}/${name}` : name;
    entries.push({ name, path: join(rootPath, relativeChild), relativePath: relativeChild, type: 'file' });
  }
  return entries;
}

function createFileSearchService(options = {}) {
  const ttlMs = options.cacheTtlMs ?? 2000;
  let cache = { rootPath: null, builtAt: 0, candidates: [] };

  async function getCandidates(rootPath) {
    const now = Date.now();
    if (cache.rootPath === rootPath && now - cache.builtAt < ttlMs) {
      return cache.candidates;
    }
    const candidates = mapEntriesToCandidates(await walkWorkspace(rootPath));
    cache = { rootPath, builtAt: now, candidates };
    return candidates;
  }

  return {
    async search({ rootPath, query, limit, requireQuery }) {
      const candidates = await getCandidates(rootPath);
      const matches = filterCandidates(candidates, query ?? '', {
        limit: limit ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP,
        requireQuery: requireQuery === true,
      });
      return matches.map(({ name, path, relativePath, type }) => ({ name, path, relativePath, type }));
    },
    invalidate() {
      cache = { rootPath: null, builtAt: 0, candidates: [] };
    },
  };
}

module.exports = {
  WORKSPACE_FILE_SEARCH_DISPLAY_CAP,
  IGNORED_DIRS,
  mapEntriesToCandidates,
  getCandidateScore,
  filterCandidates,
  walkWorkspace,
  createFileSearchService,
};
