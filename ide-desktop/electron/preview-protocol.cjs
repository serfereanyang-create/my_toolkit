/**
 * preview-protocol.cjs
 * Registers the yoycode-preview:// custom scheme that lets the React renderer
 * safely load image and DOCX binary data without exposing file:// paths.
 *
 * URL format: yoycode-preview://<token>/<url-encoded-relative-path>
 *
 * The token is generated per descriptor in preview-policy and stored in the
 * token registry managed by preview-service. Each token is single-workspace
 * and checked on every request.
 */
'use strict';
const path = require('node:path');
const fs   = require('node:fs');
const { assertInsideRoot } = require('./preview-policy.cjs');

// Scheme must be registered in the main process BEFORE app 'ready'.
const SCHEME = 'yoycode-preview';

/** Call once from main.cjs before app.whenReady() */
function registerSchemePrivileges(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  }]);
}

/**
 * Register the actual request handler after app is ready.
 * tokenRegistry: Map<token, { absolutePath, workspaceRoot, kind }>
 */
function handlePreviewProtocol(session, tokenRegistry) {
  session.protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const token = url.hostname;                       // token is the "host" part
      const relRaw = decodeURIComponent(url.pathname.replace(/^\//, ''));

      if (!token || !relRaw) return errorResponse(400, 'Bad Request');

      const entry = tokenRegistry.get(token);
      if (!entry) return errorResponse(403, 'Invalid token');

      const { workspaceRoot, kind } = entry;
      // Resolve against workspace root
      const target = path.resolve(workspaceRoot, relRaw);

      let realRoot;
      try { realRoot = fs.realpathSync(workspaceRoot); } catch { realRoot = workspaceRoot; }
      let realTarget;
      try { realTarget = fs.realpathSync(target); } catch { return errorResponse(404, 'Not found'); }

      // Security: must stay inside workspace
      assertInsideRoot(realTarget, realRoot);

      const stat = fs.statSync(realTarget);
      if (!stat.isFile()) return errorResponse(403, 'Directories not served');

      const MAX_INLINE = 50 * 1024 * 1024; // 50 MB hard cap
      if (stat.size > MAX_INLINE) return errorResponse(413, 'File too large');

      const mime = mimeForKind(kind, realTarget);
      const rangeHeader = request.headers.get('range');

      if (rangeHeader) {
        // Minimal Range support (for PDF seek)
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1], 10);
          const end   = match[2] ? parseInt(match[2], 10) : stat.size - 1;
          const length = end - start + 1;
          const buf = Buffer.alloc(length);
          const fd = fs.openSync(realTarget, 'r');
          try { fs.readSync(fd, buf, 0, length, start); } finally { fs.closeSync(fd); }
          return new Response(buf, {
            status: 206,
            headers: {
              'Content-Type': mime,
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
              'Content-Length': String(length),
              'Accept-Ranges': 'bytes',
              'X-Content-Type-Options': 'nosniff',
            },
          });
        }
      }

      const data = fs.readFileSync(realTarget);
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(stat.size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (err) {
      console.error('[preview-protocol] error:', err.message);
      return errorResponse(500, 'Internal error');
    }
  });
}

function errorResponse(status, text) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
}

function mimeForKind(kind, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
    '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[ext] || 'application/octet-stream';
}

module.exports = { SCHEME, registerSchemePrivileges, handlePreviewProtocol };
