/**
 * doc-generator.ts — 文档生成器
 * 
 * 自动生成项目文档：
 * - API 文档
 * - 架构文档
 * - 开发指南
 * - Changelog
 * - README
 */

import * as ts from 'typescript';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { isIgnoredDirName } from '../workspace/ignored.js';

/**
 * API 条目类型
 */
export type APIEntryType = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'enum';

/**
 * API 条目
 */
export interface APIEntry {
  type: APIEntryType;
  name: string;
  file: string;
  line: number;
  exported: boolean;
  description?: string;
  signature?: string;
  parameters?: Array<{ name: string; type: string; description?: string }>;
  returnType?: string;
  examples?: string[];
  tags?: string[];
  deprecated?: boolean;
  since?: string;
}

/**
 * 模块信息
 */
export interface ModuleInfo {
  path: string;
  exports: APIEntry[];
  imports: string[];
  description?: string;
}

/**
 * 项目架构信息
 */
export interface ArchitectureInfo {
  modules: ModuleInfo[];
  dependencies: Map<string, string[]>;
  layers: Array<{
    name: string;
    modules: string[];
    description: string;
  }>;
  entryPoints: string[];
}

/**
 * 提取 JSDoc 注释
 */
function extractJSDoc(node: ts.Node, sourceFile: ts.SourceFile): {
  description?: string;
  parameters?: Map<string, string>;
  returns?: string;
  examples?: string[];
  tags?: string[];
  deprecated?: boolean;
  since?: string;
} {
  const jsDocTags = ts.getJSDocTags(node);
  const jsDoc = (node as any).jsDoc?.[0];
  
  let description: string | undefined;
  const parameters = new Map<string, string>();
  let returns: string | undefined;
  const examples: string[] = [];
  const tags: string[] = [];
  let deprecated = false;
  let since: string | undefined;
  
  if (jsDoc && jsDoc.comment) {
    description = typeof jsDoc.comment === 'string' 
      ? jsDoc.comment 
      : jsDoc.comment.map((c: any) => c.text).join('');
  }
  
  for (const tag of jsDocTags) {
    const tagName = tag.tagName.text;
    const comment = tag.comment;
    const commentText = typeof comment === 'string' 
      ? comment 
      : comment?.map((c: any) => c.text).join('') || '';
    
    if (tagName === 'param') {
      const paramName = (tag as any).name?.getText(sourceFile);
      if (paramName) {
        parameters.set(paramName, commentText);
      }
    } else if (tagName === 'returns' || tagName === 'return') {
      returns = commentText;
    } else if (tagName === 'example') {
      examples.push(commentText);
    } else if (tagName === 'deprecated') {
      deprecated = true;
    } else if (tagName === 'since') {
      since = commentText;
    } else {
      tags.push(tagName);
    }
  }
  
  return { description, parameters, returns, examples, tags, deprecated, since };
}

/**
 * 提取函数信息
 */
function extractFunctionInfo(
  node: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string
): APIEntry | null {
  if (!node.name) return null;
  
  const name = node.name.text;
  const exported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) || false;
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  
  const jsDoc = extractJSDoc(node, sourceFile);
  
  const parameters: APIEntry['parameters'] = node.parameters.map(param => {
    const paramName = ts.isIdentifier(param.name) ? param.name.text : '?';
    const paramType = param.type ? param.type.getText(sourceFile) : 'any';
    const description = jsDoc.parameters?.get(paramName);
    
    return { name: paramName, type: paramType, description };
  });
  
  const returnType = node.type ? node.type.getText(sourceFile) : 'void';
  const signature = `${name}(${parameters.map(p => `${p.name}: ${p.type}`).join(', ')}): ${returnType}`;
  
  return {
    type: 'function',
    name,
    file: filePath,
    line: pos.line + 1,
    exported,
    description: jsDoc.description,
    signature,
    parameters,
    returnType,
    examples: jsDoc.examples,
    tags: jsDoc.tags,
    deprecated: jsDoc.deprecated,
    since: jsDoc.since,
  };
}

