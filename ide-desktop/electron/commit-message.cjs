/*
 * Heuristic commit message generator — offline companion to zcode's
 * gitCommitMessageGenerator. Upstream asks a model for a conventional-commit
 * message and validates the shape with its regex; without a model we derive
 * the same shape from the diff itself: type from changed paths/kinds, scope
 * from the common top-level segment, subject from the change shape.
 */

const CONVENTIONAL_SUBJECT_PATTERN = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .{1,100}$/;

const CI_PATHS = ['.github', 'jenkinsfile', '.gitlab-ci.yml', '.cirrus.yml'];
const BUILD_PATHS = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'webpack.config.js', 'vite.config.ts', 'tsconfig.json', 'makefile', 'cmakelists.txt'];

function normalize(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.?\//, '');
}

function classifyKind(file) {
  const path = normalize(file.repoRelativePath ?? file.path ?? '').toLowerCase();
  const segments = path.split('/');
  if (CI_PATHS.some((marker) => path.includes(marker.toLowerCase()))) return 'ci';
  if (BUILD_PATHS.some((marker) => segments[segments.length - 1] === marker || segments[0] === marker)) return 'build';
  if (segments.includes('__tests__') || path.includes('.test.') || path.includes('.spec.') || segments[0] === 'test' || segments[0] === 'tests') return 'test';
  if (segments[0] === 'docs' || path.endsWith('.md')) return 'docs';
  if (file.kind === 'deleted') return 'chore';
  if (file.kind === 'added') return 'feat';
  if ((file.added ?? 0) > 0 && (file.removed ?? 0) > 0) return 'refactor';
  if ((file.added ?? 0) > 0) return 'feat';
  return 'fix';
}

function commonScopeOf(files) {
  const segmentSets = files.map((file) => normalize(file.repoRelativePath ?? file.path ?? '').split('/').slice(0, -1));
  if (segmentSets.length === 0) return null;
  let common = segmentSets[0];
  for (const segments of segmentSets.slice(1)) {
    common = common.filter((segment, index) => segments[index] === segment);
    if (common.length === 0) return null;
  }
  if (common.length === 0) return null;
  // The full common path is the scope: src/agent for both src/agent/a.ts and
  // src/agent/b.ts — conventional scopes read best at the deepest shared dir.
  return common.join('/');
}

/**
 * files: [{ kind, path, repoRelativePath, added, removed }] as produced by the
 * checkpoint diff / git diff --name-status + --numstat.
 */
function generateHeuristicCommitMessage(params = {}) {
  const files = params.files ?? [];
  if (files.length === 0) {
    return { subject: 'chore: no changes', body: '', full: 'chore: no changes', type: 'chore', scope: null };
  }

  const kindCounts = new Map();
  for (const file of files) {
    const kind = classifyKind(file);
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const dominantType = [...kindCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const overrideType = params.type;
  const type = CONVENTIONAL_SUBJECT_PATTERN.test(`${overrideType}: x`) ? overrideType : dominantType;

  const scopeCandidates = files.map((file) => normalize(file.workspaceRelativePath ?? file.repoRelativePath ?? ''));
  const scope = (params.scope ?? commonScopeOf(files))?.replace(/[^A-Za-z0-9/_-]/g, '') || null;
  const scopePart = scope ? `(${scope})` : '';

  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  const addedCount = files.filter((file) => file.kind === 'added').length;
  const deletedCount = files.filter((file) => file.kind === 'deleted').length;

  let subject;
  if (addedCount > 0 && addedCount === files.length) {
    subject = `${type}${scopePart}: add ${files.length} file${files.length === 1 ? '' : 's'}`;
  } else if (deletedCount > 0 && deletedCount === files.length) {
    subject = `${type}${scopePart}: remove ${files.length} file${files.length === 1 ? '' : 's'}`;
  } else {
    subject = `${type}${scopePart}: update ${files.length} file${files.length === 1 ? '' : 's'}`;
  }
  if (!CONVENTIONAL_SUBJECT_PATTERN.test(subject)) {
    subject = `${type}: update ${files.length} files`.slice(0, 100);
  }

  const bodyLines = files
    .slice(0, 10)
    .map((file) => `- ${normalize(file.workspaceRelativePath ?? file.repoRelativePath ?? file.path)} (+${file.added ?? 0}/-${file.removed ?? 0})`);
  if (files.length > 10) bodyLines.push(`- … and ${files.length - 10} more`);
  bodyLines.push(``, `Total: +${added}/-${removed} across ${files.length} file${files.length === 1 ? '' : 's'}.`);
  const body = bodyLines.join('\n');

  return { subject, body, full: `${subject}\n\n${body}`, type, scope, kindCounts: Object.fromEntries(kindCounts) };
}

module.exports = { generateHeuristicCommitMessage, classifyKind, commonScopeOf, CONVENTIONAL_SUBJECT_PATTERN };
