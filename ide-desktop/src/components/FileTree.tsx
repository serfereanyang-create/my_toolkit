import { useEffect, useRef, useState } from 'react';
import { desktop } from '../lib/ipc';
import type { TreeNode } from '../types';

const MAX_CHILDREN_PER_DIRECTORY = 500;

type DirectoryResult = {
  children: TreeNode[];
  truncated: boolean;
};

type DirectoryState = DirectoryResult & {
  status: 'loading' | 'loaded' | 'error';
  error?: string;
};

type FileTreeProps = {
  tree: TreeNode[];
  workspaceRoot: string;
  onOpenFile: (path: string) => void;
};

export function FileTree({ tree, workspaceRoot, onOpenFile }: FileTreeProps) {
  const [rootNodes, setRootNodes] = useState(tree);
  const [rootStatus, setRootStatus] = useState<'ready' | 'loading' | 'error'>('ready');
  const [rootError, setRootError] = useState<string | undefined>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const cacheRef = useRef<Map<string, DirectoryResult>>(new Map());
  const pendingRef = useRef<Set<string>>(new Set());
  const generationRef = useRef(0);

  // The root list is owned by App, while nested lists are cached locally. Keep
  // the two in sync when the workspace is changed or the root is refreshed.
  useEffect(() => {
    generationRef.current += 1;
    cacheRef.current.clear();
    pendingRef.current.clear();
    setRootNodes(tree);
    setRootStatus('ready');
    setRootError(undefined);
    setExpanded(new Set());
    setDirectories({});
  }, [workspaceRoot, tree]);

  function setDirectory(path: string, next: DirectoryState) {
    setDirectories((previous) => ({ ...previous, [path]: next }));
  }

  async function loadDirectory(path: string, node?: TreeNode, force = false) {
    const cached = cacheRef.current.get(path);
    if (!force && cached) {
      setDirectory(path, { ...cached, status: 'loaded' });
      return;
    }

    // A refresh while a request is in flight should not create duplicate IPC
    // calls. The existing request will populate the cache when it completes.
    if (pendingRef.current.has(path)) return;

    if (!force && node?.children) {
      const result = limitChildren(node.children);
      cacheRef.current.set(path, result);
      setDirectory(path, { ...result, status: 'loaded' });
      return;
    }

    const previous = directories[path];
    pendingRef.current.add(path);
    setDirectory(path, {
      children: previous?.children ?? cached?.children ?? [],
      truncated: previous?.truncated ?? cached?.truncated ?? false,
      status: 'loading',
    });
    const requestGeneration = generationRef.current;

    try {
      const children = await desktop.workspace.getTree(path);
      if (requestGeneration !== generationRef.current) return;
      const result = limitChildren(children);
      cacheRef.current.set(path, result);
      setDirectory(path, { ...result, status: 'loaded' });
    } catch (error) {
      if (requestGeneration !== generationRef.current) return;
      setDirectory(path, {
        children: previous?.children ?? cached?.children ?? [],
        truncated: previous?.truncated ?? cached?.truncated ?? false,
        status: 'error',
        error: getErrorMessage(error),
      });
    } finally {
      if (requestGeneration === generationRef.current) pendingRef.current.delete(path);
    }
  }

  function toggleDirectory(node: TreeNode) {
    const isExpanded = expanded.has(node.path);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (isExpanded) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
    if (!isExpanded) void loadDirectory(node.path, node);
  }

  function refreshDirectory(node: TreeNode) {
    void loadDirectory(node.path, node, true);
  }

  async function refreshRoot() {
    if (rootStatus === 'loading') return;
    // A root refresh invalidates every nested cache and collapses directories so
    // expanded nodes cannot remain visible without a matching child request.
    generationRef.current += 1;
    pendingRef.current.clear();
    setRootStatus('loading');
    setRootError(undefined);
    const requestGeneration = generationRef.current;
    try {
      const nextTree = await desktop.workspace.getTree('.');
      if (requestGeneration !== generationRef.current) return;
      setRootNodes(nextTree);
      cacheRef.current.clear();
      setDirectories({});
      setExpanded(new Set());
      setRootStatus('ready');
    } catch (error) {
      if (requestGeneration !== generationRef.current) return;
      setRootStatus('error');
      setRootError(getErrorMessage(error));
    }
  }

  const visibleRootNodes = rootNodes.slice(0, MAX_CHILDREN_PER_DIRECTORY);
  const rootTruncated = rootNodes.length > MAX_CHILDREN_PER_DIRECTORY;

  return (
    <div className="file-tree">
      <div className="file-tree-toolbar">
        <span>工作区文件</span>
        <button
          className="tree-refresh"
          type="button"
          onClick={() => void refreshRoot()}
          disabled={rootStatus === 'loading'}
          title="刷新工作区文件"
        >
          刷新
        </button>
      </div>
      {rootStatus === 'loading' && <div className="tree-status">加载中…</div>}
      {rootStatus === 'error' && (
        <div className="tree-status tree-status-error">
          <span>加载失败：{rootError}</span>
          <button type="button" onClick={() => void refreshRoot()}>重试</button>
        </div>
      )}
      {visibleRootNodes.length === 0 && rootStatus !== 'loading' && rootStatus !== 'error' && (
        <div className="tree-status">目录为空</div>
      )}
      {visibleRootNodes.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          directories={directories}
          onToggleDirectory={toggleDirectory}
          onRefreshDirectory={refreshDirectory}
          onOpenFile={onOpenFile}
        />
      ))}
      {rootTruncated && (
        <div className="tree-limit-note">目录内容过多，仅显示前 {MAX_CHILDREN_PER_DIRECTORY} 项。</div>
      )}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  directories,
  onToggleDirectory,
  onRefreshDirectory,
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  directories: Record<string, DirectoryState>;
  onToggleDirectory: (node: TreeNode) => void;
  onRefreshDirectory: (node: TreeNode) => void;
  onOpenFile: (path: string) => void;
}) {
  const isDirectory = node.type === 'directory';
  const isExpanded = expanded.has(node.path);
  const directory = isDirectory ? directories[node.path] : undefined;
  const childNodes = directory?.children ?? node.children ?? [];
  const isLoading = isDirectory && isExpanded && (!directory || directory.status === 'loading');
  const showChildren = isDirectory && isExpanded && childNodes.length > 0;

  return (
    <>
      <div className="tree-row-wrap">
        <button
          className={`tree-row ${node.type}`}
          type="button"
          style={{ paddingLeft: 8 + depth * 16 }}
          aria-expanded={isDirectory ? isExpanded : undefined}
          aria-busy={isLoading || undefined}
          onClick={() => isDirectory ? onToggleDirectory(node) : onOpenFile(node.path)}
        >
          <span className="tree-disclosure" aria-hidden="true">{isDirectory ? (isExpanded ? '▾' : '▸') : ''}</span>
          <span className="tree-node-name">{node.name}</span>
          {isDirectory && directory?.status === 'loading' && <span className="tree-node-state">加载中…</span>}
          {isDirectory && directory?.status === 'error' && <span className="tree-node-state tree-node-state-error">加载失败</span>}
        </button>
        {isDirectory && isExpanded && (
          <button
            className="tree-refresh"
            type="button"
            onClick={(event) => { event.stopPropagation(); onRefreshDirectory(node); }}
            disabled={directory?.status === 'loading'}
            title={`刷新 ${node.name}`}
          >
            刷新
          </button>
        )}
      </div>
      {isDirectory && isExpanded && isLoading && (
        <div className="tree-status" style={{ paddingLeft: 24 + depth * 16 }}>加载中…</div>
      )}
      {isDirectory && isExpanded && directory?.status === 'error' && (
        <div className="tree-status tree-status-error" style={{ paddingLeft: 24 + depth * 16 }}>
          <span>加载失败：{directory.error}</span>
          <button type="button" onClick={() => onRefreshDirectory(node)}>重试</button>
        </div>
      )}
      {showChildren && childNodes.map((child) => (
        <TreeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          directories={directories}
          onToggleDirectory={onToggleDirectory}
          onRefreshDirectory={onRefreshDirectory}
          onOpenFile={onOpenFile}
        />
      ))}
      {isDirectory && isExpanded && directory?.status === 'loaded' && childNodes.length === 0 && (
        <div className="tree-status" style={{ paddingLeft: 24 + depth * 16 }}>目录为空</div>
      )}
      {isDirectory && isExpanded && directory?.status === 'loaded' && directory.truncated && (
        <div className="tree-limit-note" style={{ paddingLeft: 24 + depth * 16 }}>
          目录内容过多，仅显示前 {MAX_CHILDREN_PER_DIRECTORY} 项。
        </div>
      )}
    </>
  );
}

function limitChildren(children: TreeNode[]): DirectoryResult {
  return {
    children: children.slice(0, MAX_CHILDREN_PER_DIRECTORY),
    truncated: children.length > MAX_CHILDREN_PER_DIRECTORY,
  };
}

function getErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/s, '').trim();
  return (cleaned || '未知错误').slice(0, 160);
}
