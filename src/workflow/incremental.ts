/**
 * Incremental build and change impact analysis for large projects.
 * Only affected files/tests are re-processed; unchanged work is skipped.
 *
 * Security notes: git runs through the same promisified execFile pattern as
 * cli/src/tools/git.ts with fixed, hardcoded argument lists. Import resolution
 * is pure string math against the set of already-scanned files — regex-extracted
 * content never flows into filesystem or process sinks. Regex iteration uses
 * matchAll (the codebase-standard pattern, see audit/security-scanner.ts).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, relative, dirname, extname } from 'node:path';
import { isIgnoredDirName } from '../workspace/ignored.js';

const execFileAsync = promisify(execFile);

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed';

export type FileChange = {
  path: string;
  type: ChangeType;
  linesAdded: number;
  linesDeleted: number;
};

export type DependencyNode = {
  path: string;
  imports: string[];
  exports: string[];
  hash: string;
};

export type DependencyGraph = {
  nodes: Map<string, DependencyNode>;
  edges: Map<string, Set<string>>; // imported file -> files that import it
};

export type ImpactScope = 'minimal' | 'moderate' | 'extensive' | 'comprehensive';

export type ImpactAnalysisResult = {
  changedFiles: FileChange[];
  affectedFiles: string[];
  affectedTests: string[];
  impactScope: ImpactScope;
  estimatedImpact: number;
  recommendations: string[];
};

export type TestCacheEntry = {
  passed: boolean;
  duration: number;
  timestamp: number;
  hash: string;
};

export type IncrementalCacheData = {
  version: string;
  lastBuildTime: number;
  fileHashes: Record<string, string>;
  testResults: Record<string, TestCacheEntry>;
};

// ---------------------------------------------------------------------------
// Git change detection (fixed argument lists, git.ts execFile pattern)
// ---------------------------------------------------------------------------

async function runGitReadOnly(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    timeout: 30000,
    maxBuffer: 4_000_000,
    windowsHide: true,
  });
  return result.stdout;
}

export class ChangeDetector {
  constructor(private projectRoot: string) {}

  /** Uncommitted working-tree + staged changes. */
  async getUncommittedChanges(): Promise<FileChange[]> {
    const changes: FileChange[] = [];

    try {
      const unstaged = await runGitReadOnly(['diff', '--numstat'], this.projectRoot);
      changes.push(...parseDiffOutput(unstaged));
    } catch {
      // Not a git repo or git unavailable — no data
    }

    try {
      const staged = await runGitReadOnly(['diff', '--cached', '--numstat'], this.projectRoot);
      changes.push(...parseDiffOutput(staged));
    } catch {
      // Ignore
    }

    return changes;
  }
}

export function parseDiffOutput(output: string): FileChange[] {
  const changes: FileChange[] = [];
  const lines = output.trim().split('\n').filter((l) => l.length > 0);

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const added = parts[0];
    const deleted = parts[1];
    const rawPath = parts.slice(2).join('\t');
    const filePath = stripWorktreePrefix(rawPath);

    const linesAdded = added === '-' ? 0 : parseInt(added, 10) || 0;
    const linesDeleted = deleted === '-' ? 0 : parseInt(deleted, 10) || 0;

    let type: ChangeType = 'modified';
    if (linesAdded > 0 && linesDeleted === 0) type = 'added';
    if (linesAdded === 0 && linesDeleted > 0) type = 'deleted';

    changes.push({ path: filePath, type, linesAdded, linesDeleted });
  }

  return changes;
}

function stripWorktreePrefix(rawPath: string): string {
  const segments = rawPath.split('/');
  while (segments.length > 0 && segments[0] === '.') {
    segments.shift();
  }
  return segments.join('/');
}

// ---------------------------------------------------------------------------
// Pure path math on internal relative paths (no fs access, no user input)
// ---------------------------------------------------------------------------

export function stripExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastDot > lastSlash) return filePath.slice(0, lastDot);
  return filePath;
}

