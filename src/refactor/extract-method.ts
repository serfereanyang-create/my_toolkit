/**
 * extract-method.ts — Extract Method 重构引擎
 * 
 * 自动提取代码片段为独立方法/函数，包括：
 * - 变量作用域分析
 * - 参数和返回值推断
 * - 自动生成方法签名
 * - 处理多返回值场景
 */

import * as ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 提取方法配置
 */
export interface ExtractMethodOptions {
  /** 新方法名称 */
  methodName: string;
  /** 提取的代码范围（行号，1-based） */
  startLine: number;
  endLine: number;
  /** 是否生成为箭头函数（仅函数提取） */
  useArrowFunction?: boolean;
  /** 是否添加类型注解 */
  addTypeAnnotations?: boolean;
}

/**
 * 变量使用情况
 */
interface VariableUsage {
  name: string;
  /** 在选中区域内声明 */
  declaredInside: boolean;
  /** 在选中区域内读取 */
  readInside: boolean;
  /** 在选中区域内写入 */
  writtenInside: boolean;
  /** 在选中区域外读取 */
  readOutside: boolean;
  /** 在选中区域外写入（提取后） */
  writtenOutside: boolean;
  /** 变量类型 */
  type?: ts.Type;
}

/**
 * 提取方法结果
 */
export interface ExtractMethodResult {
  /** 提取的新方法代码 */
  extractedMethod: string;
  /** 调用新方法的代码 */
  callSite: string;
  /** 方法签名 */
  signature: {
    name: string;
    parameters: Array<{ name: string; type?: string }>;
    returnType?: string;
  };
  /** 变量分析结果 */
  variableAnalysis: {
    inputs: string[];    // 需要作为参数传入
    outputs: string[];   // 需要作为返回值返回
    internal: string[];  // 内部变量
  };
  /** 是否可以安全提取 */
  isSafe: boolean;
  /** 警告信息 */
  warnings: string[];
}

/**
 * 分析变量使用情况
 */
function analyzeVariableUsage(
  selectedNodes: ts.Node[],
  outerScope: ts.Node,
  sourceFile: ts.SourceFile,
  typeChecker?: ts.TypeChecker
): Map<string, VariableUsage> {
  const usageMap = new Map<string, VariableUsage>();
  const selectedNodesSet = new Set(selectedNodes);
  
  function isNodeInSelection(node: ts.Node): boolean {
    let current: ts.Node | undefined = node;
    while (current) {
      if (selectedNodesSet.has(current)) return true;
      current = current.parent;
    }
    return false;
  }
  
  function recordUsage(name: string, node: ts.Node, isWrite: boolean) {
    if (!usageMap.has(name)) {
      usageMap.set(name, {
        name,
        declaredInside: false,
        readInside: false,
        writtenInside: false,
        readOutside: false,
        writtenOutside: false,
      });
    }
    
    const usage = usageMap.get(name)!;
    const inSelection = isNodeInSelection(node);
    
    if (isWrite) {
      if (inSelection) {
        usage.writtenInside = true;
      } else {
        usage.writtenOutside = true;
      }
    } else {
      if (inSelection) {
        usage.readInside = true;
      } else {
        usage.readOutside = true;
      }
    }
    
    // 获取类型信息
    if (typeChecker && !usage.type) {
      try {
        const symbol = typeChecker.getSymbolAtLocation(node);
        if (symbol) {
          usage.type = typeChecker.getTypeOfSymbolAtLocation(symbol, node);
        }
      } catch {
        // 忽略类型获取失败
      }
    }
  }
  
  // 第一遍：找出所有在选中区域内声明的变量
  function findDeclarations(node: ts.Node) {
    if (!isNodeInSelection(node)) return;
    
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      if (!usageMap.has(name)) {
        usageMap.set(name, {
          name,
          declaredInside: true,
          readInside: false,
          writtenInside: false,
          readOutside: false,
          writtenOutside: false,
        });
      } else {
        usageMap.get(name)!.declaredInside = true;
      }
    }
    
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      // 函数参数也算声明
      const name = node.name.text;
      if (!usageMap.has(name)) {
        usageMap.set(name, {
          name,
          declaredInside: true,
          readInside: false,
          writtenInside: false,
          readOutside: false,
          writtenOutside: false,
        });
      } else {
        usageMap.get(name)!.declaredInside = true;
      }
    }
    
    ts.forEachChild(node, findDeclarations);
  }
  
  for (const node of selectedNodes) {
    findDeclarations(node);
  }
  
  // 第二遍：记录变量读写
  function recordUsages(node: ts.Node) {
    // 读取
    if (ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node.parent)) {
      const name = node.text;
      const isWrite = ts.isBinaryExpression(node.parent) && 
                      node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                      node.parent.left === node;
      recordUsage(name, node, isWrite);
    }
    
    // 赋值
    if (ts.isBinaryExpression(node) && 
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)) {
      recordUsage(node.left.text, node.left, true);
    }
    
    // 增量/减量操作
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || 
         node.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isIdentifier(node.operand)) {
      recordUsage(node.operand.text, node.operand, true);
    }
    
    ts.forEachChild(node, recordUsages);
  }
  
  // 遍历整个外部作用域
  recordUsages(outerScope);
  
  return usageMap;
}

