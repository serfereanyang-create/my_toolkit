import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Durable whole-file writes for the JSON stores ZCode keeps on disk.
 *
 * Two failures this prevents, both of which cost real data:
 *   - writing in place truncates the file first, so a crash or a kill in
 *     between leaves a half-written one — and every store here treats an
 *     unreadable file as empty, so the next save would erase the rest;
 *   - a store that reads, edits and rewrites the whole file loses whatever a
 *     concurrent writer added between its read and its write. Tool batches and
 *     several desktop sessions do write concurrently.
 *
 * Both are silent: nothing throws, the entries simply stop existing.
 */

/** One queue per file, so read-modify-write cycles on it never interleave. */
const queues = new Map<string, Promise<void>>();

/** Run `task` after every earlier task queued for `key`. */
export async function serializeWrites<Result>(key: string, task: () => Promise<Result>): Promise<Result> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((done) => {
    release = done;
  });
  queues.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

/**
 * rename() over a file another process has open fails with EPERM/EBUSY on
 * Windows; a reader holding the file for a moment is not a write failure.
 */
export async function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!transient || attempt >= 4) throw error;
      await new Promise((done) => setTimeout(done, 20 * (attempt + 1)));
    }
  }
}

/** Write to a sibling temp file and rename it into place: the target is never observable half-written. */
export async function writeFileAtomic(path: string, content: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: typeof content === 'string' ? 'utf8' : undefined, flag: 'wx' });
  try {
    await renameWithRetry(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