export function slashJoin(dir: string, importPath: string): string {
  const combined = dir === '.' ? importPath : dir + '/' + importPath;
  const segments: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * Resolve a relative import to a scanned file using only string operations.
 * Handles extension aliasing (./x.js -> x.ts) and directory index files.
 * Returns null when no scanned file matches.
 */
export function resolveImportAgainstFileSet(
  importPath: string,
  currentFile: string,
  fileSet: Set<string>
): string | null {
  if (!importPath.startsWith('.')) return null;

  const currentDir = dirname(stripExtension(currentFile));
  const targetBase = slashJoin(currentDir, importPath);
  const baseExt = extname(targetBase);

  const candidates: string[] = [targetBase];
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) {
    candidates.push(targetBase + ext);
  }
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    candidates.push(targetBase + '/index' + ext);
  }
  // NodeNext-style: ./x.js may mean x.ts in the source tree
  if (baseExt === '.js' || baseExt === '.mjs') {
    const withoutExt = targetBase.slice(0, targetBase.length - baseExt.length);
    candidates.push(withoutExt + '.ts');
    candidates.push(withoutExt + '.tsx');
  }

  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dependency graph (two-pass: collect files, then resolve imports in-memory)
// ---------------------------------------------------------------------------

export class DependencyGraphBuilder {
  private graph: DependencyGraph = { nodes: new Map(), edges: new Map() };

  constructor(private projectRoot: string, private maxFiles = 3000) {}

  async build(): Promise<DependencyGraph> {
    // Pass 1: collect source files by walking down from the workspace root
    const files: string[] = [];
    await this.walkFiles(this.projectRoot, this.projectRoot, files);

    // Pass 2: read contents and record nodes
    const contents = new Map<string, string>();
    for (const filePath of files) {
      try {
        const content = await readFile(join(this.projectRoot, filePath), 'utf8');
        contents.set(filePath, content);
        this.graph.nodes.set(filePath, {
          path: filePath,
          imports: [],
          exports: extractExports(content),
          hash: hashContent(content),
        });
      } catch {
        // Skip unreadable files
      }
    }

    // Pass 3: resolve imports purely against the collected file set
    const fileSet = new Set(this.graph.nodes.keys());
    for (const [filePath, content] of contents) {
      this.graph.nodes.get(filePath)!.imports = extractImports(content, filePath, fileSet);
    }

    this.buildReverseEdges();
    return this.graph;
  }

  /** repoMap-style downward walk from the workspace root; paths stay internal. */
  private async walkFiles(current: string, root: string, files: string[]): Promise<void> {
    if (files.length >= this.maxFiles) return;

    try {
      const info = await stat(current);
      if (info.isFile()) {
        if (TS_EXTENSIONS.has(extname(current))) {
          files.push(relative(root, current).replace(/\\/g, '/'));
        }
        return;
      }
      if (!info.isDirectory()) return;

      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= this.maxFiles) break;
        if (isIgnoredDirName(entry.name) || entry.name.startsWith('.')) continue;
        await this.walkFiles(join(current, entry.name), root, files);
      }
    } catch {
      // Skip unreadable entries
    }
  }

  private buildReverseEdges(): void {
    for (const [filePath, node] of this.graph.nodes) {
      for (const importPath of node.imports) {
        let edgeSet = this.graph.edges.get(importPath);
        if (!edgeSet) {
          edgeSet = new Set();
          this.graph.edges.set(importPath, edgeSet);
        }
        edgeSet.add(filePath);
      }
    }
  }

  /** All files that transitively import the given file (BFS up the reverse edges). */
  findDependents(filePath: string, maxDepth = 10): Set<string> {
    const dependents = new Set<string>();
    const queue: Array<{ file: string; depth: number }> = [{ file: filePath, depth: 0 }];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      if (visited.has(current.file) || current.depth > maxDepth) continue;
      visited.add(current.file);

      const directDependents = this.graph.edges.get(current.file);
      if (directDependents) {
        for (const dependent of directDependents) {
          dependents.add(dependent);
          queue.push({ file: dependent, depth: current.depth + 1 });
        }
      }
    }

    return dependents;
  }

  getGraph(): DependencyGraph {
    return this.graph;
  }
}

