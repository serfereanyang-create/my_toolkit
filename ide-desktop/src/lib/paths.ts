/** How a tool's target path is shown to the user.
 *
 *  "." (and "./") is the workspace root, not a relative file. Both the
 *  collapsed step summary and the expanded tool card printed it verbatim, so
 *  the same call read as `当前目录` in one place and `路径: .` in the other —
 *  a bare dot that looks like a punctuation glitch rather than a location.
 *  One helper keeps every surface saying the same thing. */

/** True when the argument names the workspace root rather than a child. */
export function isWorkspaceRoot(path: string): boolean {
  return path === '.' || path === './';
}

/** Full label for a path argument, for panels that show the whole target. */
export function displayPath(path: string): string {
  return isWorkspaceRoot(path) ? '当前目录' : path;
}

/** Last path segment, for one-line summaries. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/** One-line summary of a path argument: the workspace root by name, anything
 *  else by its final segment. */
export function summarizePath(path: string): string {
  return isWorkspaceRoot(path) ? '当前目录' : baseName(path);
}
