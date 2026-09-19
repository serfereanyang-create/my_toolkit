/**
 * smells.ts — 代码异味检测器
 * 
 * 检测常见的代码异味（Code Smells）并提供重构建议
 * 基于 Martin Fowler 的《重构》和工业界最佳实践
 */

import * as ts from 'typescript';
import { resolve, relative } from 'node:path';
import { parseSourceFile } from './parseCache.js';

/**
 * 代码异味类型
 */
export type SmellType =
  | 'long_method'           // 长方法
  | 'long_parameter_list'   // 长参数列表
  | 'large_class'           // 大类
  | 'duplicate_code'        // 重复代码
  | 'god_class'             // 上帝类
  | 'data_clumps'           // 数据泥团
  | 'primitive_obsession'   // 基本类型偏执
  | 'switch_statements'     // 过度使用 switch
  | 'lazy_class'            // 冗余类
  | 'speculative_generality' // 过度泛化
  | 'dead_code'             // 死代码
  | 'magic_number'          // 魔法数字
  | 'feature_envy'          // 特性依恋（函数过度依赖其他类）
  | 'message_chains'        // 消息链（过长的调用链）
  | 'middle_man'            // 中间人（类仅做转发）
  | 'inappropriate_intimacy' // 过度亲密（类间耦合过高）
  | 'divergent_change'      // 发散式变化（一个类因多种原因修改）
  | 'shotgun_surgery'       // 霰弹式修改（一处修改需要改多处）
  | 'parallel_inheritance' // 平行继承体系
  | 'refused_bequest';      // 拒绝继承

/**
 * 异味严重级别
 */
export type SmellSeverity = 'info' | 'minor' | 'major' | 'critical';

/**
 * 代码异味报告
 */
export interface CodeSmell {
  type: SmellType;
  severity: SmellSeverity;
  message: string;
  file: string;
  line: number;
  column: number;
  /** 异味所在的符号名称（函数名、类名等） */
  symbol: string;
  /** 相关指标 */
  metrics?: Record<string, number>;
  /** 重构建议 */
  suggestions: string[];
  /** 示例代码（如何修复） */
  example?: string;
}

/**
 * 文件异味报告
 */
export interface FileSmellReport {
  path: string;
  smells: CodeSmell[];
  severityCounts: Record<SmellSeverity, number>;
}

/**
 * 项目异味报告
 */
export interface ProjectSmellReport {
  files: FileSmellReport[];
  totalSmells: number;
  byType: Record<SmellType, number>;
  bySeverity: Record<SmellSeverity, number>;
  topSmells: CodeSmell[];
}

/**
 * 异味检测配置
 */
export interface SmellThresholds {
  longMethod: { lines: number; statements: number };
  longParameterList: number;
  largeClass: { methods: number; lines: number };
  godClass: { methods: number; dependencies: number };
  lazyClass: { methods: number; lines: number };
  messageChainsDepth: number;
  magicNumber: { allowedValues: number[] };
}

/**
 * 默认阈值
 */
export const DEFAULT_SMELL_THRESHOLDS: SmellThresholds = {
  longMethod: { lines: 50, statements: 30 },
  longParameterList: 5,
  largeClass: { methods: 15, lines: 300 },
  godClass: { methods: 20, dependencies: 10 },
  lazyClass: { methods: 2, lines: 20 },
  messageChainsDepth: 3,
  magicNumber: { allowedValues: [0, 1, -1, 2] },
};

/**
 * 统计语句数量
 */
function countStatements(node: ts.Node): number {
  let count = 0;
  
  function visit(n: ts.Node) {
    if (ts.isExpressionStatement(n) || 
        ts.isVariableStatement(n) ||
        ts.isReturnStatement(n) ||
        ts.isIfStatement(n) ||
        ts.isForStatement(n) ||
        ts.isWhileStatement(n) ||
        ts.isDoStatement(n) ||
        ts.isSwitchStatement(n) ||
        ts.isTryStatement(n) ||
        ts.isThrowStatement(n) ||
        ts.isBreakStatement(n) ||
        ts.isContinueStatement(n)) {
      count++;
    }
    ts.forEachChild(n, visit);
  }
  
  visit(node);
  return count;
}

/**
 * 计算代码行数（含空行）
 */
