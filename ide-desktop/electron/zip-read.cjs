/*
 * Minimal zip reading, shared by the .xlsx and .pptx preview readers.
 *
 * An OOXML file is a zip of XML. The desktop has no zip or office library and
 * this should not add one, so the central directory is walked here and the
 * members are inflated with node's own zlib.
 *
 * This is deliberately narrow: it reads entries from a buffer with no streaming,
 * skips ZIP64 and encrypted entries rather than guessing at them, and treats a
 * corrupt member as a miss instead of an error. Everything above it is a preview
 * pane, where a missing cell is a cosmetic problem and a thrown exception is a
 * blank sidebar.
 */

const { inflateRawSync } = require('node:zlib');

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode the five XML entities plus numeric character references. */
function decodeXmlText(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[entity] ?? match;
  });
}

/** Every entry in a zip buffer, inflated, keyed by full member name. */
function readZipEntries(buffer, { maxInflatedBytes = 64 * 1024 * 1024 } = {}) {
  const entries = new Map();
  // End of central directory: scan back from the end. The trailing comment is
  // normally empty but may be up to 64 KB, hence the window.
  let eocd = -1;
  const stop = Math.max(0, buffer.length - (0xffff + 22));
  for (let i = buffer.length - 22; i >= stop; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 Office 文件（找不到 zip 结尾）');

  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    // ZIP64 or an encrypted entry: skip rather than guess. Neither appears in a
    // document small enough to preview, and a wrong read is worse than a miss.
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) { cursor += 46 + nameLength + extraLength + commentLength; continue; }

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    try {
      if (method === 0) entries.set(name, raw);
      else if (method === 8) {
        if (uncompressedSize > maxInflatedBytes) continue;
        entries.set(name, inflateRawSync(raw));
      }
      // method 99 (AES) and anything else: not readable here, skipped.
    } catch {
      // A corrupt member must not sink the whole document.
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Entries whose name matches, preferring an exact path then any suffix match. */
function findEntry(entries, ...candidates) {
  for (const candidate of candidates) {
    if (candidate && entries.has(candidate)) return entries.get(candidate);
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const [name, value] of entries) {
      if (name.endsWith(`/${candidate}`) || name === candidate) return value;
    }
  }
  return undefined;
}

module.exports = { readZipEntries, decodeXmlText, findEntry };
