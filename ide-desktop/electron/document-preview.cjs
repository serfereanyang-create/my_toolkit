/*
 * Reads an Office document for a preview pane.
 *
 * All three document kinds go through one path because they share the same
 * contract and the same four failure modes, and the docx handler that already
 * existed got three of them right only because it was written carefully:
 *
 *   1. the token must be valid **for this exact absolute path** — a token is
 *      minted per file when the pane is opened, and accepting one minted for
 *      another file would let a pane read whatever it liked;
 *   2. the file's real path must still be inside the workspace (a symlink
 *      swapped in after the pane opened is the case this catches);
 *   3. the extension must match the kind the token was minted for, so a
 *      workbook renamed to .docx is refused instead of fed to the wrong parser;
 *   4. the size cap, because these are parsed synchronously in the main process
 *      and a 200 MB workbook would freeze the whole app.
 *
 * Every one of those returns `{ ok: false, error }` rather than throwing: a
 * preview pane is not a place where an exception should be able to blank the UI.
 *
 * The parsed form differs by kind — docx hands the renderer raw bytes, since
 * docx-preview does its own parsing, while xlsx and pptx are parsed here so only
 * the small grid or slide list crosses IPC.
 */

const path = require('node:path');
const fsSync = require('node:fs');
const { parseXlsx } = require('./xlsx-read.cjs');
const { parsePptx } = require('./pptx-read.cjs');

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Extensions each kind accepts, so a renamed file cannot reach a parser. */
const KIND_EXTENSIONS = {
  docx: ['.docx'],
  xlsx: ['.xlsx'],
  pptx: ['.pptx'],
};

/**
 * @param deps.validateToken     (token, expectation) => boolean
 * @param deps.workspaceRoot     () => string — read lazily, the root changes
 * @param deps.assertInsideRoot  (realPath, root) => void, throws when outside
 * @param deps.resolveAbsolutePath async (relativePath) => absolute path, throws when missing
 */
function createDocumentPreviewService({
  validateToken,
  workspaceRoot,
  assertInsideRoot,
  maxBytes = MAX_DOCUMENT_BYTES,
  readFileSync = fsSync.readFileSync,
  realpathSync = fsSync.realpathSync,
  statSync = fsSync.statSync,
  resolveAbsolutePath,
} = {}) {
  /**
   * @param kind 'docx' | 'xlsx' | 'pptx'
   */

/** Extensions each kind accepts, so a renamed file cannot reach a parser. */
  async function read(kind, relativePath, token) {
    const allowed = KIND_EXTENSIONS[kind];
    if (!allowed) return { ok: false, error: `不支持的文档类型：${kind}` };

    let abs;
    try {
      abs = await resolveAbsolutePath(relativePath);
    } catch (error) {
      // A missing file is the ordinary case here — the renderer can hold a
      // stale path — and the caller's path-error helper reports it as a plain
      // sentence instead of leaking a raw ENOENT with an absolute path.
      return { ok: false, error: error instanceof Error ? error.message : String(error), pathError: true };
    }

    const root = workspaceRoot();
    if (!validateToken?.(token, { workspaceRoot: root, kind, absolutePath: abs })) {
      return { ok: false, error: 'Invalid preview token' };
    }

    let real;
    try { real = realpathSync(abs); } catch { return { ok: false, error: '文件不存在，可能已被移动或删除' }; }
    try { assertInsideRoot(real, root); } catch (error) { return { ok: false, error: error.message }; }

    const ext = path.extname(real).toLowerCase();
    if (!allowed.includes(ext)) {
      return { ok: false, error: `不是 ${kind.toUpperCase()} 文件` };
    }

    let stat;
    try { stat = statSync(real); } catch { return { ok: false, error: '文件不存在，可能已被移动或删除' }; }
    if (!stat.isFile()) return { ok: false, error: '该路径不是文件' };
    if (stat.size > maxBytes) return { ok: false, error: '文件过大，无法在内嵌预览中打开' };

    let buffer;
    try { buffer = readFileSync(real); } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    if (kind === 'docx') {
      // Handed over as a raw buffer: docx-preview parses in the renderer.
      return { ok: true, buffer: buffer.buffer, byteOffset: buffer.byteOffset, byteLength: buffer.byteLength, size: stat.size };
    }
    if (kind === 'xlsx') {
      const workbook = parseXlsx(buffer);
      if (!workbook.ok) return { ok: false, error: workbook.error };
      return { ok: true, workbook, size: stat.size };
    }
    const deck = parsePptx(buffer);
    if (!deck.ok) return { ok: false, error: deck.error };
    return { ok: true, deck, size: stat.size };
  }

  return { read, MAX_DOCUMENT_BYTES: maxBytes };
}

module.exports = { createDocumentPreviewService, MAX_DOCUMENT_BYTES, KIND_EXTENSIONS };