/**
 * 提取类信息
 */
function extractClassInfo(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string
): APIEntry | null {
  if (!node.name) return null;
  
  const name = node.name.text;
  const exported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) || false;
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  
  const jsDoc = extractJSDoc(node, sourceFile);
  
  // 提取方法
  const methods: string[] = [];
  for (const member of node.members) {
    if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
      methods.push(member.name.text);
    }
  }
  
  return {
    type: 'class',
    name,
    file: filePath,
    line: pos.line + 1,
    exported,
    description: jsDoc.description,
    signature: `class ${name} { ${methods.join(', ')} }`,
    examples: jsDoc.examples,
    tags: jsDoc.tags,
    deprecated: jsDoc.deprecated,
    since: jsDoc.since,
  };
}

/**
 * 提取接口信息
 */
function extractInterfaceInfo(
  node: ts.InterfaceDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string
): APIEntry {
  const name = node.name.text;
  const exported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) || false;
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  
  const jsDoc = extractJSDoc(node, sourceFile);
  
  // 提取属性
  const properties: string[] = [];
  for (const member of node.members) {
    if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
      const propName = member.name.text;
      const propType = member.type ? member.type.getText(sourceFile) : 'any';
      properties.push(`${propName}: ${propType}`);
    }
  }
  
  return {
    type: 'interface',
    name,
    file: filePath,
    line: pos.line + 1,
    exported,
    description: jsDoc.description,
    signature: `interface ${name} { ${properties.slice(0, 3).join(', ')}${properties.length > 3 ? '...' : ''} }`,
    tags: jsDoc.tags,
    deprecated: jsDoc.deprecated,
    since: jsDoc.since,
  };
}

/**
 * 分析文件提取 API
 */
export async function extractAPIFromFile(
  filePath: string,
  workspaceRoot: string
): Promise<APIEntry[]> {
  const absolutePath = resolve(workspaceRoot, filePath);
  const content = await readFile(absolutePath, 'utf-8');
  
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );
  
  const apis: APIEntry[] = [];
  
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node)) {
      const info = extractFunctionInfo(node, sourceFile, filePath);
      if (info) apis.push(info);
    } else if (ts.isClassDeclaration(node)) {
      const info = extractClassInfo(node, sourceFile, filePath);
      if (info) apis.push(info);
    } else if (ts.isInterfaceDeclaration(node)) {
      const info = extractInterfaceInfo(node, sourceFile, filePath);
      apis.push(info);
    } else if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      const exported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) || false;
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      
      apis.push({
        type: 'type',
        name,
        file: filePath,
        line: pos.line + 1,
        exported,
        signature: `type ${name} = ${node.type.getText(sourceFile)}`,
      });
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  
  return apis;
}

/**
 * 生成 API 文档
 */