/**
 * 推断参数和返回值
 */
function inferSignature(
  usageMap: Map<string, VariableUsage>,
  typeChecker?: ts.TypeChecker
): {
  inputs: Array<{ name: string; type?: string }>;
  outputs: Array<{ name: string; type?: string }>;
  warnings: string[];
} {
  const inputs: Array<{ name: string; type?: string }> = [];
  const outputs: Array<{ name: string; type?: string }> = [];
  const warnings: string[] = [];
  
  for (const [name, usage] of usageMap) {
    // 输入：外部声明，内部读取
    if (!usage.declaredInside && usage.readInside) {
      let typeStr: string | undefined;
      if (typeChecker && usage.type) {
        typeStr = typeChecker.typeToString(usage.type);
      }
      inputs.push({ name, type: typeStr });
    }
    
    // 输出：内部写入，外部读取
    if (usage.writtenInside && usage.readOutside) {
      let typeStr: string | undefined;
      if (typeChecker && usage.type) {
        typeStr = typeChecker.typeToString(usage.type);
      }
      outputs.push({ name, type: typeStr });
    }
    
    // 警告：内部声明但外部也写入（可能有命名冲突）
    if (usage.declaredInside && usage.writtenOutside) {
      warnings.push(`变量 '${name}' 在提取区域内声明，但在外部也有写入，可能存在命名冲突`);
    }
  }
  
  // 警告：多返回值
  if (outputs.length > 3) {
    warnings.push(`需要返回 ${outputs.length} 个值，考虑返回对象而非多返回值`);
  }
  
  return { inputs, outputs, warnings };
}

/**
 * 生成提取的方法代码
 */
function generateExtractedMethod(
  methodName: string,
  selectedCode: string,
  inputs: Array<{ name: string; type?: string }>,
  outputs: Array<{ name: string; type?: string }>,
  options: ExtractMethodOptions,
  isClassMethod: boolean
): string {
  const lines: string[] = [];
  
  // 生成参数列表
  const params = inputs.map(input => {
    if (options.addTypeAnnotations && input.type) {
      return `${input.name}: ${input.type}`;
    }
    return input.name;
  }).join(', ');
  
  // 生成返回类型
  let returnType = '';
  if (options.addTypeAnnotations && outputs.length > 0) {
    if (outputs.length === 1) {
      returnType = outputs[0].type ? `: ${outputs[0].type}` : '';
    } else {
      const types = outputs.map(o => o.type || 'any').join(', ');
      returnType = `: [${types}]`;
    }
  }
  
  // 生成函数签名
  if (options.useArrowFunction && !isClassMethod) {
    lines.push(`const ${methodName} = (${params})${returnType} => {`);
  } else {
    const methodKeyword = isClassMethod ? '' : 'function ';
    lines.push(`${methodKeyword}${methodName}(${params})${returnType} {`);
  }
  
  // 添加提取的代码（缩进）
  const indentedCode = selectedCode.split('\n').map(line => '  ' + line).join('\n');
  lines.push(indentedCode);
  
  // 生成返回语句
  if (outputs.length > 0) {
    if (outputs.length === 1) {
      lines.push(`  return ${outputs[0].name};`);
    } else {
      const returnValues = outputs.map(o => o.name).join(', ');
      lines.push(`  return [${returnValues}];`);
    }
  }
  
  lines.push('}');
  
  if (options.useArrowFunction && !isClassMethod) {
    lines.push(''); // 箭头函数后不需要分号
  }
  
  return lines.join('\n');
}