function countLines(node: ts.Node, sourceFile: ts.SourceFile): number {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return end.line - start.line + 1;
}

/**
 * 获取符号名称
 */
function getSymbolName(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isClassDeclaration(node) && node.name) {
    return node.name.text;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return '<anonymous>';
}

/**
 * 检测长方法
 */
function detectLongMethod(
  node: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
  thresholds: SmellThresholds
): CodeSmell | null {
  if (!node.body) return null;
  
  const lines = countLines(node.body, sourceFile);
  const statements = countStatements(node.body);
  const name = getSymbolName(node);
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  
  if (lines > thresholds.longMethod.lines || statements > thresholds.longMethod.statements) {
    const severity: SmellSeverity = 
      lines > thresholds.longMethod.lines * 2 ? 'critical' :
      lines > thresholds.longMethod.lines * 1.5 ? 'major' : 'minor';
    
    return {
      type: 'long_method',
      severity,
      message: `方法 '${name}' 过长 (${lines} 行, ${statements} 条语句)`,
      file: sourceFile.fileName,
      line: pos.line + 1,
      column: pos.character + 1,
      symbol: name,
      metrics: { lines, statements },
      suggestions: [
        '使用 Extract Method 重构，将逻辑片段提取为独立方法',
        '考虑将方法拆分为多个职责单一的小方法',
        '检查是否有重复逻辑可以复用',
      ],
      example: `// 提取前\nfunction ${name}() {\n  // ... 50+ 行代码\n}\n\n// 提取后\nfunction ${name}() {\n  step1();\n  step2();\n  step3();\n}\n\nfunction step1() { ... }\nfunction step2() { ... }\nfunction step3() { ... }`,
    };
  }
  
  return null;
}

/**
 * 检测长参数列表
 */
function detectLongParameterList(
  node: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
  thresholds: SmellThresholds
): CodeSmell | null {
  const paramCount = node.parameters.length;
  const name = getSymbolName(node);
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  
  if (paramCount > thresholds.longParameterList) {
    return {
      type: 'long_parameter_list',
      severity: paramCount > 7 ? 'major' : 'minor',
      message: `方法 '${name}' 有 ${paramCount} 个参数，建议不超过 ${thresholds.longParameterList} 个`,
      file: sourceFile.fileName,
      line: pos.line + 1,
      column: pos.character + 1,
      symbol: name,
      metrics: { parameters: paramCount },
      suggestions: [
        '引入参数对象（Parameter Object）封装相关参数',
        '使用 options 对象模式传递配置参数',
        '考虑是否方法职责过多，需要拆分',
      ],
      example: `// 重构前\nfunction create(name, age, email, phone, address, city, zip) { ... }\n\n// 重构后\ninterface UserInfo {\n  name: string;\n  age: number;\n  contact: { email: string; phone: string };\n  address: { street: string; city: string; zip: string };\n}\n\nfunction create(user: UserInfo) { ... }`,
    };
  }
  
  return null;
}

/**
 * 检测大类
 */
function detectLargeClass(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  thresholds: SmellThresholds
): CodeSmell | null {
  const methods = node.members.filter(m => ts.isMethodDeclaration(m)).length;
  const lines = countLines(node, sourceFile);
  const name = node.name?.text || '<anonymous>';
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  
  if (methods > thresholds.largeClass.methods || lines > thresholds.largeClass.lines) {
    return {
      type: 'large_class',
      severity: methods > thresholds.largeClass.methods * 1.5 ? 'major' : 'minor',
      message: `类 '${name}' 过大 (${methods} 个方法, ${lines} 行代码)`,
      file: sourceFile.fileName,
      line: pos.line + 1,
      column: pos.character + 1,
      symbol: name,
      metrics: { methods, lines },
      suggestions: [
        '使用 Extract Class 将相关方法提取为新类',
        '识别类的多个职责，按职责拆分',
        '考虑使用组合模式代替继承',
      ],
    };
  }
  
  return null;
}

/**
 * 检测上帝类（God Class）
 * 上帝类：既大又依赖过多，控制系统核心逻辑
 */
