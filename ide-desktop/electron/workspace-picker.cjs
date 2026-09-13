const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle'];

async function defaultIsDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function defaultLooksLikeProject(target) {
  for (const marker of PROJECT_MARKERS) {
    try {
      await fs.stat(path.join(target, marker));
      return true;
    } catch {
      // Next marker.
    }
  }
  return false;
}

/**
 * Decide which directory becomes the workspace on startup restore.
 *
 * Rules (in order):
 *  1. The first recent workspace that exists AND looks like a project —
 *     these tools live and die by git_status / project_index, so a real repo
 *     always wins over a bare folder.
 *  2. The first recent that exists but is NOT the home directory — a user
 *     who explicitly opened a plain folder still gets it back.
 *  3. null → no usable workspace. The caller must NOT silently fall back to
 *     os.homedir(): rooting at the home directory made every git/workspace
 *     tool fatal and blew the 1000-file index cap on .cache/.android trees
 *     (audited 2026-09-13). Returning null instead asks the renderer to show
 *     the folder picker once.
 *
 * Pure and injectable so tests can drive it without touching the disk.
 */
async function selectWorkspaceCandidate(options) {
  const recents = Array.isArray(options.recents) ? options.recents : [];
  const isDirectory = options.isDirectory ?? defaultIsDirectory;
  const looksLikeProject = options.looksLikeProject ?? defaultLooksLikeProject;
  const home = options.home ?? os.homedir();
  const existing = [];
  for (const candidate of recents) {
    if (typeof candidate === 'string' && candidate.trim() && await isDirectory(candidate)) {
      existing.push(candidate);
    }
  }
  for (const candidate of existing) {
    if (await looksLikeProject(candidate)) return { root: candidate, reason: 'recent-project' };
  }
  for (const candidate of existing) {
    if (path.resolve(candidate) !== path.resolve(home)) return { root: candidate, reason: 'recent-plain' };
  }
  return { root: null, reason: 'none' };
}

module.exports = { selectWorkspaceCandidate, defaultLooksLikeProject, PROJECT_MARKERS };