export function generateAPIDocumentation(apis: APIEntry[]): string {
  const lines: string[] = [];
  
  lines.push('# API 文档\n');
  
  // 按类型分组
  const byType = new Map<APIEntryType, APIEntry[]>();
  for (const api of apis) {
    if (!byType.has(api.type)) {
      byType.set(api.type, []);
    }
    byType.get(api.type)!.push(api);
  }
  
  // 函数
  if (byType.has('function')) {
    lines.push('## 函数\n');
    
    for (const func of byType.get('function')!) {
      if (func.deprecated) {
        lines.push(`### ~~${func.name}~~ (已废弃)\n`);
      } else {
        lines.push(`### ${func.name}\n`);
      }
      
      if (func.description) {
        lines.push(func.description);
        lines.push('');
      }
      
      if (func.signature) {
        lines.push('```typescript');
        lines.push(func.signature);
        lines.push('```\n');
      }
      
      if (func.parameters && func.parameters.length > 0) {
        lines.push('**参数:**\n');
        for (const param of func.parameters) {
          lines.push(`- \`${param.name}\` (\`${param.type}\`)${param.description ? ': ' + param.description : ''}`);
        }
        lines.push('');
      }
      
      if (func.returnType && func.returnType !== 'void') {
        lines.push(`**返回值:** \`${func.returnType}\`\n`);
      }
      
      if (func.examples && func.examples.length > 0) {
        lines.push('**示例:**\n');
        for (const example of func.examples) {
          lines.push('```typescript');
          lines.push(example);
          lines.push('```\n');
        }
      }
      
      lines.push(`*定义于: [${func.file}:${func.line}](${func.file}#L${func.line})*\n`);
      lines.push('---\n');
    }
  }
  
  // 类
  if (byType.has('class')) {
    lines.push('## 类\n');
    
    for (const cls of byType.get('class')!) {
      lines.push(`### ${cls.name}\n`);
      
      if (cls.description) {
        lines.push(cls.description);
        lines.push('');
      }
      
      if (cls.signature) {
        lines.push('```typescript');
        lines.push(cls.signature);
        lines.push('```\n');
      }
      
      lines.push(`*定义于: [${cls.file}:${cls.line}](${cls.file}#L${cls.line})*\n`);
      lines.push('---\n');
    }
  }
  
  // 接口
  if (byType.has('interface')) {
    lines.push('## 接口\n');
    
    for (const iface of byType.get('interface')!) {
      lines.push(`### ${iface.name}\n`);
      
      if (iface.description) {
        lines.push(iface.description);
        lines.push('');
      }
      
      if (iface.signature) {
        lines.push('```typescript');
        lines.push(iface.signature);
        lines.push('```\n');
      }
      
      lines.push(`*定义于: [${iface.file}:${iface.line}](${iface.file}#L${iface.line})*\n`);
      lines.push('---\n');
    }
  }
  
  // 类型别名
  if (byType.has('type')) {
    lines.push('## 类型\n');
    
    for (const type of byType.get('type')!) {
      lines.push(`### ${type.name}\n`);
      
      if (type.signature) {
        lines.push('```typescript');
        lines.push(type.signature);
        lines.push('```\n');
      }
      
      lines.push(`*定义于: [${type.file}:${type.line}](${type.file}#L${type.line})*\n`);
      lines.push('---\n');
    }
  }
  
  return lines.join('\n');
}

/**
 * 分析项目架构
 */
