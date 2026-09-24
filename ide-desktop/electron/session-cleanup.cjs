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
  };

  let names;
  try {
    names = await fs.readdir(sessionsDir);
  } catch {
    return result;
  }

  for (const name of names) {
    if (!name.startsWith('sess_') || !name.endsWith('.json')) continue;
    result.total += 1;
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
    if (session.pinned === true) {
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
      title: session.title ?? null,
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
 * were shown is skipped, not deleted.
 */
async function deleteSessionFiles(sessionsDir, ids) {
  const deleted = [];
  const skipped = [];
  let freedBytes = 0;
  for (const id of ids) {
    if (typeof id !== 'string' || !/^sess_[A-Za-z0-9_-]+\.json$/.test(`${id}.json`) && !/^sess_[A-Za-z0-9_-]+$/.test(id)) {
      skipped.push({ id, reason: 'invalid-id' });
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
    if (session.pinned === true) {
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
