/**
 * Pure helpers for session tags (iteration 18): normalising user input,
 * building the filter chip list, and deciding which sessions pass a filter.
 * Kept out of the component so vitest can cover it without a DOM.
 */

export const MAX_TAG_LEN = 24;
export const MAX_TAGS = 24;
export const MAX_PER_SESSION = 6;

/** Trim, collapse inner whitespace, lower-case, cap length. '' when nothing left. */
export function normalizeTag(raw: string): string {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_TAG_LEN);
}

/** De-dupe a user-entered comma/space separated tag string, capped per session. */
export function parseTagInput(raw: string): string[] {
  const out: string[] = [];
  for (const piece of String(raw ?? '').split(/[,，]/)) {
    const tag = normalizeTag(piece);
    if (tag && !out.includes(tag) && out.length < MAX_PER_SESSION) out.push(tag);
  }
  return out;
}

/** Distinct tags across all sessions, most-used first then alphabetical. */
export function tagCloud(tagMap: Record<string, string[]>): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const tags of Object.values(tagMap)) {
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

/** A session matches when the filter is empty or the session carries the tag. */
export function sessionMatchesTag(tagMap: Record<string, string[]>, sessionId: string, filter: string | null): boolean {
  if (!filter) return true;
  return (tagMap[sessionId] ?? []).includes(filter);
}

/** Deterministic colour index (0..7) for a tag chip from its text hash. */
export function tagColorIndex(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = ((h << 5) - h + tag.charCodeAt(i)) | 0;
  return Math.abs(h) % 8;
}
