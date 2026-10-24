/*
 * Error messages that travel from the main process to the renderer.
 *
 * Kept out of ipc.cjs so it can be tested without Electron: ipc.cjs requires
 * `electron` and registers handlers on import, which a plain node:test cannot
 * do. This is the same split used for preview-policy.cjs.
 */

/**
 * Turn an error thrown while resolving a workspace path into a message fit for
 * the renderer.
 *
 * Passing `error.message` through verbatim leaked the machine's layout into the
 * UI: a missing file surfaced as
 *   `ENOENT: no such file or directory, realpath 'C:\Users\<name>\...\nope.docx'`
 * A missing path is an ordinary outcome — the renderer can hold a stale one —
 * so it gets a plain sentence, and anything else keeps its wording with the raw
 * path redacted. Path-policy rejections from `assertInsideRoot` are already
 * written for the user and pass through unchanged.
 */
function describePathError(error) {
  // The UI is Chinese; "File not found" was the one English sentence that
  // reached the user, usually as the whole body of a failed file open.
  if (error?.code === 'ENOENT') return '文件不存在，可能已被移动或删除';
  const message = typeof error?.message === 'string' ? error.message : String(error);
  // Redact only ABSOLUTE paths. A relative path is the user's own input and is
  // what makes a rejection actionable — assertInsideRoot says "Path escapes
  // workspace: ../other-pkg/README.md" and that must stay intact, so a slash
  // preceded by a path character (including the dots of "../") is not a root.
  return message.replace(/[A-Za-z]:\\[^\s'"]+|(?<![\w./-])\/(?!\.\.?\/)[\w.-]+\/[\w./-]+/g, '<path>');
}

module.exports = { describePathError };