function detectGodClass(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  thresholds: SmellThresholds
): CodeSmell | null {
  const methods = node.members.filter(m => ts.isMethodDeclaration(m)).length;
  
  // 统计依赖数量（字段类型 + 构造函数参数类型）
  const dependencies = new Set<string>();
  node.members.forEach(member => {
    if (ts.isPropertyDeclaration(member) && member.type && ts.isTypeReferenceNode(member.type)) {
      dependencies.add(member.type.typeName.getText());
    }
    if (ts.isConstructorDeclaration(member)) {
      member.parameters.forEach(param => {
        if (param.type && ts.isTypeReferenceNode(param.type)) {
          dependencies.add(param.type.typeName.getText());
        }
      });
    }
  });
  
  const depCount = dependencies.size;
  const name = node.name?.text || '<anonymous>';
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  
  if (methods > thresholds.godClass.methods && depCount > thresholds.godClass.dependencies) {
    return {
      type: 'god_class',
      severity: 'critical',
      message: `类 '${name}' 是上帝类 (${methods} 个方法, ${depCount} 个依赖)`,
      file: sourceFile.fileName,
      line: pos.line + 1,
      column: pos.character + 1,
      symbol: name,
      metrics: { methods, dependencies: depCount },
      suggestions: [
        '识别核心职责，将边缘功能拆分为独立类',
        '使用门面模式（Facade）封装复杂交互',
        '考虑引入领域模型，按业务边界拆分',
      ],
    };
  }
  
  return null;
}

/**
 * 检测懒类（Lazy Class）
 * 类太小，不足以独立存在
 */
function detectLazyClass(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  thresholds: SmellThresholds
): CodeSmell | null {
  const methods = node.members.filter(m => ts.isMethodDeclaration(m)).length;
  const lines = countLines(node, sourceFile);
  const name = node.name?.text || '<anonymous>';
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  
  if (methods <= thresholds.lazyClass.methods && lines < thresholds.lazyClass.lines) {
    return {
      type: 'lazy_class',
      severity: 'info',
      message: `类 '${name}' 过小 (${methods} 个方法, ${lines} 行)，考虑合并或删除`,
      file: sourceFile.fileName,
      line: pos.line + 1,
      column: pos.character + 1,
      symbol: name,
      metrics: { methods, lines },
      suggestions: [
        '如果类功能简单，考虑使用 Inline Class 合并到调用者',
        '检查是否为过度设计，可以用简单函数替代',
      ],
    };
  }
  
  return null;
}

/**
 * 检测魔法数字
 */
function detectMagicNumbers(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  thresholds: SmellThresholds
): CodeSmell[] {
  const smells: CodeSmell[] = [];
  
  function visit(n: ts.Node) {
    if (ts.isNumericLiteral(n)) {
      const value = parseFloat(n.text);
      const parent = n.parent;
      
      // 跳过数组索引、枚举值、类型注解等
      const isAllowedContext = 
        ts.isElementAccessExpression(parent) ||
        ts.isEnumMember(parent) ||
        ts.isTypeNode(parent) ||
        thresholds.magicNumber.allowedValues.includes(value);
      
      if (!isAllowedContext) {
        const pos = sourceFile.getLineAndCharacterOfPosition(n.getStart());
        smells.push({
          type: 'magic_number',
          severity: 'info',
          message: `使用魔法数字 ${n.text}，建议提取为命名常量`,
          file: sourceFile.fileName,
          line: pos.line + 1,
          column: pos.character + 1,
          symbol: n.text,
          suggestions: [
            '将数字提取为命名常量，增加代码可读性',
            '如果是配置值，考虑外部化配置',
          ],
          example: `// 重构前\nif (status === 3) { ... }\n\n// 重构后\nconst STATUS_ACTIVE = 3;\nif (status === STATUS_ACTIVE) { ... }`,
        });
      }
    }
    ts.forEachChild(n, visit);
  }
  
  visit(node);
  return smells;
}

/**
 * 检测消息链（Message Chains）
 * 过长的调用链 a.b().c().d().e()
 */
