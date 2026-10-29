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
  /**
   * 声明嵌套在选中区域内部的另一个被选中语句里（如 if 块内）。
   * 这种变量提取后无法直接 return（作用域在函数内层），只能报不安全。
   */
  nestedDeclaration?: boolean;
  /** 声明时是否带初始化式（`const c = ...` 为 true，`let c;` 为 false）。 */
  declaredWithInitializer?: boolean;
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
  const topLevelSelections = new Set(selectedNodes);
  function isTopLevelSelected(node: ts.Node): boolean {
    let current: ts.Node | undefined = node;
    while (current) {
      if (topLevelSelections.has(current)) return current === node;
      current = current.parent;
    }
    return false;
  }

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
          nestedDeclaration: !isTopLevelSelected(node),
          declaredWithInitializer: node.initializer !== undefined,
        });
      } else {
        usageMap.get(name)!.declaredInside = true;
        if (node.initializer !== undefined) usageMap.get(name)!.declaredWithInitializer = true;
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
    
    // 输出：内部写入（含带初始化式的声明），外部读取
    //
    // 合并声明（如 `const c = a + 1;`）不产生赋值表达式，只靠 writtenInside
    // 会漏掉它 —— 实测 `const c = ...; return c;` 的 outputs 为空、callSite 变成
    // 什么都没接的 `g(a);`，外部 `c` 未定义。带初始化式的声明即视为写。
    if ((usage.writtenInside || usage.declaredWithInitializer) && usage.readOutside) {
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
    // 声明嵌在 if/for 块里，提取后不在同一个语句层，无法作为返回值带出。
    if (usage.nestedDeclaration && usage.readOutside) {
      warnings.push(`变量 '${name}' 的声明嵌套在选中区域内部，提取后无法作为返回值带出`);
      isSafe = false;
    }
  }

  // 选中范围的「顶层节点」如果本身是声明（整个函数/类/import/export），
  // 提取只是把声明搬进新函数，原位置换成一个调用 —— 实测选中整个
  // `export function f(...)` 会生成 `function addOne(f) { export function f ... }`，
  // 语义完全变了。这类选择直接拒绝。
  const selectedSet = new Set(selectedNodes);
  const isSelectedTopLevel = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (selectedSet.has(current)) return false;
      current = current.parent;
    }
    return true;
  };
  for (const node of selectedNodes) {
    if (!isSelectedTopLevel(node)) continue;
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) || ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node) || ts.isExportAssignment(node) ||
        ts.isModuleDeclaration(node)) {
      warnings.push('选中范围包含完整的声明（函数/类/导入/导出），不能作为语句提取');
      isSafe = false;
      break;
    }
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      warnings.push('选中范围包含导出的变量声明，提取后 export 语义会丢失');
      isSafe = false;
      break;
    }
  }

  return { isSafe, warnings };
}

/** 节点是否带 export 修饰符。 */
function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
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
 * 计算新方法的插入位置。
 *
 * 旧实现把提取出的方法一律追加到**文件末尾**：从类方法里提取时，新方法
 * 落在 class 的闭合大括号之外（实测 `forward(xs) {` 掉在顶层，预览直接是
 * 语法错误 "';' expected"）。这里按 AST 找最近的容器：
 *  - 选中代码在类方法里 → 插到类体末尾（class 闭合括号前，方法缩进）；
 *  - 在函数里 → 插到该函数结束后（同一层缩进）；
 *  - 顶层 → 文件末尾。
 */
function findMethodInsertion(
  content: string,
  filePath: string,
  startOffset: number,
  endOffset: number,
  lines: string[],
): { line: number; indent: string } {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

  let enclosingClass: ts.ClassDeclaration | ts.ClassExpression | undefined;
  let enclosingFunction: ts.FunctionLikeDeclaration | undefined;

  const isClassLike = (node: ts.Node): node is ts.ClassDeclaration | ts.ClassExpression =>
    ts.isClassDeclaration(node) || ts.isClassExpression(node);

  const visit = (node: ts.Node) => {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    if (start <= startOffset && end >= endOffset) {
      if (isClassLike(node)) {
        if (!enclosingClass) enclosingClass = node;
      }
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
          ts.isArrowFunction(node) || ts.isFunctionExpression(node) ||
          ts.isConstructorDeclaration(node)) {
        if (!enclosingFunction) enclosingFunction = node;
      }
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sourceFile, visit);

  const lineOf = (pos: number) => sourceFile.getLineAndCharacterOfPosition(pos).line;
  const indentOfLine = (index: number) => (lines[index]?.match(/^\s*/)?.[0] ?? '');

  const classNode = enclosingClass;
  const isMethodInClass = classNode !== undefined && enclosingFunction !== undefined &&
    classNode.members.includes(enclosingFunction as unknown as ts.ClassElement);

  if (classNode && isMethodInClass) {
    const classStartLine = lineOf(classNode.getStart(sourceFile));
    const memberIndent = classNode.members.length > 0
      ? indentOfLine(lineOf(classNode.members[0]!.getStart(sourceFile)))
      : `${indentOfLine(classStartLine)}  `;
    const closingLine = lineOf(classNode.getEnd() - 1);
    return { line: closingLine, indent: memberIndent };
  }

  if (enclosingFunction) {
    // getEnd() 指向函数最后一个字符之后，同一行的行号就是闭括号所在行；
    // 提取出的函数要放在闭括号「之后」，插到那一行之前等于把它嵌进原函数里
    // （实测 const c = ... 的提取结果变成 use() 内部的嵌套函数）。
    const indent = indentOfLine(lineOf(enclosingFunction.getStart(sourceFile)));
    return { line: lineOf(enclosingFunction.getEnd()) + 1, indent };
  }

  return { line: lines.length, indent: '' };
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
  const startIndex = options.startLine - 1;
  const endIndexExclusive = Math.min(options.endLine, lines.length);

  // 选中范围的字符偏移（与 extractMethod 同算法）。
  const startOffset = lines.slice(0, startIndex).join('\n').length + (startIndex > 0 ? 1 : 0);
  const endOffset = lines.slice(0, endIndexExclusive).join('\n').length;

  // 插入点要在替换前算好，行的增减之后再做偏移校正。
  const insertion = findMethodInsertion(original, filePath, startOffset, endOffset, lines);

  // 替换选中行为调用代码（保持缩进）
  const indentation = lines[startIndex]?.match(/^\s*/)?.[0] ?? '';
  const callLines = result.callSite.split('\n').map(line => indentation + line);

  // 插入提取的方法（使用容器缩进）
  const methodLines = result.extractedMethod.split('\n').map(line => insertion.indent + line);

  const replacedCount = endIndexExclusive - startIndex;
  const updated = [
    ...lines.slice(0, startIndex),
    ...callLines,
    ...lines.slice(endIndexExclusive),
  ];
  // 插入点在选中行之后时，前面的行数已经变了，需要按替换差值平移。
  const shift = callLines.length - replacedCount;
  const insertAt = Math.max(0, Math.min(updated.length, insertion.line + (insertion.line > startIndex ? shift : 0)));

  const modified = [
    ...updated.slice(0, insertAt),
    '',
    ...methodLines,
    ...updated.slice(insertAt),
  ].join('\n');

  return {
    original,
    modified,
    result,
  };
}
