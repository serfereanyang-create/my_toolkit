export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'export' | 'method';

export type SymbolRecord = {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  endLine?: number;
  exported: boolean;
  container?: string;
  signature?: string;
};

export type NavFileEntry = {
  path: string;
  mtimeMs: number;
  size: number;
  language: 'ts' | 'js' | 'other';
  symbols: SymbolRecord[];
};

export type NavIndexFile = {
  version: 1;
  updatedAt: string;
  workspaceRoot: string;
  files: NavFileEntry[];
};

export type SymbolHit = SymbolRecord & {
  score: number;
};
