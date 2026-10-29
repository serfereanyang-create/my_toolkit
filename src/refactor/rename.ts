/**
 * rename.ts — 安全重命名重构工具
 * 
 * 跨文件安全重命名符号（变量、函数、类、方法等），基于 TypeScript 语义分析
 * 包括：
 * - 精确的符号引用查找（使用 ts_exact_references）
 * - 字符串字面量检测（如 API 路由名）
 * - 生成 diff 预览
 * - 冲突检测
 */

import * as ts from 'typescript';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { referencesAt } from '../language/tsService.js';

/**
 * 重命名配置
 */
export interface RenameOptions {
  /** 目标文件路径 */
  file: string;
  /** 符号位置（行号，1-based） */
  line: number;
  /** 符号位置（列号，1-based） */
  column: number;
  /** 新名称 */
  newName: string;
  /** 是否同时更新字符串字面量中的引用 */
  updateStringLiterals?: boolean;
  /** 是否更新注释中的引用 */
  updateComments?: boolean;
}

/**
 * 单个文件的重命名更改
 */
export interface FileRename {
  /** 文件路径 */
  path: string;
  /** 原始内容 */
  original: string;
  /** 修改后内容 */
  modified: string;
  /** 替换次数 */
  replacementCount: number;
  /** 具体替换位置 */
  replacements: Array<{
    line: number;
    column: number;
    oldText: string;
    newText: string;
  }>;
}

/**
 * 重命名结果
 */
export interface RenameResult {
  /** 原始符号名 */
  oldName: string;
  /** 新符号名 */
  newName: string;
  /** 受影响的文件 */
  files: FileRename[];
  /** 总替换次数 */
  totalReplacements: number;
  /** 是否安全 */
  isSafe: boolean;
  /** 警告信息 */
  warnings: string[];
  /** 错误信息 */
  errors: string[];
}

/**
 * 冲突检测结果
 */
interface ConflictCheck {
  hasConflict: boolean;
  conflicts: Array<{
    file: string;
    line: number;
    message: string;
  }>;
}

/**
 * 获取符号名称
 */
function getSymbolName(
  sourceFile: ts.SourceFile,
  position: number
): string | null {
  function findNodeAt(node: ts.Node): ts.Node | null {
    if (node.getStart(sourceFile) <= position && position <= node.getEnd()) {
      let child: ts.Node | null = null;
      ts.forEachChild(node, (n) => {
        const found = findNodeAt(n);
        if (found) child = found;
      });
      return child || node;
    }
    return null;
  }
  
  const node = findNodeAt(sourceFile);
  
  if (node && ts.isIdentifier(node)) {
    return node.text;
  }
  
  return null;
}

/**
 * 检查新名称是否与现有符号冲突
 */
async function checkConflicts(
  workspaceRoot: string,
  file: string,
  newName: string,
  affectedFiles: string[]
): Promise<ConflictCheck> {
  const conflicts: ConflictCheck['conflicts'] = [];
  
  for (const filePath of affectedFiles) {
    try {
      const absolutePath = resolve(workspaceRoot, filePath);
      const content = await readFile(absolutePath, 'utf-8');
      
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true
      );
      
      // 查找所有标识符
      function visit(node: ts.Node) {
        if (ts.isIdentifier(node) && node.text === newName) {
          // 检查是否是声明
          if (ts.isVariableDeclaration(node.parent) ||
              ts.isFunctionDeclaration(node.parent) ||
              ts.isClassDeclaration(node.parent) ||
              ts.isInterfaceDeclaration(node.parent) ||
              ts.isTypeAliasDeclaration(node.parent) ||
              ts.isEnumDeclaration(node.parent)) {
            const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            conflicts.push({
              file: filePath,
              line: pos.line + 1,
              message: `名称 '${newName}' 已被使用（${node.parent.kind}）`,
            });
          }
        }
        ts.forEachChild(node, visit);
      }
      
      visit(sourceFile);
    } catch (err) {
      // 忽略无法读取的文件
    }
  }
  
  return {
    hasConflict: conflicts.length > 0,
    conflicts,
  };
}

/**
 * 查找字符串字面量中的引用
 */
