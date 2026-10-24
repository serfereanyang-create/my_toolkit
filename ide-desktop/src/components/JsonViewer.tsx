import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { buildJsonTree, filterJsonTree, flattenJsonTree, tryParseJson, allContainerPaths } from '../lib/jsonTree';
import { copyText } from '../lib/clipboard';

/**
 * Iteration 11 — collapsible JSON tree viewer.
 *
 * Consumes any text, parses leniently (falls back to a caller-chosen raw
 * render), and shows a VS Code-style expand/collapse tree with per-type
 * value coloring, a pointer-path filter box, and expand/collapse-all. Rows
 * come from flattenJsonTree so the collapse model stays unit-tested in
 * lib/jsonTree.
 */

export function JsonViewer({ text, height = 'auto' }: {
  text: string;
  height?: number | string;
}) {
  const parsed = useMemo(() => tryParseJson(text), [text]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [needle, setNeedle] = useState('');

  const root = useMemo(
    () => (parsed.ok ? buildJsonTree(parsed.value) : null),
    [parsed],
  );
  const filteredRoot = useMemo(
    () => (root ? filterJsonTree(root, needle) : null),
    [root, needle],
  );
  // While filtering, auto-expand everything so matches are visible.
  const openAll = useMemo(() => {
    if (!filteredRoot) return new Set<string>();
    const paths = allContainerPaths(filteredRoot);
    return new Set(paths.length ? paths.filter((p) => p !== '') : []);
  }, [filteredRoot]);

  const rows = useMemo(() => {
    if (!filteredRoot) return [];
    const effectiveCollapsed = needle.trim() ? openAll : collapsed;
    return flattenJsonTree(filteredRoot, effectiveCollapsed);
  }, [filteredRoot, collapsed, needle, openAll]);

  if (!parsed.ok && parsed.looksLikeJson) {
    return <div className="jsonv-error">JSON 解析失败：{parsed.error}</div>;
  }
  if (!parsed.ok || !root) return null; // caller falls back to raw <pre>

  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const totalPaths = root ? allContainerPaths(root).length : 0;

  return (
    <div className="jsonv" style={{ height }}>
      <div className="jsonv-toolbar">
        <input
          className="jsonv-filter"
          placeholder="按 key / 值 / 路径 过滤…"
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
        />
        <button type="button" className="jsonv-btn" title="全部展开" onClick={() => setCollapsed(new Set())}>⊞</button>
        <button type="button" className="jsonv-btn" title="全部折叠" onClick={() => setCollapsed(new Set(allContainerPaths(root).filter((p) => p !== '')))}>⊟</button>
        <button
          type="button"
          className="jsonv-btn"
          title="复制格式化 JSON"
          onClick={() => {
            const pretty = parsed.ok ? JSON.stringify(parsed.value, null, 2) : text;
            void copyText(pretty);
          }}
        ><Copy size={12} /></button>
      </div>
      <div className="jsonv-body">
        {rows.length === 0 && <div className="jsonv-empty">没有匹配的值</div>}
        {rows.map((row) => {
          const { node, depth, collapsed: isCollapsed } = row;
          const expandable = Boolean(node.children?.length);
          return (
            <div key={node.path || '__root'} className="jsonv-row" style={{ paddingLeft: 6 + depth * 14 }}>
              {expandable ? (
                <button type="button" className="jsonv-twist" onClick={() => toggle(node.path)} aria-expanded={!isCollapsed}>
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
              ) : <span className="jsonv-twist-sp" />}
              {node.key !== null && (
                <span className="jsonv-key">{node.key}{row.ordinal !== null ? '' : ''}</span>
              )}
              {node.key !== null && <span className="jsonv-colon">: </span>}
              {expandable && isCollapsed && (
                <button type="button" className="jsonv-chip" onClick={() => toggle(node.path)}>
                  {node.type === 'array' ? `[${node.size}]` : `{${node.size}}`}
                </button>
              )}
              {(!expandable || !isCollapsed) && <JsonValue node={node} />}
              {expandable && !isCollapsed && node.type === 'array' && (
                <span className="jsonv-meta">[{node.size}]</span>
              )}
            </div>
          );
        })}
        {totalPaths > 400 && <div className="jsonv-meta-note">提示：大型 JSON 已默认折叠顶层节点</div>}
      </div>
    </div>
  );
}

function JsonValue({ node }: { node: ReturnType<typeof buildJsonTree> }) {
  if (node.type === 'string') {
    const truncated = (node.textLength ?? 0) > 512;
    return (
      <span className="jsonv-string">
        "{node.value}"{truncated && <em className="jsonv-trunc">…（共 {node.textLength} 字符）</em>}
      </span>
    );
  }
  if (node.type === 'number') return <span className="jsonv-number">{node.value}</span>;
  if (node.type === 'boolean') return <span className="jsonv-bool">{String(node.value)}</span>;
  if (node.type === 'null') return <span className="jsonv-null">null</span>;
  return null; // open container brace — children follow on their own rows
}
