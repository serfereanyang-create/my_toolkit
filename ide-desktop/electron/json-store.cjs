/*
 * Durable JSON sidecar stores — one shape for every small state file the main
 * process keeps (bookmarks, keybindings, snippets, notes, tags...).
 *
 * Three failures this prevents, all of which cost the user their data rather
 * than raising anything:
 *
 *   1. writing the file in place truncates it first, so a crash between
 *      truncate and write leaves half a JSON document;
 *   2. rename() over a file that a virus scanner or indexer has open fails with
 *      EPERM/EBUSY on Windows, which used to abort the whole save;
 *   3. read() answered "empty" for a corrupt file, and every mutation then
 *      wrote that emptiness back — the corrupt copy is now moved aside once, so
 *      it can still be recovered by hand.
 *
 * Mutations are serialized per file path: these stores all read-modify-write,
 * and two toggles in the same tick would otherwise drop one.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { renameWithRetry } = require('./atomic-file.cjs');

const chains = new Map();

function queueKey(file) {
  return path.resolve(file).replace(/\\/g, '/').toLowerCase();
}

/** Run `task` after every earlier task queued for the same file. */
function serialize(file, task) {
  const key = queueKey(file);
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(task);
  const completion = result.then(() => undefined, () => undefined);
  chains.set(key, completion);
  void completion.finally(() => {
    if (chains.get(key) === completion) chains.delete(key);
  });
  return result;
}

/** Move an unreadable file aside so the next write cannot destroy the last copy. */
async function quarantine(file) {
  try {
    const info = await fs.stat(file);
    if (!info.isFile() || info.size === 0) return;
  } catch {
    return;
  }
  try {
    await renameWithRetry(file, `${file}.corrupt-${Date.now()}.json`);
  } catch {
    // best effort: never fail a read over the backup copy
  }
}

/** Read and parse; undefined when the file is missing or unreadable. */
async function readJson(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    await quarantine(file);
    return undefined;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await renameWithRetry(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * A store over one JSON file.
 *   file:      () => absolute path (may throw when no workspace is open)
 *   empty:     () => the value a missing file means (fresh object each call)
 *   normalize: (parsed) => value, to drop shapes the store does not accept
 */
function createJsonStore({ file, empty = () => ({}), normalize = (value) => value }) {
  async function read() {
    let target;
    try {
      target = file();
    } catch {
      // No workspace open is not an error for a read: the UI simply has nothing
      // to show. Mutations still reject, because they cannot be applied.
      return empty();
    }
    const parsed = await readJson(target);
    return parsed === undefined ? empty() : normalize(parsed);
  }

  /** Read, edit, write — serialized per file. The edit's return value is returned. */
  function mutate(edit) {
    let target;
    try {
      target = file();
    } catch (error) {
      // Rejected, not thrown: callers await or .catch() this, and a synchronous
      // throw from a function they expected to return a promise would escape.
      return Promise.reject(error);
    }
    return serialize(target, async () => {
      const current = await read();
      const result = await edit(current);
      await writeJson(target, current);
      return result;
    });
  }

  /** Read-only access that still waits for pending writes. */
  function inspect(visit) {
    let target;
    try {
      target = file();
    } catch {
      return Promise.resolve(visit(empty()));
    }
    return serialize(target, async () => visit(await read()));
  }

  return { read, mutate, inspect };
}

module.exports = { createJsonStore, readJson, writeJson, quarantine, serialize };