function findStringLiteralReferences(
  sourceFile: ts.SourceFile,
  oldName: string
): Array<{ line: number; column: number; text: string }> {
  const references: Array<{ line: number; column: number; text: string }> = [];
  
  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text;
      if (text.includes(oldName)) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart() + 1); // +1 跳过引号
        references.push({
          line: pos.line + 1,
          column: pos.character + 1,
          text,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  return references;
}

/**
 * 查找注释中的引用
 */
function findCommentReferences(
  sourceFile: ts.SourceFile,
  oldName: string
): Array<{ line: number; column: number; text: string }> {
  const references: Array<{ line: number; column: number; text: string }> = [];
  const fullText = sourceFile.getFullText();
  
  // 查找所有注释
  const commentRanges = ts.getLeadingCommentRanges(fullText, 0) || [];
  commentRanges.push(...(ts.getTrailingCommentRanges(fullText, 0) || []));
  
  for (const range of commentRanges) {
    const commentText = fullText.substring(range.pos, range.end);
    if (commentText.includes(oldName)) {
      const pos = sourceFile.getLineAndCharacterOfPosition(range.pos);
      references.push({
        line: pos.line + 1,
        column: pos.character + 1,
        text: commentText,
      });
    }
  }
  
  return references;
}

/**
 * 执行文件内容替换
 */
function replaceInFile(
  content: string,
  replacements: Array<{ offset: number; length: number; newText: string }>
): string {
  // 按偏移量倒序排序，从后往前替换，避免偏移量变化
  replacements.sort((a, b) => b.offset - a.offset);

  let result = content;
  for (const { offset, length, newText } of replacements) {
    result = result.substring(0, offset) + newText + result.substring(offset + length);
  }

  return result;
}

/**
 * 语法健康度：返回 ParseDiagnostics 数量。
 *
 * 重构是破坏性操作，写完必须校验：只要改写前能解析、改写后不能解析，
 * 就说明这次改写把源码弄坏了。TS 的 parseDiagnostics 是内部字段，
 * 但自 TS 1.x 起一直存在，且比 getPreEmitDiagnostics 便宜得多（不建 Program）。
 */
function syntaxErrorCount(text: string, fileName: string): number {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  return Array.isArray(diagnostics) ? diagnostics.length : 0;
}

/**
 * 执行重命名重构
 */
export async function renameSymbol(
  workspaceRoot: string,
  options: RenameOptions
): Promise<RenameResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // 验证新名称
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(options.newName)) {
    errors.push(`无效的标识符名称: ${options.newName}`);
    return {
      oldName: '',
      newName: options.newName,
      files: [],
      totalReplacements: 0,
      isSafe: false,
      warnings,
      errors,
    };
  }
  
  // 读取目标文件
  const targetPath = resolve(workspaceRoot, options.file);
  const content = await readFile(targetPath, 'utf-8');
  
  const sourceFile = ts.createSourceFile(
    options.file,
    content,
    ts.ScriptTarget.Latest,
    true
  );
  
  // 计算位置偏移
  const lines = content.split('\n');
  const offset = lines.slice(0, options.line - 1).join('\n').length + 
                 (options.line > 1 ? 1 : 0) + 
                 options.column - 1;
  
  // 获取原始符号名
  const oldName = getSymbolName(sourceFile, offset);
  
  if (!oldName) {
    errors.push('未找到有效的符号');
    return {
      oldName: '',
      newName: options.newName,
      files: [],
      totalReplacements: 0,
      isSafe: false,
      warnings,
      errors,
    };
  }
  
  if (oldName === options.newName) {
    warnings.push('新名称与旧名称相同，无需重命名');
    return {
      oldName,
      newName: options.newName,
      files: [],
      totalReplacements: 0,
      isSafe: true,
      warnings,
      errors,
    };
  }
  
  // 使用 TypeScript 语言服务查找所有引用
  const references = await referencesAt(
    workspaceRoot,
    options.file,
    options.line,
    options.column
  );
  
  if (!references || references.length === 0) {
    warnings.push('未找到符号引用，可能是私有符号或未导出');
  }
  
  // 按文件分组
  const fileGroups = new Map<string, typeof references>();
  for (const ref of references || []) {
    if (!fileGroups.has(ref.path)) {
      fileGroups.set(ref.path, []);
    }
    fileGroups.get(ref.path)!.push(ref);
  }
  
  const affectedFiles = Array.from(fileGroups.keys());
  
  // 检查命名冲突
  const conflictCheck = await checkConflicts(
    workspaceRoot,
    options.file,
    options.newName,
    affectedFiles
  );
  
  if (conflictCheck.hasConflict) {
    for (const conflict of conflictCheck.conflicts) {
      errors.push(`${conflict.file}:${conflict.line} - ${conflict.message}`);
    }
  }
  
  // 处理每个文件的重命名
  const fileRenames: FileRename[] = [];
  let totalReplacements = 0;
  
  for (const [filePath, refs] of fileGroups) {
    const absolutePath = resolve(workspaceRoot, filePath);
    const fileContent = await readFile(absolutePath, 'utf-8');
    
    const replacements: Array<{ offset: number; length: number; newText: string }> = [];
    const replacementDetails: FileRename['replacements'] = [];
    
    // 添加符号引用替换
    //
    // length 必须用引用自身的区间（endColumn - column），不能固定成
    // oldName.length：对 `obj.foo`、解构 `{ foo }` 之类，语言服务返回的区间
    // 可能更长（含属性访问链），按旧名长度截断会把 `.foo` 的尾巴留在原地，
    // 结果就是 `obj.value.foo` 这种坏代码。
    for (const ref of refs) {
      const lines = fileContent.split('\n');
      const offset = lines.slice(0, ref.range.line - 1).join('\n').length +
                    (ref.range.line > 1 ? 1 : 0) +
                    ref.range.column - 1;
      const referenceLength = ref.range.endColumn - ref.range.column;

      replacements.push({
        offset,
        length: referenceLength > 0 ? referenceLength : oldName.length,
        newText: options.newName,
      });

      replacementDetails.push({
        line: ref.range.line,
        column: ref.range.column,
        oldText: (lines[ref.range.line - 1] ?? '').slice(ref.range.column - 1, Math.max(ref.range.column - 1, ref.range.endColumn - 1)) || oldName,
        newText: options.newName,
      });
    }
    
    // 字符串字面量（可选）
    if (options.updateStringLiterals) {
      const fileSourceFile = ts.createSourceFile(
        filePath,
        fileContent,
        ts.ScriptTarget.Latest,
        true
      );
      
      const stringRefs = findStringLiteralReferences(fileSourceFile, oldName);
      for (const ref of stringRefs) {
        warnings.push(
          `${filePath}:${ref.line} - 字符串字面量包含 '${oldName}': "${ref.text}"`
        );
        // 可以选择自动替换，这里仅警告
      }
    }
    
    // 注释（可选）
    if (options.updateComments) {
      const fileSourceFile = ts.createSourceFile(
        filePath,
        fileContent,
        ts.ScriptTarget.Latest,
        true
      );
      
      const commentRefs = findCommentReferences(fileSourceFile, oldName);
      for (const ref of commentRefs) {
        warnings.push(
          `${filePath}:${ref.line} - 注释包含 '${oldName}': ${ref.text.substring(0, 50)}...`
        );
      }
    }
    
    // 执行替换：同一偏移去重，区间重叠的引用只保留先出现的一条，
    // 避免 `obj.foo` 与 `foo` 两个区间同时改写导致二次污染。
    const uniqueReplacements = [...new Map(replacements.map((r) => [`${r.offset}:${r.length}`, r])).values()]
      .sort((a, b) => a.offset - b.offset)
      .filter((r, index, list) => {
        if (index === 0) return true;
        const previous = list[index - 1]!;
        return r.offset >= previous.offset + previous.length;
      });
    const modified = replaceInFile(fileContent, uniqueReplacements);

    // 改写前能解析、改写后不能解析 → 拒绝，不把坏代码写进结果。
    const beforeErrors = syntaxErrorCount(fileContent, filePath);
    const afterErrors = syntaxErrorCount(modified, filePath);
    if (afterErrors > beforeErrors) {
      errors.push(
        `${filePath} - 重命名会让文件产生 ${afterErrors - beforeErrors} 处语法错误，已拒绝（原文件 ${beforeErrors} 处）`,
      );
    }

    fileRenames.push({
      path: relative(workspaceRoot, absolutePath),
      original: fileContent,
      modified,
      replacementCount: uniqueReplacements.length,
      replacements: replacementDetails.slice(0, uniqueReplacements.length),
    });

    totalReplacements += uniqueReplacements.length;
  }
  
  const isSafe = errors.length === 0 && !conflictCheck.hasConflict;
  
  return {
    oldName,
    newName: options.newName,
    files: fileRenames,
    totalReplacements,
    isSafe,
    warnings,
    errors,
  };
}

