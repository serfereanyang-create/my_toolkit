# Input Attachments, Multiline Paste, 25KB Cap

Date: 2026-07-22  
Status: Approved

## Goals

1. Accept screenshots and arbitrary files as attachments (images → vision; others → path + tools).
2. Multiline paste without bash-style “each newline submits” and without forced terminal re-wrap of user text.
3. Pure-text body hard limit **25KB** (25 480 UTF-8 bytes), excluding image binary/base64.

## UX

### Multiline

- `"""` alone starts a block; next `"""` alone ends. Content keeps **original newlines** (no shell line-continuation mangling).
- `/paste` … end with a line that is only `.` or `/end`.
- Single-line Enter still submits (normal chat).
- **No forced wrap on input capture** — we accumulate raw lines as the user pasted them.
- Display: collapse long user text by **line count** (first N lines + `… K more lines, total X KB`), not by re-wrapping every column like bash `fold`. Optional wide/no-wrap for those blocks.

### Attachments

- `/attach <path>…` copy/register under `.aicode/attachments/<sessionId>/`.
- Bare existing paths in a message (quoted Windows paths from drag-drop) auto-attach.
- Images `png|jpg|jpeg|gif|webp` → base64 multimodal parts.
- Other files → text note + absolute path for tools.
- `/paste-image` / `/clip`: Windows clipboard image → attachment.
- Per-file cap: **8MB** raw.

### 25KB text

- Count UTF-8 bytes of text parts only.
- Over limit → reject with sizes; do not silent truncate.

## Architecture

- `src/cli/input.ts` — read turn (single / multiline), size check, path harvest.
- `src/cli/attachments.ts` — register, clipboard image, classify.
- `AgentMessage` + optional `parts: {type:text|image}[]`.
- OpenAI message serializer emits vision content arrays.
- `TerminalUI.turnStart` / user block: fold by lines, no column re-wrap for user paste.

## Non-goals

- Native OS drag events / web upload page.
- PDF OCR.
