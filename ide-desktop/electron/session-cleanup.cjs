/*
 * Empty-session analysis and cleanup — backend for the approved session
 * cleanup plan.
 *
 * Rules (from the plan): only sessions with NO user message containing any
 * non-empty text are cleanup candidates; pinned sessions are always kept;
 * files that fail to parse are kept; nothing is deleted implicitly — callers
 * must pass explicit ids after showing the numbers to the user.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const OVERLAY_FILE = '.desktop-meta.json';

/**
 * Pins and titles for the sessions in `sessionsDir`.
 *
 * Both live in the desktop's sidecar overlay, NOT in the session record: a
 * `pinned` field inside a session JSON is only what the CLI's own `pin` command
 * writes, while the sidebar's pin goes to `.desktop-meta.json`. Reading the
 * record alone made every chat pinned in the sidebar look unpinned here, so a
 * pinned-but-unused conversation was reported as an empty-session candidate and
 * the cleanup deleted the very chat the user had pinned to keep — along with its
 * custom title. A sidecar that exists but cannot be read or parsed is not "no
 * pins": pin state is then UNKNOWN, and unknown must never license deletion, so
 * callers refuse to delete anything until it is readable again.
 */
async function readOverlay(sessionsDir) {
  let raw;
  try {
    raw = await fs.readFile(path.join(sessionsDir, OVERLAY_FILE), 'utf-8');
  } catch (error) {
    // A missing sidecar genuinely means "nothing is pinned here"; any other
    // failure (a scanner holding it, a permissions problem) does not.
    return { entries: {}, readable: error?.code === 'ENOENT' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { entries: parsed, readable: true };
  } catch { /* fall through: corrupt sidecar */ }
  return { entries: {}, readable: false };
}

/** Pinned in the sidebar overlay, on the record (`/pin`), or by an older CLI build. */
function isPinned(session, overlay, fileId) {
  if (session.pinned === true || session.guard?.pinned === true) return true;
  if (overlay[session.id]?.pinned === true) return true;
  return fileId !== undefined && overlay[fileId]?.pinned === true;
}

async function readSessionFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') {
      return { status: 'parseFailed' };
    }
    return { status: 'ok', session: parsed };
  } catch {
    return { status: 'parseFailed' };
  }
}

function hasRealUserMessage(session) {
  return (session.messages ?? []).some((message) =>
    message
    && message.role === 'user'
    && typeof message.content === 'string'
    && message.content.trim().length > 0,
  );
}

async function analyzeSessionsDir(sessionsDir) {
  const result = {
    dir: sessionsDir,
    total: 0,
    empty: 0,
    systemOnly: 0,
    withContent: 0,
    parseFailed: 0,
    pinnedEmpty: 0,
    candidates: [],
    candidateBytes: 0,
    /** True when the sidecar exists but could not be read: pin state unknown. */
    overlayUnreadable: false,
  };

  let names;
  try {
    names = await fs.readdir(sessionsDir);
  } catch {
    return result;
  }
  const { entries: overlay, readable: overlayReadable } = await readOverlay(sessionsDir);
  result.overlayUnreadable = !overlayReadable;

  for (const name of names) {
    if (!name.startsWith('sess_') || !name.endsWith('.json')) continue;
    result.total += 1;
    const fileId = name.slice(0, -'.json'.length);
    const filePath = path.join(sessionsDir, name);
    const { status, session } = await readSessionFile(filePath);
    if (status === 'parseFailed') {
      result.parseFailed += 1;
      continue;
    }
    const userMessages = (session.messages ?? []).filter((message) => message?.role === 'user');
    const hasContent = hasRealUserMessage(session);
    if (hasContent) {
      result.withContent += 1;
      continue;
    }
    // Pinned empty sessions are counted separately and never candidates —
    // check this before classification so they land in exactly one bucket.
    if (isPinned(session, overlay, fileId)) {
      result.pinnedEmpty += 1;
      continue;
    }
    // Empty-ish: no user text at all. Distinguish "totally empty" from
    // "system/fork-marker only" for reporting.
    if (userMessages.length === 0 && (session.messages ?? []).length === 0) {
      result.empty += 1;
    } else {
      result.systemOnly += 1;
    }
    // Unreadable pin state: still counted above, but never offered as a
    // candidate — the caller cannot know whether the user asked to keep it.
    if (!overlayReadable) continue;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    result.candidateBytes += stat.size;
    result.candidates.push({
      id: session.id,
      file: name,
      // The sidebar's title lives in the overlay; without it the preview lists
      // renamed chats as untitled and the user cannot tell what they are about
      // to delete.
      title: overlay[fileId]?.title ?? session.title ?? null,
      createdAt: session.createdAt ?? null,
      bytes: stat.size,
      messageCount: (session.messages ?? []).length,
    });
  }
  return result;
}

/**
 * Delete explicit session files. Hard guards: every id must map to a file in
 * the given dir that STILL analyzes as a cleanup candidate (empty + not
 * pinned) at deletion time — a session that gained content since the numbers
 * were shown is skipped, not deleted — and the pin sidecar must be readable, so
 * an unreadable overlay skips every id with `pin-state-unknown`.
 */
async function deleteSessionFiles(sessionsDir, ids) {
  const deleted = [];
  const skipped = [];
  let freedBytes = 0;
  const { entries: overlay, readable: overlayReadable } = await readOverlay(sessionsDir);
  for (const id of ids) {
    if (typeof id !== 'string' || !/^sess_[A-Za-z0-9_-]+\.json$/.test(`${id}.json`) && !/^sess_[A-Za-z0-9_-]+$/.test(id)) {
      skipped.push({ id, reason: 'invalid-id' });
      continue;
    }
    // A sidecar we cannot read means the pin flags are unknown, and a pinned
    // chat must never be deleted: refuse the whole batch rather than guess.
    if (!overlayReadable) {
      skipped.push({ id, reason: 'pin-state-unknown' });
      continue;
    }
    const fileName = id.endsWith('.json') ? id : `${id}.json`;
    const filePath = path.join(sessionsDir, fileName);
    const analysis = await readSessionFile(filePath);
    if (analysis.status === 'parseFailed') {
      skipped.push({ id, reason: 'parse-failed' });
      continue;
    }
    const session = analysis.session;
    if (hasRealUserMessage(session)) {
      skipped.push({ id, reason: 'has-content' });
      continue;
    }
    if (isPinned(session, overlay, fileName.slice(0, -'.json'.length))) {
      skipped.push({ id, reason: 'pinned' });
      continue;
    }
    try {
      const stat = await fs.stat(filePath);
      freedBytes += stat.size;
      await fs.rm(filePath, { force: true });
      deleted.push(id);
    } catch {
      skipped.push({ id, reason: 'delete-failed' });
    }
  }
  return { deleted, skipped, freedBytes };
}

module.exports = { analyzeSessionsDir, deleteSessionFiles, hasRealUserMessage };
