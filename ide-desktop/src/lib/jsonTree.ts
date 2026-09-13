/**
 * Iteration 11 — JSON tree model + viewer.
 *
 * Pure layer first: `buildJsonTree` turns a parsed value into an array of
 * flattenable nodes, and `flattenJsonTree` produces the visible-row list given
 * a collapsed-path set. Keeping this logic out of the component makes the
 * collapse/filter behavior unit-testable and reusable (tool output cards,
 * preview sidebar, and the settings import preview all mount it).
 */

export type JsonNode = {
  /** Unique row id = JSON pointer path, e.g. `/result/items/2`. */
  path: string;
  key: string | null; // null for array elements
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  /** Leaf value (undefined for containers). */
  value?: string | number | boolean | null;
  /** Container children. */
  children?: JsonNode[];
  /** For containers: number of direct children, for the "{… 12}" chip. */
  size?: number;
  /** Byte-ish length for long string leaves (drives the truncation UI). */
  textLength?: number;
};

const MAX_STRING_PREVIEW = 512;

export function buildJsonTree(value: unknown, maxDepth = 32): JsonNode {
  const walk = (node: unknown, path: string, key: string | null, depth: number): JsonNode => {
    if (node === null) return { path, key, type: 'null', value: null };
    if (typeof node === 'string') {
      const shown = node.length > MAX_STRING_PREVIEW ? node.slice(0, MAX_STRING_PREVIEW) : node;
      return { path, key, type: 'string', value: shown, textLength: node.length };
    }
    if (typeof node === 'number') return { path, key, type: 'number', value: node };
    if (typeof node === 'boolean') return { path, key, type: 'boolean', value: node };
    if (depth >= maxDepth) {
      // Depth cap: treat anything deeper as a terminal preview object.
      return { path, key, type: Array.isArray(node) ? 'array' : 'object', size: Object.keys(node as object).length };
    }
    if (Array.isArray(node)) {
      const children = node.map((item, idx) => walk(item, `${path}/${idx}`, String(idx), depth + 1));
      return { path, key, type: 'array', children, size: children.length };
    }
    if (typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>);
      const children = entries.map(([childKey, childValue]) =>
        walk(childValue, `${path}/${childKey.replace(/\//g, '~1')}`, childKey, depth + 1),
      );
      return { path, key, type: 'object', children, size: children.length };
    }
    return { path, key, type: 'null', value: null };
  };
  return walk(value, '', null, 0);
}

export type FlatRow = {
  node: JsonNode;
  depth: number;
  /** True when this row is a collapsible container currently collapsed. */
  collapsed: boolean;
  /** Index within its parent, used for array position badges. */
  ordinal: number | null;
};

/**
 * Walk the tree emitting only rows not hidden by a collapsed ancestor.
 * `collapsed` holds the pointer paths of collapsed containers.
 */
export function flattenJsonTree(root: JsonNode, collapsed: ReadonlySet<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  const visit = (node: JsonNode, depth: number, ordinal: number | null, parent: JsonNode) => {
    const collapsedHere = collapsed.has(node.path);
    rows.push({ node, depth, collapsed: collapsedHere, ordinal: parent.type === 'array' ? ordinal : null });
    if (!node.children || collapsedHere) return;
    node.children.forEach((child, idx) => visit(child, depth + 1, idx, node));
  };
  visit(root, 0, null, root);
  return rows;
}

/**
 * Filter the tree down to nodes whose path or leaf text contains `needle`
 * (case-insensitive), keeping ancestors of matches so the hierarchy stays
 * readable. Returns a new root; null when nothing matches.
 */
export function filterJsonTree(node: JsonNode, needle: string): JsonNode | null {
  if (!needle.trim()) return node;
  const q = needle.toLowerCase();
  const selfMatch = node.path.toLowerCase().includes(q)
    || (typeof node.value === 'string' && node.value.toLowerCase().includes(q));
  if (!node.children) return selfMatch ? node : null;
  const kept = node.children
    .map((child) => filterJsonTree(child, needle))
    .filter((c): c is JsonNode => c !== null);
  if (kept.length || selfMatch) return { ...node, children: kept, size: kept.length };
  return null;
}

/** Expand every container path in `rows` (used by the toolbar expand-all). */
export function allContainerPaths(node: JsonNode, into: string[] = []): string[] {
  if (node.children?.length) {
    into.push(node.path);
    for (const child of node.children) allContainerPaths(child, into);
  }
  return into;
}

/**
 * Parse text leniently for the viewer: strict JSON first; if that fails but
 * the text *looks* JSON-ish (starts with { or [), surface the parse error so
 * the UI can show it instead of silently falling back to raw text.
 */
export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string; looksLikeJson: boolean } {
  const trimmed = text.trim();
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (!looksLikeJson) return { ok: false, error: 'not-json', looksLikeJson: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), looksLikeJson: true };
  }
}