export async function analyzeArchitecture(
  rootDir: string,
  workspaceRoot: string
): Promise<ArchitectureInfo> {
  const modules: ModuleInfo[] = [];
  const dependencies = new Map<string, string[]>();
  
  async function scanDirectory(dir: string) {
    const entries = await readdir(resolve(workspaceRoot, dir), { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      
      if (entry.isDirectory()) {
        if (!isIgnoredDirName(entry.name)) {
          await scanDirectory(fullPath);
        }
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const apis = await extractAPIFromFile(fullPath, workspaceRoot);
        const exports = apis.filter(api => api.exported);
        
        // 提取导入
        const content = await readFile(resolve(workspaceRoot, fullPath), 'utf-8');
        const imports: string[] = [];
        
        const importRegex = /import\s+.*?\s+from\s+['"](.+?)['"]/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
          imports.push(match[1]);
        }
        
        modules.push({
          path: fullPath,
          exports,
          imports,
        });
        
        dependencies.set(fullPath, imports);
      }
    }
  }
  
  await scanDirectory(rootDir);
  
  // 识别分层架构
  const layers: ArchitectureInfo['layers'] = [];
  
  const layerPatterns = [
    { name: '表现层', pattern: /\/(components|views|pages|ui)\//i, description: 'UI 组件和视图' },
    { name: '业务层', pattern: /\/(services|business|domain)\//i, description: '业务逻辑' },
    { name: '数据层', pattern: /\/(data|repositories|models)\//i, description: '数据访问' },
    { name: '工具层', pattern: /\/(utils|helpers|lib)\//i, description: '通用工具' },
  ];
  
  for (const layerDef of layerPatterns) {
    const layerModules = modules
      .filter(m => layerDef.pattern.test(m.path))
      .map(m => m.path);
    
    if (layerModules.length > 0) {
      layers.push({
        name: layerDef.name,
        modules: layerModules,
        description: layerDef.description,
      });
    }
  }
  
  // 识别入口点
  const entryPoints = modules
    .filter(m => /index\.(ts|js)$/.test(m.path) || /main\.(ts|js)$/.test(m.path))
    .map(m => m.path);
  
  return {
    modules,
    dependencies,
    layers,
    entryPoints,
  };
}

/**
 * 生成架构文档
 */
export function generateArchitectureDoc(arch: ArchitectureInfo): string {
  const lines: string[] = [];
  
  lines.push('# 项目架构文档\n');
  
  // 概览
  lines.push('## 概览\n');
  lines.push(`**模块总数:** ${arch.modules.length}`);
  lines.push(`**入口点:** ${arch.entryPoints.length} 个\n`);
  
  // 分层架构
  if (arch.layers.length > 0) {
    lines.push('## 分层架构\n');
    
    for (const layer of arch.layers) {
      lines.push(`### ${layer.name}`);
      lines.push(layer.description);
      lines.push(`\n**模块数:** ${layer.modules.length}\n`);
    }
  }
  
  // 入口点
  if (arch.entryPoints.length > 0) {
    lines.push('## 入口点\n');
    for (const entry of arch.entryPoints) {
      lines.push(`- \`${entry}\``);
    }
    lines.push('');
  }
  
  // 依赖关系
  lines.push('## 关键模块\n');
  
  // 找出被依赖最多的模块
  const dependencyCount = new Map<string, number>();
  
  for (const [, deps] of arch.dependencies) {
    for (const dep of deps) {
      // 仅统计项目内部模块
      if (dep.startsWith('.') || dep.startsWith('@/')) {
        dependencyCount.set(dep, (dependencyCount.get(dep) || 0) + 1);
      }
    }
  }
  
  const topDeps = Array.from(dependencyCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  
  if (topDeps.length > 0) {
    lines.push('**被依赖最多的模块:**\n');
    for (const [module, count] of topDeps) {
      lines.push(`- \`${module}\`: ${count} 个模块依赖`);
    }
    lines.push('');
  }
  
  // 导出统计
  const totalExports = arch.modules.reduce((sum, m) => sum + m.exports.length, 0);
  lines.push('## 导出统计\n');
  lines.push(`**总导出数:** ${totalExports}`);
  
  const avgExports = totalExports / arch.modules.length;
  lines.push(`**平均每模块导出:** ${avgExports.toFixed(1)} 个\n`);
  
  return lines.join('\n');
}

/**
 * 生成 README
 */
export function generateREADME(options: {
  projectName: string;
  description: string;
  features?: string[];
  installation?: string;
  usage?: string;
  architecture?: ArchitectureInfo;
}): string {
  const lines: string[] = [];
  
  lines.push(`# ${options.projectName}\n`);
  lines.push(options.description);
  lines.push('');
  
  // 特性
  if (options.features && options.features.length > 0) {
    lines.push('## ✨ 特性\n');
    for (const feature of options.features) {
      lines.push(`- ${feature}`);
    }
    lines.push('');
  }
  
  // 安装
  if (options.installation) {
    lines.push('## 📦 安装\n');
    lines.push('```bash');
    lines.push(options.installation);
    lines.push('```\n');
  }
  
  // 使用
  if (options.usage) {
    lines.push('## 🚀 使用\n');
    lines.push('```typescript');
    lines.push(options.usage);
    lines.push('```\n');
  }
  
  // 架构
  if (options.architecture) {
    lines.push('## 🏗 架构\n');
    lines.push(`项目包含 ${options.architecture.modules.length} 个模块，采用分层架构：\n`);
    
    for (const layer of options.architecture.layers) {
      lines.push(`- **${layer.name}**: ${layer.description} (${layer.modules.length} 个模块)`);
    }
    lines.push('');
  }
  
  // 贡献
  lines.push('## 🤝 贡献\n');
  lines.push('欢迎提交 Pull Request 或 Issue！\n');
  
  // 许可
  lines.push('## 📄 许可\n');
  lines.push('MIT License\n');
  
  return lines.join('\n');
}
