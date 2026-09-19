/**
 * builder.ts — 代码关系图谱构建器
 *
 * 基于 TypeScript Compiler API 提取函数调用、类继承、接口实现等关系
 */

import * as ts from 'typescript';
import { resolve, relative } from 'node:path';
import { glob as globAsync } from 'glob';
import type { CodeGraph, GraphNode, GraphEdge, NodeKind, EdgeType } from './types.js';

const DEFAULT_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/coverage/**',
  '**/*.test.ts',
  '**/*.spec.ts',
  '**/*.d.ts',
];

interface BuildOptions {
  /** 忽略模式 */
  ignorePatterns?: string[];
  /** 最大文件数限制 */
  maxFiles?: number;
  /** 是否包含测试文件 */
  includeTests?: boolean;
}

export class GraphBuilder {
  private workspaceRoot: string;
  private program: ts.Program | null = null;
  private typeChecker: ts.TypeChecker | null = null;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * 构建完整的代码关系图
   */
  async build(options: BuildOptions = {}): Promise<CodeGraph> {
    const startTime = Date.now();

    // 1. 查找所有 TS/JS 文件
    const files = await this.findSourceFiles(options);
    console.log(`[GraphBuilder] Found ${files.length} source files`);

    if (files.length === 0) {
      return this.createEmptyGraph();
    }

    // 2. 创建 TypeScript Program
    // Bundler resolution tolerates the extensionless relative imports that are
    // common in real workspaces; NodeNext would fail them and drop cross-file
    // call/heritage edges even though the files exist.
    this.program = ts.createProgram(files, {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
      skipDefaultLibCheck: true,
    });
    this.typeChecker = this.program.getTypeChecker();

    // 3. 提取节点和边
    const nodes: Record<string, GraphNode> = {};
    const edges: GraphEdge[] = [];

    // Windows: glob emits backslash paths while the compiler normalizes
    // SourceFile.fileName to forward slashes — compare normalized forms.
    const fileSet = new Set(files.map((file) => file.replace(/\\/g, '/')));
    for (const sourceFile of this.program.getSourceFiles()) {
      // 跳过库文件
      if (sourceFile.fileName.includes('node_modules')) continue;
      if (!fileSet.has(sourceFile.fileName.replace(/\\/g, '/'))) continue;

      const relativePath = relative(this.workspaceRoot, sourceFile.fileName).replace(/\\/g, '/');
      this.extractFromSourceFile(sourceFile, relativePath, nodes, edges);
    }

    const finalizedEdges = this.finalizeEdges(nodes, edges);
    const endTime = Date.now();
    console.log(`[GraphBuilder] Built graph in ${endTime - startTime}ms: ${Object.keys(nodes).length} nodes, ${finalizedEdges.length} edges`);

    return {
      version: 1,
      generated: Date.now(),
      root: this.workspaceRoot,
      nodes,
      edges: finalizedEdges,
      sourceFiles: files.map((file) => relative(this.workspaceRoot, file).replace(/\\/g, '/')),
      stats: {
        nodeCount: Object.keys(nodes).length,
        edgeCount: finalizedEdges.length,
        fileCount: files.length,
      },
    };
  }