/**
 * 应用重命名更改（实际写入文件）
 */
export async function applyRename(
  workspaceRoot: string,
  result: RenameResult
): Promise<void> {
  if (!result.isSafe) {
    throw new Error('重命名不安全，存在错误：\n' + result.errors.join('\n'));
  }
  
  for (const file of result.files) {
    const absolutePath = resolve(workspaceRoot, file.path);
    await writeFile(absolutePath, file.modified, 'utf-8');
  }
}

/**
 * 生成 diff 格式预览
 */
export function generateDiff(result: RenameResult): string {
  const lines: string[] = [];
  
  lines.push(`重命名 '${result.oldName}' → '${result.newName}'`);
  lines.push(`总计替换 ${result.totalReplacements} 处，涉及 ${result.files.length} 个文件\n`);
  
  if (result.errors.length > 0) {
    lines.push('❌ 错误：');
    for (const error of result.errors) {
      lines.push(`  - ${error}`);
    }
    lines.push('');
  }
  
  if (result.warnings.length > 0) {
    lines.push('⚠️  警告：');
    for (const warning of result.warnings) {
      lines.push(`  - ${warning}`);
    }
    lines.push('');
  }
  
  for (const file of result.files) {
    lines.push(`### ${file.path} (${file.replacementCount} 处替换)`);
    lines.push('');
    
    // 显示前10个替换位置
    for (const replacement of file.replacements.slice(0, 10)) {
      lines.push(`  ${replacement.line}:${replacement.column} - ${replacement.oldText} → ${replacement.newText}`);
    }
    
    if (file.replacements.length > 10) {
      lines.push(`  ... 还有 ${file.replacements.length - 10} 处`);
    }
    
    lines.push('');
    
    // 显示 unified diff（前30行）
    const originalLines = file.original.split('\n');
    const modifiedLines = file.modified.split('\n');
    
    let diffShown = 0;
    for (let i = 0; i < Math.min(originalLines.length, modifiedLines.length) && diffShown < 30; i++) {
      if (originalLines[i] !== modifiedLines[i]) {
        lines.push(`  ${i + 1} | -${originalLines[i]}`);
        lines.push(`  ${i + 1} | +${modifiedLines[i]}`);
        diffShown++;
      }
    }
    
    if (diffShown >= 30) {
      lines.push(`  ... (仅显示前30行差异)`);
    }
    
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * 快速重命名（单文件局部变量）
 *
 * 旧实现对整份文件做 `\boldName\b` 正则替换：同名的内层遮蔽变量、字符串字面量、
 * 注释、甚至别的对象上的同名属性都会被一起改掉（实测 `const s = "data"` 变成
 * `"payload"`，块内 `const data = 1` 也被换名）。这里改为用 TS 语言服务取
 * referencesAt 的精确引用（只含同一符号、不含字符串/注释），再按偏移量倒序替换。
 * 严格模式下找不到引用时拒绝，不退回正则。
 */
export async function quickRename(
  filePath: string,
  workspaceRoot: string,
  line: number,
  column: number,
  newName: string
): Promise<{ success: boolean; message: string; modified?: string; replacements?: number }> {
  try {
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(newName)) {
      return { success: false, message: `无效的标识符名称: ${newName}` };
    }

    const absolutePath = resolve(workspaceRoot, filePath);
    const content = await readFile(absolutePath, 'utf-8');

    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    const lines = content.split('\n');
    const offset = lines.slice(0, line - 1).join('\n').length +
                  (line > 1 ? 1 : 0) +
                  column - 1;

    const oldName = getSymbolName(sourceFile, offset);

    if (!oldName) {
      return { success: false, message: '未找到符号' };
    }

    if (oldName === newName) {
      return { success: true, message: `名称未变化（${oldName}）`, modified: content, replacements: 0 };
    }

    const normalizedSelf = relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
    const references = (await referencesAt(workspaceRoot, filePath, line, column))
      .filter((ref) => ref.path.replace(/\\/g, '/') === normalizedSelf);

    if (references.length === 0) {
      return {
        success: false,
        message: `语言服务未能在本文件定位符号 '${oldName}' 的引用，为避免误改已拒绝（未写入）`,
      };
    }

    // TS 语言服务的 getReferencesAtPosition 对声明处不一定返回定义项；
    // 声明本身也必须改，否则会留下旧的声明名。
    const edits = references.map((ref) => ({
      offset: lines.slice(0, ref.range.line - 1).join('\n').length + (ref.range.line > 1 ? 1 : 0) + ref.range.column - 1,
      length: Math.max(1, ref.range.endColumn - ref.range.column),
    }));
    const declarationStart = sourceFile.getLineAndCharacterOfPosition(offset);
    const declarationKey = `${declarationStart.line + 1}:${declarationStart.character + 1}`;
    if (!references.some((ref) => `${ref.range.line}:${ref.range.column}` === declarationKey)) {
      edits.push({ offset, length: oldName.length });
    }

    // 去重并倒序改写，避免偏移量互相污染。
    const unique = [...new Map(edits.map((e) => [`${e.offset}:${e.length}`, e])).values()]
      .sort((a, b) => b.offset - a.offset);
    let modified = content;
    for (const edit of unique) {
      modified = modified.substring(0, edit.offset) + newName + modified.substring(edit.offset + edit.length);
    }

    // 与 renameSymbol 同一道闸：改写后若语法错误变多，直接拒绝。
    const beforeErrors = syntaxErrorCount(content, filePath);
    const afterErrors = syntaxErrorCount(modified, filePath);
    if (afterErrors > beforeErrors) {
      return {
        success: false,
        message: `重命名会让文件产生 ${afterErrors - beforeErrors} 处语法错误，已拒绝（未写入）`,
      };
    }

    return {
      success: true,
      message: `已重命名 '${oldName}' → '${newName}'（${unique.length} 处）`,
      modified,
      replacements: unique.length,
    };
  } catch (error) {
    return {
      success: false,
      message: `重命名失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