/**
 * 生成调用代码
 */
function generateCallSite(
  methodName: string,
  inputs: Array<{ name: string; type?: string }>,
  outputs: Array<{ name: string; type?: string }>,
  isClassMethod: boolean
): string {
  const args = inputs.map(i => i.name).join(', ');
  const call = isClassMethod ? `this.${methodName}(${args})` : `${methodName}(${args})`;
  
  if (outputs.length === 0) {
    return `${call};`;
  } else if (outputs.length === 1) {
    return `const ${outputs[0].name} = ${call};`;
  } else {
    const destructure = outputs.map(o => o.name).join(', ');
    return `const [${destructure}] = ${call};`;
  }
}

/**
 * 检查提取是否安全
 */
function checkSafety(
  selectedNodes: ts.Node[],
  usageMap: Map<string, VariableUsage>
): { isSafe: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let isSafe = true;
  
  // 检查是否包含 return 语句
  function hasReturn(node: ts.Node): boolean {
    if (ts.isReturnStatement(node)) return true;
    let found = false;
    ts.forEachChild(node, child => {
      if (hasReturn(child)) found = true;
    });
    return found;
  }
  
  for (const node of selectedNodes) {
    if (hasReturn(node)) {
      warnings.push('选中区域包含 return 语句，提取后可能改变控制流');
      isSafe = false;
    }
  }
  
  // 检查是否包含 break/continue（在循环外）
  function hasBreakOrContinue(node: ts.Node): boolean {
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      return true;
    }
    // 不进入嵌套循环检查
    if (ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      return false;
    }
    let found = false;
    ts.forEachChild(node, child => {
      if (hasBreakOrContinue(child)) found = true;
    });
    return found;
  }
  
  for (const node of selectedNodes) {
    if (hasBreakOrContinue(node)) {
      warnings.push('选中区域包含 break/continue 语句，提取后可能导致错误');
      isSafe = false;
    }
  }
  
  // 检查变量冲突
  for (const [name, usage] of usageMap) {
    if (usage.declaredInside && usage.readOutside && !usage.writtenInside) {
      warnings.push(`变量 '${name}' 在选中区域内声明但未赋值，外部引用会失败`);
      isSafe = false;
    }
  }
  
  return { isSafe, warnings };
}

/**
 * 执行 Extract Method 重构
 */