function detectMessageChains(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  thresholds: SmellThresholds
): CodeSmell[] {
  const smells: CodeSmell[] = [];
  
  function visit(n: ts.Node) {
    if (ts.isPropertyAccessExpression(n) || ts.isCallExpression(n)) {
      let depth = 0;
      let current: ts.Node = n;
      
      // 统计链式调用深度
      while (true) {
        if (ts.isPropertyAccessExpression(current)) {
          depth++;
          current = current.expression;
        } else if (ts.isCallExpression(current)) {
          depth++;
          current = current.expression;
        } else {
          break;
        }
      }
      
      if (depth > thresholds.messageChainsDepth) {
        const pos = sourceFile.getLineAndCharacterOfPosition(n.getStart());
        const text = n.getText(sourceFile);
        
        smells.push({
          type: 'message_chains',
          severity: depth > 5 ? 'major' : 'minor',
          message: `过长的调用链 (深度 ${depth})`,
          file: sourceFile.fileName,
          line: pos.line + 1,
          column: pos.character + 1,
          symbol: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
          metrics: { depth },
          suggestions: [
            '使用 Hide Delegate 封装中间对象',
            '考虑引入委托方法减少调用链',
            '重新设计对象关系，减少耦合',
          ],
          example: `// 重构前\nconst value = obj.getA().getB().getC().getValue();\n\n// 重构后\nclass Obj {\n  getValue() {\n    return this.a.b.c.value;\n  }\n}\nconst value = obj.getValue();`,
        });
      }
    }
    ts.forEachChild(n, visit);
  }
  
  visit(node);
  return smells;
}

/**
 * 检测过度使用 switch
 */
function detectSwitchStatements(
  node: ts.Node,
  sourceFile: ts.SourceFile
): CodeSmell[] {
  const smells: CodeSmell[] = [];
  
  function visit(n: ts.Node) {
    if (ts.isSwitchStatement(n)) {
      const caseCount = n.caseBlock.clauses.length;
      
      if (caseCount > 5) {
        const pos = sourceFile.getLineAndCharacterOfPosition(n.getStart());
        
        smells.push({
          type: 'switch_statements',
          severity: caseCount > 10 ? 'major' : 'minor',
          message: `switch 语句有 ${caseCount} 个分支，考虑使用多态替换`,
          file: sourceFile.fileName,
          line: pos.line + 1,
          column: pos.character + 1,
          symbol: `switch(${n.expression.getText(sourceFile).substring(0, 20)})`,
          metrics: { cases: caseCount },
          suggestions: [
            '使用多态（Strategy 模式）替换 switch',
            '如果是类型检查，考虑使用 TypeScript 的联合类型和类型守卫',
            '使用 Map 或对象字面量替换简单的值映射',
          ],
          example: `// 重构前\nswitch(type) {\n  case 'A': return handleA();\n  case 'B': return handleB();\n  // ... 10+ cases\n}\n\n// 重构后\nconst handlers = {\n  A: handleA,\n  B: handleB,\n  // ...\n};\nreturn handlers[type]?.();`,
        });
      }
    }
    ts.forEachChild(n, visit);
  }
  
  visit(node);
  return smells;
}

/**
 * 检测死代码（未使用的私有方法）
 */
function detectDeadCode(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile
): CodeSmell[] {
  const smells: CodeSmell[] = [];
  const privateMethods = new Map<string, ts.MethodDeclaration>();
  const calledMethods = new Set<string>();
  
  // 收集私有方法
  node.members.forEach(member => {
    if (ts.isMethodDeclaration(member) && 
        ts.isIdentifier(member.name) &&
        member.modifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword)) {
      privateMethods.set(member.name.text, member);
    }
  });
  
  // 查找调用
  function visitCalls(n: ts.Node) {
    if (ts.isCallExpression(n)) {
      if (ts.isPropertyAccessExpression(n.expression) &&
          n.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
          ts.isIdentifier(n.expression.name)) {
        calledMethods.add(n.expression.name.text);
      }
    }
    ts.forEachChild(n, visitCalls);
  }
  
  node.members.forEach(member => visitCalls(member));
  
  // 找出未被调用的私有方法
  privateMethods.forEach((method, name) => {
    if (!calledMethods.has(name)) {
      const pos = sourceFile.getLineAndCharacterOfPosition(method.getStart());
      smells.push({
        type: 'dead_code',
        severity: 'minor',
        message: `私有方法 '${name}' 未被调用，可能是死代码`,
        file: sourceFile.fileName,
        line: pos.line + 1,
        column: pos.character + 1,
        symbol: name,
        suggestions: [
          '如果确实不需要，删除该方法',
          '检查是否遗漏了调用点',
          '考虑是否应该改为 public 供外部使用',
        ],
      });
    }
  });
  
  return smells;
}

