import type { TreeNode } from '../types';

export function FileTree({ tree, onOpenFile }: { tree: TreeNode[]; onOpenFile: (path: string) => void }) {
  return (
    <div className="file-tree">
      {tree.map((node) => <TreeRow key={node.path} node={node} onOpenFile={onOpenFile} />)}
    </div>
  );
}

function TreeRow({ node, onOpenFile }: { node: TreeNode; onOpenFile: (path: string) => void }) {
  return (
    <button className={`tree-row ${node.type}`} onClick={() => node.type === 'file' && onOpenFile(node.path)}>
      <span>{node.type === 'directory' ? '▸' : ''}</span>
      <span>{node.name}</span>
    </button>
  );
}
