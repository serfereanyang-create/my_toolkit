/*
 * Atomic file writes — compact port of zcode's fs/atomicFileUtils.
 *
 * Temp file lives in the SAME directory as the target (Windows rename cannot
 * cross volumes), rename replaces the target atomically, and EPERM/EBUSY/
 * EACCES from antivirus/indexers holding the target get a short retry series.
 * Stale .tmp leftovers from crashed runs are cleaned opportunistically.
 *
 * Simplified from upstream: the cross-process lock-file protocol is omitted
 * because in this app the main process is the sole writer of these files.
 */

const { mkdir, readdir, rename, rm, stat, writeFile } = require('node:fs/promises');
const { basename, dirname, join } = require('node:path');

const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400];
const DEFAULT_TEMP_FILE_STALE_MS = 60_000;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isRetryableRenameError(error) {
  const code = error && typeof error.code === 'string' ? error.code : undefined;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

async function renameWithRetry(tempFile, filePath, retryDelaysMs = DEFAULT_RENAME_RETRY_DELAYS_MS) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempFile, filePath);
      return;
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || !isRetryableRenameError(error)) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

async function cleanupStaleTempFilesForTarget(filePath, excludeTempFile, staleMs) {
  const dir = dirname(filePath);
  const tempPrefix = `${basename(filePath)}.`;
  const now = Date.now();
  try {
    const entries = await readdir(dir);
    await Promise.all(entries.map(async (entry) => {
      if (!entry.startsWith(tempPrefix) || !entry.endsWith('.tmp')) return;
      const tempPath = join(dir, entry);
      if (tempPath === excludeTempFile) return;
      try {
        const info = await stat(tempPath);
        if (now - info.mtimeMs < staleMs) return;
        await rm(tempPath, { force: true });
      } catch { /* best effort */ }
    }));
  } catch { /* best effort */ }
}

async function atomicWriteText(filePath, content, options = {}) {
  const dir = dirname(filePath);
  const tempFile = join(
    dir,
    `${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await mkdir(dir, { recursive: true });
  await cleanupStaleTempFilesForTarget(filePath, tempFile, options.tempFileStaleMs ?? DEFAULT_TEMP_FILE_STALE_MS);
  try {
    await writeFile(tempFile, content, 'utf-8');
    // Concurrent writers to the same target storm rename with EPERM on
    // Windows; serialize per target in-process (upstream adds a cross-process
    // lock file because it has multiple host processes — we have one).
    await enqueueOnTarget(filePath, () => renameWithRetry(tempFile, filePath, options.renameRetryDelaysMs));
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

const writeChains = new Map();

function enqueueOnTarget(filePath, operation) {
  const key = filePath.replace(/\\/g, '/').toLowerCase();
  const previous = writeChains.get(key) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const completion = result.then(() => undefined, () => undefined);
  writeChains.set(key, completion);
  void completion.finally(() => {
    if (writeChains.get(key) === completion) writeChains.delete(key);
  });
  return result;
}

async function atomicWriteJson(filePath, value, options = {}) {
  return atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

module.exports = { atomicWriteText, atomicWriteJson, renameWithRetry, isRetryableRenameError };
