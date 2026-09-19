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
    for (const ref of refs) {
      const lines = fileContent.split('\n');
      const offset = lines.slice(0, ref.range.line - 1).join('\n').length + 
                    (ref.range.line > 1 ? 1 : 0) + 
                    ref.range.column - 1;
      
      replacements.push({
        offset,
        length: oldName.length,
        newText: options.newName,
      });
      
      replacementDetails.push({
        line: ref.range.line,
        column: ref.range.column,
        oldText: oldName,
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
    
    // 执行替换
    const modified = replaceInFile(fileContent, replacements);
    
    fileRenames.push({
      path: relative(workspaceRoot, absolutePath),
      original: fileContent,
      modified,
      replacementCount: replacements.length,
      replacements: replacementDetails,
    });
    
    totalReplacements += replacements.length;
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
 */
export async function quickRename(
  filePath: string,
  workspaceRoot: string,
  line: number,
  column: number,
  newName: string
): Promise<{ success: boolean; message: string; modified?: string }> {
  try {
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
    
    // 简单替换（仅当前文件）
    const regex = new RegExp(`\\b${oldName}\\b`, 'g');
    const modified = content.replace(regex, newName);
    
    return {
      success: true,
      message: `已重命名 '${oldName}' → '${newName}'`,
      modified,
    };
  } catch (error) {
    return {
      success: false,
      message: `重命名失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
