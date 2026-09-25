/*
 * Media preview formats — port of zcode's shared media-preview table plus the
 * prepare flow (local-url or inline base64; the host-range-url remote variant
 * does not apply to this app). Extension matching is case-insensitive and
 * backslash tolerant, longest suffix first so ".m4a" beats ".a".
 */

const { readFile, stat } = require('node:fs/promises');

const DEFAULT_INLINE_MAX_BYTES = 8 * 1024 * 1024;

const MEDIA_PREVIEW_FORMATS = [
  { extension: '.mp4', kind: 'video', mediaType: 'video/mp4' },
  { extension: '.mov', kind: 'video', mediaType: 'video/quicktime' },
  { extension: '.webm', kind: 'video', mediaType: 'video/webm' },
  { extension: '.m4v', kind: 'video', mediaType: 'video/x-m4v' },
  { extension: '.mp3', kind: 'audio', mediaType: 'audio/mpeg' },
  { extension: '.wav', kind: 'audio', mediaType: 'audio/wav' },
  { extension: '.m4a', kind: 'audio', mediaType: 'audio/mp4' },
  { extension: '.ogg', kind: 'audio', mediaType: 'audio/ogg' },
  { extension: '.opus', kind: 'audio', mediaType: 'audio/opus' },
  { extension: '.flac', kind: 'audio', mediaType: 'audio/flac' },
  { extension: '.weba', kind: 'audio', mediaType: 'audio/webm' },
];

function getMediaPreviewFormat(filePath) {
  const normalizedPath = String(filePath).replace(/\\/g, '/').toLowerCase();
  const sorted = [...MEDIA_PREVIEW_FORMATS].sort((a, b) => b.extension.length - a.extension.length);
  return sorted.find(({ extension }) => normalizedPath.endsWith(extension)) ?? null;
}

/**
 * Build the renderer-facing preparation for a media file: prefer a local file
 * URL (zero-copy) and fall back to an inline base64 payload when url support
 * is unavailable. Throws on non-media paths, missing files, or oversized
 * inline payloads.
 */
async function prepareMediaPreview({ filePath, expectedKind, supportsLocalUrl = true, inlineMaxBytes = DEFAULT_INLINE_MAX_BYTES }) {
  const format = getMediaPreviewFormat(filePath);
  if (!format || format.kind !== expectedKind) {
    throw new Error(`Unsupported media preview format: ${filePath}`);
  }
  const info = await stat(filePath).catch(() => null);
  if (!info || !info.isFile()) {
    throw new Error(`Path is not a media file: ${filePath}`);
  }
  if (supportsLocalUrl) {
    return {
      kind: 'local-url',
      mediaType: format.mediaType,
      path: filePath,
      size: info.size,
      url: `file:///${String(filePath).replace(/\\/g, '/')}`,
    };
  }
  if (info.size > inlineMaxBytes) {
    throw new Error(`Media file is too large for inline preview: ${filePath}`);
  }
  const buffer = await readFile(filePath);
  return {
    kind: 'inline',
    dataBase64: buffer.toString('base64'),
    mediaType: format.mediaType,
    path: filePath,
    size: info.size,
  };
}

module.exports = { MEDIA_PREVIEW_FORMATS, getMediaPreviewFormat, prepareMediaPreview, DEFAULT_INLINE_MAX_BYTES };