  /**
   * 从单个源文件提取节点和边
   */
  private extractFromSourceFile(
    sourceFile: ts.SourceFile,
    relativePath: string,
    nodes: Record<string, GraphNode>,
    edges: GraphEdge[],
  ): void {
    const visit = (node: ts.Node, container?: string) => {
      // 提取函数声明
      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        const id = `${relativePath}::${name}`;
        const exported = this.isExported(node);

        nodes[id] = {
          id,
          kind: 'function',
          name,
          exported,
          signature: this.getSignature(node),
          loc: {
            path: relativePath,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          },
        };

        // 提取函数体中的调用关系
        if (node.body) {
          this.extractCalls(node.body, id, relativePath, edges, nodes);
        }
      }

      // 提取类声明
      if (ts.isClassDeclaration(node) && node.name) {
        const name = node.name.text;
        const id = `${relativePath}::${name}`;
        const exported = this.isExported(node);

        nodes[id] = {
          id,
          kind: 'class',
          name,
          exported,
          signature: `class ${name}`,
          loc: {
            path: relativePath,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          },
        };

        // 提取继承关系
        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
              for (const type of clause.types) {
                const superName = type.expression.getText();
                const superId = this.resolveSymbolId(type.expression, superName, relativePath, nodes);
                if (superId) {
                  edges.push({
                    from: id,
                    to: superId,
                    type: 'extends',
                    loc: { path: relativePath, line: sourceFile.getLineAndCharacterOfPosition(type.getStart()).line + 1 },
                  });
                }
              }
            } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
              for (const type of clause.types) {
                const interfaceName = type.expression.getText();
                const interfaceId = this.resolveSymbolId(type.expression, interfaceName, relativePath, nodes);
                if (interfaceId) {
                  edges.push({
                    from: id,
                    to: interfaceId,
                    type: 'implements',
                    loc: { path: relativePath, line: sourceFile.getLineAndCharacterOfPosition(type.getStart()).line + 1 },
                  });
                }
              }
            }
          }
        }

        // 提取类方法
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
            const methodName = member.name.text;
            const methodId = `${relativePath}::${name}.${methodName}`;

            nodes[methodId] = {
              id: methodId,
              kind: 'method',
              name: methodName,
              exported: false,
              signature: this.getSignature(member),
              loc: {
                path: relativePath,
                line: sourceFile.getLineAndCharacterOfPosition(member.getStart()).line + 1,
              },
              container: name,
            };

            // 提取方法体中的调用
            if (member.body) {
              this.extractCalls(member.body, methodId, relativePath, edges, nodes);
            }
          }
        }
      }

      // 提取接口声明
      if (ts.isInterfaceDeclaration(node)) {
        const name = node.name.text;
        const id = `${relativePath}::${name}`;
        const exported = this.isExported(node);

        nodes[id] = {
          id,
          kind: 'interface',
          name,
          exported,
          signature: `interface ${name}`,
          loc: {
            path: relativePath,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          },
        };

        // 提取接口继承
        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            for (const type of clause.types) {
              const superName = type.expression.getText();
              const superId = this.resolveSymbolId(type.expression, superName, relativePath, nodes);
              if (superId) {
                edges.push({
                  from: id,
                  to: superId,
                  type: 'extends',
                });
              }
            }
          }
        }
      }

      // 提取类型别名
      if (ts.isTypeAliasDeclaration(node)) {
        const name = node.name.text;
        const id = `${relativePath}::${name}`;
        const exported = this.isExported(node);

        nodes[id] = {
          id,
          kind: 'type',
          name,
          exported,
          signature: `type ${name}`,
          loc: {
            path: relativePath,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          },
        };
      }

      // 提取常量声明（仅 exported）
      if (ts.isVariableStatement(node) && this.isExported(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const name = decl.name.text;
            const id = `${relativePath}::${name}`;

            nodes[id] = {
              id,
              kind: 'const',
              name,
              exported: true,
              signature: `const ${name}`,
              loc: {
                path: relativePath,
                line: sourceFile.getLineAndCharacterOfPosition(decl.getStart()).line + 1,
              },
            };
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, container));
    };

    visit(sourceFile);
  }

  /**
   * 提取函数/方法体中的调用关系
   */
  private extractCalls(
    body: ts.Node,
    callerId: string,
    currentFile: string,
    edges: GraphEdge[],
    nodes: Record<string, GraphNode>,
  ): void {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const calleeName = this.getCallExpressionName(node);
        if (calleeName) {
              const calleeId = this.resolveSymbolId(node.expression, calleeName, currentFile, nodes);
          if (calleeId) {
            edges.push({
              from: callerId,
              to: calleeId,
              type: 'call',
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(body);
  }

  /**
   * 获取调用表达式的函数名
   */
  private getCallExpressionName(node: ts.CallExpression): string | null {
    const expr = node.expression;

    // 简单标识符调用：foo()
    if (ts.isIdentifier(expr)) {
      return expr.text;
    }

    // 属性访问调用：obj.method()
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
      return expr.name.text;
    }

    return null;
  }

  /** 从节点声明构建稳定的图节点 ID。 */
  private getDeclarationId(declaration: ts.Declaration): string | null {
    const sourceFile = declaration.getSourceFile();
    const relativePath = relative(this.workspaceRoot, sourceFile.fileName).replace(/\\/g, '/');

    if (ts.isMethodDeclaration(declaration) && declaration.name && ts.isIdentifier(declaration.name)) {
      const parent = declaration.parent;
      if (ts.isClassDeclaration(parent) && parent.name) {
        return `${relativePath}::${parent.name.text}.${declaration.name.text}`;
      }
    }

    if (
      (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration) ||
        ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)) &&
      declaration.name
    ) {
      return `${relativePath}::${declaration.name.text}`;
    }

    if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
      const statement = declaration.parent.parent;
      if (ts.isVariableStatement(statement) && this.isExported(statement)) {
        return `${relativePath}::${declaration.name.text}`;
      }
    }

    return null;
  }

  /**
   * 通过 TypeChecker 解析调用/heritage 引用。
   * 不能解析到图节点时返回 null，调用方随后会丢弃该边，避免 dangling edge。
   */
  private resolveSymbolId(
    reference: ts.Node,
    symbolName: string,
    currentFile: string,
    nodes: Record<string, GraphNode>,
  ): string | null {
    const checker = this.typeChecker;
    if (checker) {
      let symbol = checker.getSymbolAtLocation(reference);
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        const aliased = checker.getAliasedSymbol(symbol);
        if (aliased !== symbol) symbol = aliased;
      }

      const declaration = symbol?.declarations?.find((decl) => this.getDeclarationId(decl) !== null);
      const declarationId = declaration ? this.getDeclarationId(declaration) : null;
      if (declarationId && nodes[declarationId]) return declarationId;
      // The declaration can be visited after the reference. Return its stable ID
      // here; the final edge validation below will discard non-graph declarations.
      if (declarationId) return declarationId;
    }

    const localId = `${currentFile}::${symbolName}`;
    return nodes[localId] ? localId : null;
  }

  /** 创建一个用于语义和图查询的节点名称索引。 */
  private buildNameIndex(nodes: Record<string, GraphNode>): Map<string, GraphNode[]> {
    const index = new Map<string, GraphNode[]>();
    for (const node of Object.values(nodes)) {
      const key = node.name.toLowerCase();
      const bucket = index.get(key) || [];
      bucket.push(node);
      index.set(key, bucket);
    }
    return index;
  }

  /** Remove duplicate and dangling edges after all source nodes are collected. */
  private finalizeEdges(nodes: Record<string, GraphNode>, edges: GraphEdge[]): GraphEdge[] {
    const seen = new Set<string>();
    return edges.filter((edge) => {
      if (!nodes[edge.from] || !nodes[edge.to]) return false;
      const key = `${edge.from}::${edge.to}::${edge.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * 判断节点是否被导出
   */
  private isExported(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (!modifiers) return false;
    return modifiers.some(
      (mod) => mod.kind === ts.SyntaxKind.ExportKeyword,
    );
  }

  /**
   * 获取函数/方法签名
   */
  private getSignature(node: ts.FunctionDeclaration | ts.MethodDeclaration): string {
    const text = node.getText();
    // 简化：只取第一行（函数声明行）
    const firstLine = text.split('\n')[0] || '';
    return firstLine.trim().slice(0, 120);
  }

  /**
   * 查找所有源文件
   */
  private async findSourceFiles(options: BuildOptions): Promise<string[]> {
    const patterns = [
      '**/*.ts',
      '**/*.tsx',
      '**/*.js',
      '**/*.jsx',
    ];

    const ignorePatterns = [
      ...(options.ignorePatterns || []),
      ...DEFAULT_IGNORE_PATTERNS,
    ];

    if (!options.includeTests) {
      ignorePatterns.push('**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx');
    }

    const files: string[] = [];
    for (const pattern of patterns) {
      const matches = await globAsync(pattern, {
        cwd: this.workspaceRoot,
        ignore: ignorePatterns,
        absolute: true,
        nodir: true,
      });
      files.push(...matches);
    }

    // 去重
    const uniqueFiles = Array.from(new Set(files));

    // 限制文件数
    const maxFiles = options.maxFiles || 2000;
    if (uniqueFiles.length > maxFiles) {
      console.warn(`[GraphBuilder] Too many files (${uniqueFiles.length}), limiting to ${maxFiles}`);
      return uniqueFiles.slice(0, maxFiles);
    }

    return uniqueFiles;
  }

  /**
   * 创建空图
   */
  private createEmptyGraph(): CodeGraph {
    return {
      version: 1,
      generated: Date.now(),
      root: this.workspaceRoot,
      nodes: {},
      edges: [],
      stats: {
        nodeCount: 0,
        edgeCount: 0,
        fileCount: 0,
      },
    };
  }

  /**
   * 从指定文件列表构建子图（用于增量更新）
   */
  async buildFromFiles(filePaths: string[]): Promise<CodeGraph> {
    if (filePaths.length === 0) {
      return this.createEmptyGraph();
    }

    // 创建 Program（仅包含指定文件）
    const absolutePaths = filePaths.map(f => resolve(this.workspaceRoot, f));

    this.program = ts.createProgram(absolutePaths, {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
      skipDefaultLibCheck: true,
    });
    this.typeChecker = this.program.getTypeChecker();

    const nodes: Record<string, GraphNode> = {};
    const edges: GraphEdge[] = [];

    // Same Windows separator mismatch as build(): normalize before matching.
    const absoluteSet = new Set(absolutePaths.map((file) => file.replace(/\\/g, '/')));
    for (const sourceFile of this.program.getSourceFiles()) {
      if (!absoluteSet.has(sourceFile.fileName.replace(/\\/g, '/'))) continue;

      const relativePath = relative(this.workspaceRoot, sourceFile.fileName).replace(/\\/g, '/');
      this.extractFromSourceFile(sourceFile, relativePath, nodes, edges);
    }

    const finalizedEdges = this.finalizeEdges(nodes, edges);
    return {
      version: 1,
      generated: Date.now(),
      root: this.workspaceRoot,
      nodes,
      edges: finalizedEdges,
      sourceFiles: filePaths.map((file) => file.replace(/\\/g, '/')),
      stats: {
        nodeCount: Object.keys(nodes).length,
        edgeCount: finalizedEdges.length,
        fileCount: filePaths.length,
      },
    };
  }
}
