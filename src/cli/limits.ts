/** Pure-text body hard limit (UTF-8 bytes), excluding image binary/base64. */
export const MAX_USER_TEXT_BYTES = 25 * 1024; // 25KB = 25600; design uses 25480 for header slack
export const MAX_USER_TEXT_BYTES_HARD = 25_480;

/** Per-attachment raw file size. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export function utf8ByteLength(text: string) {
  return Buffer.byteLength(text, 'utf8');
}

export function assertUserTextWithinLimit(text: string) {
  const bytes = utf8ByteLength(text);
  if (bytes > MAX_USER_TEXT_BYTES_HARD) {
    throw new Error(
      `Text input exceeds ${MAX_USER_TEXT_BYTES_HARD} bytes (25KB hard limit). Current: ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB). Shorten the message or attach files with /attach instead of pasting large blobs.`,
    );
  }
  return bytes;
}

export function formatByteSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