/**
 * 分析文件中的所有代码异味
 */
export function analyzeFileSmells(
  sourceFile: ts.SourceFile,
  thresholds: SmellThresholds = DEFAULT_SMELL_THRESHOLDS
): Omit<FileSmellReport, 'path'> {
  const smells: CodeSmell[] = [];
  
  function visit(node: ts.Node) {
    // 检测长方法和长参数列表
    if (ts.isFunctionDeclaration(node) || 
        ts.isMethodDeclaration(node) ||
        ts.isArrowFunction(node)) {
      const funcNode = node as ts.FunctionLikeDeclaration;
      
      const longMethod = detectLongMethod(funcNode, sourceFile, thresholds);
      if (longMethod) smells.push(longMethod);
      
      const longParams = detectLongParameterList(funcNode, sourceFile, thresholds);
      if (longParams) smells.push(longParams);
      
      // 检测魔法数字
      smells.push(...detectMagicNumbers(funcNode, sourceFile, thresholds));
      
      // 检测消息链
      smells.push(...detectMessageChains(funcNode, sourceFile, thresholds));
    }
    
    // 检测类相关异味
    if (ts.isClassDeclaration(node)) {
      const largeClass = detectLargeClass(node, sourceFile, thresholds);
      if (largeClass) smells.push(largeClass);
      
      const godClass = detectGodClass(node, sourceFile, thresholds);
      if (godClass) smells.push(godClass);
      
      const lazyClass = detectLazyClass(node, sourceFile, thresholds);
      if (lazyClass) smells.push(lazyClass);
      
      smells.push(...detectDeadCode(node, sourceFile));
    }
    
    // 检测 switch 语句
    smells.push(...detectSwitchStatements(node, sourceFile));
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  
  const severityCounts: Record<SmellSeverity, number> = {
    info: 0,
    minor: 0,
    major: 0,
    critical: 0,
  };
  
  smells.forEach(smell => {
    severityCounts[smell.severity]++;
  });
  
  return {
    smells,
    severityCounts,
  };
}

/**
 * 分析单个文件（从文件路径）
 */
export async function analyzeFile(
  filePath: string,
  workspaceRoot: string,
  thresholds: SmellThresholds = DEFAULT_SMELL_THRESHOLDS
): Promise<FileSmellReport> {
  const absolutePath = resolve(workspaceRoot, filePath);
  const sourceFile = await parseSourceFile(filePath, absolutePath);
  if (!sourceFile) {
    throw new Error(`Cannot read or parse file: ${filePath}`);
  }
  
  const analysis = analyzeFileSmells(sourceFile, thresholds);
  
  return {
    path: relative(workspaceRoot, absolutePath),
    ...analysis,
  };
}

/**
 * 分析整个项目
 */
export async function analyzeProject(
  files: string[],
  workspaceRoot: string,
  thresholds: SmellThresholds = DEFAULT_SMELL_THRESHOLDS
): Promise<ProjectSmellReport> {
  const fileReports: FileSmellReport[] = [];
  
  for (const file of files) {
    try {
      const report = await analyzeFile(file, workspaceRoot, thresholds);
      fileReports.push(report);
    } catch (err) {
      continue;
    }
  }
  
  const allSmells = fileReports.flatMap(f => f.smells);
  
  const byType: Record<string, number> = {};
  const bySeverity: Record<SmellSeverity, number> = {
    info: 0,
    minor: 0,
    major: 0,
    critical: 0,
  };
  
  allSmells.forEach(smell => {
    byType[smell.type] = (byType[smell.type] || 0) + 1;
    bySeverity[smell.severity]++;
  });
  
  // 找出最严重的前20个异味
  const topSmells = [...allSmells]
    .sort((a, b) => {
      const severityOrder = { critical: 4, major: 3, minor: 2, info: 1 };
      return severityOrder[b.severity] - severityOrder[a.severity];
    })
    .slice(0, 20);
  
  return {
    files: fileReports,
    totalSmells: allSmells.length,
    byType: byType as Record<SmellType, number>,
    bySeverity,
    topSmells,
  };
}