export async function extractMethod(
  filePath: string,
  workspaceRoot: string,
  options: ExtractMethodOptions
): Promise<ExtractMethodResult> {
  const absolutePath = resolve(workspaceRoot, filePath);
  const content = await readFile(absolutePath, 'utf-8');
  
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );
  
  // 创建类型检查器（可选，用于类型推断）
  let typeChecker: ts.TypeChecker | undefined;
  try {
    const program = ts.createProgram([filePath], {}, {
      getSourceFile: (name) => name === filePath ? sourceFile : undefined,
      getDefaultLibFileName: () => 'lib.d.ts',
      writeFile: () => {},
      getCurrentDirectory: () => workspaceRoot,
      getDirectories: () => [],
      fileExists: () => true,
      readFile: () => '',
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
    });
    typeChecker = program.getTypeChecker();
  } catch {
    // 类型检查器创建失败，继续但不使用类型信息
  }
  
  // 找到选中的节点范围
  const lines = content.split('\n');
  const startOffset = lines.slice(0, options.startLine - 1).join('\n').length + 
                      (options.startLine > 1 ? 1 : 0); // +1 for newline
  const endOffset = lines.slice(0, options.endLine).join('\n').length;
  
  const selectedNodes: ts.Node[] = [];
  let outerScope: ts.Node | undefined;
  
  function findNodesInRange(node: ts.Node) {
    const nodeStart = node.getStart(sourceFile);
    const nodeEnd = node.getEnd();
    
    // 节点完全在选中范围内
    if (nodeStart >= startOffset && nodeEnd <= endOffset) {
      selectedNodes.push(node);
    }
    
    // 找到包含选中范围的最小作用域
    if (nodeStart <= startOffset && nodeEnd >= endOffset) {
      if (ts.isFunctionDeclaration(node) || 
          ts.isMethodDeclaration(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node)) {
        outerScope = node;
      }
    }
    
    ts.forEachChild(node, findNodesInRange);
  }
  
  findNodesInRange(sourceFile);
  
  if (selectedNodes.length === 0) {
    throw new Error('未找到选中范围内的代码节点');
  }
  
  if (!outerScope) {
    outerScope = sourceFile; // 顶层作用域
  }
  
  // 分析变量使用
  const usageMap = analyzeVariableUsage(selectedNodes, outerScope, sourceFile, typeChecker);
  
  // 推断签名
  const { inputs, outputs, warnings: signatureWarnings } = inferSignature(usageMap, typeChecker);
  
  // 安全检查
  const { isSafe, warnings: safetyWarnings } = checkSafety(selectedNodes, usageMap);
  
  const warnings = [...signatureWarnings, ...safetyWarnings];
  
  // 提取选中代码
  const selectedCode = content.substring(startOffset, endOffset).trim();
  
  // 判断是否是类方法
  let isClassMethod = false;
  let current: ts.Node | undefined = outerScope;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      isClassMethod = true;
      break;
    }
    current = current.parent;
  }
  
  // 生成提取的方法
  const extractedMethod = generateExtractedMethod(
    options.methodName,
    selectedCode,
    inputs,
    outputs,
    options,
    isClassMethod
  );
  
  // 生成调用代码
  const callSite = generateCallSite(options.methodName, inputs, outputs, isClassMethod);
  
  // 内部变量
  const internal = Array.from(usageMap.values())
    .filter(usage => usage.declaredInside && !usage.readOutside)
    .map(usage => usage.name);
  
  return {
    extractedMethod,
    callSite,
    signature: {
      name: options.methodName,
      parameters: inputs,
      returnType: outputs.length === 1 ? outputs[0].type : 
                  outputs.length > 1 ? `[${outputs.map(o => o.type || 'any').join(', ')}]` :
                  undefined,
    },
    variableAnalysis: {
      inputs: inputs.map(i => i.name),
      outputs: outputs.map(o => o.name),
      internal,
    },
    isSafe,
    warnings,
  };
}

/**
 * 预览 Extract Method（不实际修改文件）
 */
export async function previewExtractMethod(
  filePath: string,
  workspaceRoot: string,
  options: ExtractMethodOptions
): Promise<{
  original: string;
  modified: string;
  result: ExtractMethodResult;
}> {
  const absolutePath = resolve(workspaceRoot, filePath);
  const original = await readFile(absolutePath, 'utf-8');
  
  const result = await extractMethod(filePath, workspaceRoot, options);
  
  // 生成修改后的代码
  const lines = original.split('\n');
  
  // 替换选中行为调用代码
  const beforeSelection = lines.slice(0, options.startLine - 1);
  const afterSelection = lines.slice(options.endLine);
  
  // 插入调用代码（保持缩进）
  const indentation = lines[options.startLine - 1].match(/^\s*/)?.[0] || '';
  const callLines = result.callSite.split('\n').map(line => indentation + line);
  
  // 插入提取的方法（在函数/类末尾）
  const methodLines = result.extractedMethod.split('\n').map(line => indentation + line);
  
  const modified = [
    ...beforeSelection,
    ...callLines,
    ...afterSelection,
    '',
    ...methodLines,
  ].join('\n');
  
  return {
    original,
    modified,
    result,
  };
}