export function extractImports(content: string, currentFile: string, fileSet: Set<string>): string[] {
  const imports: string[] = [];
  const importPattern = /import\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/g;
  const requirePattern = /require\(['"]([^'"]+)['"]\)/g;

  for (const match of content.matchAll(importPattern)) {
    const resolved = resolveImportAgainstFileSet(match[1], currentFile, fileSet);
    if (resolved) imports.push(resolved);
  }

  for (const match of content.matchAll(requirePattern)) {
    const resolved = resolveImportAgainstFileSet(match[1], currentFile, fileSet);
    if (resolved) imports.push(resolved);
  }

  return [...new Set(imports)];
}

export function extractExports(content: string): string[] {
  const exports: string[] = [];
  const exportPattern = /export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/g;

  for (const match of content.matchAll(exportPattern)) {
    exports.push(match[1]);
  }

  const exportListPattern = /export\s+\{([^}]+)\}/g;
  for (const match of content.matchAll(exportListPattern)) {
    for (const name of match[1].split(',')) {
      exports.push(name.trim().split(/\s+as\s+/)[0]);
    }
  }

  return exports;
}

export function hashContent(content: string): string {
  // FNV-1a 32-bit — deterministic, fast, no crypto dependency needed here
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Impact analysis
// ---------------------------------------------------------------------------

export class ImpactAnalyzer {
  constructor(
    private dependencyGraph: DependencyGraph,
    private dependentsFinder: (filePath: string) => Set<string>
  ) {}

  analyze(changes: FileChange[]): ImpactAnalysisResult {
    const affectedFiles = new Set<string>(changes.map((c) => c.path));

    for (const change of changes) {
      for (const dependent of this.dependentsFinder(change.path)) {
        affectedFiles.add(dependent);
      }
    }

    const affectedTests = this.findAffectedTests([...affectedFiles]);

    const totalFiles = this.dependencyGraph.nodes.size;
    const impactRatio = totalFiles > 0 ? affectedFiles.size / totalFiles : 0;

    let impactScope: ImpactScope;
    let estimatedImpact: number;

    if (impactRatio < 0.05) {
      impactScope = 'minimal';
      estimatedImpact = impactRatio * 100;
    } else if (impactRatio < 0.15) {
      impactScope = 'moderate';
      estimatedImpact = 25 + impactRatio * 100;
    } else if (impactRatio < 0.5) {
      impactScope = 'extensive';
      estimatedImpact = 50 + impactRatio * 100;
    } else {
      impactScope = 'comprehensive';
      estimatedImpact = 90;
    }

    const recommendations = generateRecommendations(
      changes,
      affectedFiles.size,
      affectedTests.length,
      impactScope
    );

    return {
      changedFiles: changes,
      affectedFiles: [...affectedFiles],
      affectedTests,
      impactScope,
      estimatedImpact: Math.min(100, Math.round(estimatedImpact)),
      recommendations,
    };
  }

  private findAffectedTests(affectedFiles: string[]): string[] {
    const tests = new Set<string>();

    for (const file of affectedFiles) {
      const base = stripExtension(file);
      const ext = extname(file).slice(1);

      for (const marker of ['.test.', '.spec.']) {
        const candidate = base + marker + ext;
        if (this.dependencyGraph.nodes.has(candidate)) tests.add(candidate);
      }

      for (const dependent of this.dependencyGraph.edges.get(file) ?? new Set<string>()) {
        if (dependent.includes('.test.') || dependent.includes('.spec.')) {
          tests.add(dependent);
        }
      }
    }

    return [...tests];
  }
}

export function generateRecommendations(
  changes: FileChange[],
  affectedCount: number,
  testCount: number,
  scope: ImpactScope
): string[] {
  const recommendations: string[] = [];

  if (scope === 'minimal') {
    recommendations.push('Change impact is small; run the ' + testCount + ' related tests only');
  } else if (scope === 'moderate') {
    recommendations.push('Changes touch ' + affectedCount + ' files; run related tests plus core integration tests');
  } else if (scope === 'extensive') {
    recommendations.push('Broad impact (' + affectedCount + ' files); run the full test suite');
    recommendations.push('Create a checkpoint before validating so failures can roll back');
  } else {
    recommendations.push('Global impact; full verification and a pre-change checkpoint are required');
    recommendations.push('Consider splitting the change into smaller independent commits');
  }

  const touchesConfig = changes.some(
    (c) => c.path.endsWith('package.json') || c.path.endsWith('tsconfig.json')
  );
  if (touchesConfig) {
    recommendations.push('Config file changes detected; build pipeline may be affected');
  }

  const touchesTypes = changes.some(
    (c) => c.path.endsWith('types.ts') || c.path.endsWith('.d.ts')
  );
  if (touchesTypes) {
    recommendations.push('Type definition changes may cause widespread compile errors');
  }

  return recommendations;
}

/** Orchestrator: detect uncommitted changes, map the blast radius. */
export async function analyzeProjectImpact(projectRoot: string): Promise<ImpactAnalysisResult | null> {
  const detector = new ChangeDetector(projectRoot);
  const changes = await detector.getUncommittedChanges();
  if (changes.length === 0) return null;

  const builder = new DependencyGraphBuilder(projectRoot);
  const graph = await builder.build();

  const analyzer = new ImpactAnalyzer(graph, (file) => builder.findDependents(file));
  return analyzer.analyze(changes);
}

// ---------------------------------------------------------------------------
// Incremental cache (fixed .aicode location, repoMap-style persistence)
// ---------------------------------------------------------------------------

export class IncrementalCacheManager {
  private cache: IncrementalCacheData = {
    version: '1.0.0',
    lastBuildTime: 0,
    fileHashes: {},
    testResults: {},
  };
  private loaded = false;

  constructor(private projectRoot: string) {}

  private cachePath(): string {
    return join(this.projectRoot, '.aicode', 'workflow-cache.json');
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.cachePath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<IncrementalCacheData>;
      this.cache = {
        version: parsed.version ?? '1.0.0',
        lastBuildTime: parsed.lastBuildTime ?? 0,
        fileHashes: parsed.fileHashes ?? {},
        testResults: parsed.testResults ?? {},
      };
    } catch {
      // No cache yet — keep defaults
    }
  }

  async saveCache(): Promise<void> {
    try {
      await mkdir(dirname(this.cachePath()), { recursive: true });
      await writeFile(this.cachePath(), JSON.stringify(this.cache, null, 2), 'utf8');
    } catch {
      // Cache write failures are non-fatal
    }
  }

  async getFileHash(filePath: string): Promise<string | undefined> {
    await this.ensureLoaded();
    return this.cache.fileHashes[filePath];
  }

  async setFileHash(filePath: string, hash: string): Promise<void> {
    await this.ensureLoaded();
    this.cache.fileHashes[filePath] = hash;
  }

  async getTestResult(testFile: string): Promise<TestCacheEntry | undefined> {
    await this.ensureLoaded();
    return this.cache.testResults[testFile];
  }

  async setTestResult(testFile: string, entry: TestCacheEntry): Promise<void> {
    await this.ensureLoaded();
    this.cache.testResults[testFile] = entry;
  }

  async markBuildComplete(): Promise<void> {
    await this.ensureLoaded();
    this.cache.lastBuildTime = Date.now();
    await this.saveCache();
  }

  async clear(): Promise<void> {
    this.cache = { version: '1.0.0', lastBuildTime: 0, fileHashes: {}, testResults: {} };
    try {
      await writeFile(this.cachePath(), JSON.stringify(this.cache), 'utf8');
    } catch {
      // Ignore
    }
  }
}
