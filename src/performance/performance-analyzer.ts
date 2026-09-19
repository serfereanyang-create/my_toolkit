/**
 * performance-analyzer.ts — 性能分析工具
 * 
 * 静态分析代码性能问题：
 * - 算法复杂度分析
 * - 内存泄漏风险检测
 * - 昂贵操作识别（同步 I/O、大循环等）
 * - 不必要的重复计算
 * - Bundle size 影响分析
 */

import * as ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 性能问题严重级别
 */
export type PerformanceIssueSeverity = 'critical' | 'major' | 'minor' | 'info';

/**
 * 性能问题类别
 */
export type PerformanceIssueCategory =
  | 'algorithm'        // 算法复杂度
  | 'memory'           // 内存使用
  | 'io'               // I/O 操作
  | 'computation'      // 计算密集
  | 'rendering'        // 渲染性能（前端）
  | 'bundle-size';     // 打包大小

/**
 * 性能问题
 */
export interface PerformanceIssue {
  category: PerformanceIssueCategory;
  severity: PerformanceIssueSeverity;
  line: number;
  column: number;
  message: string;
  explanation: string;
  suggestion: string;
  estimatedImpact?: string; // 如 "O(n²) → O(n log n)"
  example?: string;
}

/**
 * 算法复杂度
 */
export interface AlgorithmComplexity {
  timeComplexity: string;  // 如 "O(n²)"
  spaceComplexity: string; // 如 "O(n)"
  reasoning: string;
}

/**
 * 性能分析结果
 */
export interface PerformanceAnalysisResult {
  issues: PerformanceIssue[];
  algorithmComplexities: Map<string, AlgorithmComplexity>;
  hotspots: Array<{
    type: 'loop' | 'recursion' | 'async-await' | 'sync-io';
    line: number;
    severity: PerformanceIssueSeverity;
    description: string;
  }>;
  memoryLeakRisks: Array<{
    line: number;
    type: 'event-listener' | 'timer' | 'closure' | 'global';
    description: string;
  }>;
  optimizationSuggestions: string[];
  estimatedScore: number; // 0-100，性能评分
}

/**
 * 检测嵌套循环（O(n²) 或更高）
 */
function detectNestedLoops(
  sourceFile: ts.SourceFile
): PerformanceIssue[] {
  const issues: PerformanceIssue[] = [];
  
  function analyzeLoop(node: ts.Node, depth: number = 0): number {
    let maxDepth = depth;
    
    if (ts.isForStatement(node) || 
        ts.isWhileStatement(node) || 
        ts.isDoStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isForInStatement(node)) {
      
      const currentDepth = depth + 1;
      
      // 检查循环体内是否有嵌套循环
      const body = 'statement' in node ? node.statement : (node as any).statement;
      if (body) {
        ts.forEachChild(body, child => {
          const childDepth = analyzeLoop(child, currentDepth);
          maxDepth = Math.max(maxDepth, childDepth);
        });
      }
      
      // 嵌套深度 >= 2 时报告
      if (currentDepth >= 2) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const severity: PerformanceIssueSeverity = 
          currentDepth === 2 ? 'major' :
          currentDepth === 3 ? 'critical' : 'critical';
        
        issues.push({
          category: 'algorithm',
          severity,
          line: pos.line + 1,
          column: pos.character + 1,
          message: `检测到 ${currentDepth} 层嵌套循环，时间复杂度 O(n^${currentDepth})`,
          explanation: `嵌套循环会导致执行时间随输入大小呈指数增长，严重影响性能`,
          suggestion: '考虑使用 Map/Set 优化查找，或重构算法降低嵌套层数',
          estimatedImpact: `O(n^${currentDepth}) → O(n) 或 O(n log n)`,
          example: `// 用 Map 替代嵌套循环\nconst map = new Map(array1.map(item => [item.id, item]));\nfor (const item of array2) {\n  const match = map.get(item.id); // O(1) 查找\n}`,
        });
      }
      
      return Math.max(maxDepth, currentDepth);
    }
    
    ts.forEachChild(node, child => {
      const childDepth = analyzeLoop(child, depth);
      maxDepth = Math.max(maxDepth, childDepth);
    });
    
    return maxDepth;
  }
  
  analyzeLoop(sourceFile);
  return issues;
}

/**
 * 检测同步 I/O 操作
 */
function detectSyncIO(sourceFile: ts.SourceFile): PerformanceIssue[] {
  const issues: PerformanceIssue[] = [];
  
  const syncAPIs = [
    'readFileSync',
    'writeFileSync',
    'readSync',
    'writeSync',
    'readdirSync',
    'statSync',
    'existsSync',
    'mkdirSync',
    'rmdirSync',
  ];
  
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const text = node.expression.getText(sourceFile);
      
      for (const api of syncAPIs) {
        if (text.includes(api)) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          
          issues.push({
            category: 'io',
            severity: 'critical',
            line: pos.line + 1,
            column: pos.character + 1,
            message: `使用同步 I/O 操作 ${api}，会阻塞事件循环`,
            explanation: '同步 I/O 操作会阻塞 Node.js 事件循环，导致服务器无法处理其他请求',
            suggestion: `使用异步版本 ${api.replace('Sync', '')}() 或 fs.promises.${api.replace('Sync', '')}()`,
            estimatedImpact: '阻塞时间取决于 I/O 耗时，可能达到数百毫秒',
            example: `// 不好\nconst data = fs.readFileSync('file.txt');\n\n// 好\nconst data = await fs.promises.readFile('file.txt');`,
          });
        }
      }
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  return issues;
}

/**
 * 检测数组操作性能问题
 */
function detectArrayPerformanceIssues(sourceFile: ts.SourceFile): PerformanceIssue[] {
  const issues: PerformanceIssue[] = [];
  
  function visit(node: ts.Node) {
    // 检测循环内的 array.push
    if (ts.isCallExpression(node)) {
      const text = node.expression.getText(sourceFile);
      
      // 检测是否在循环内
      let inLoop = false;
      let current: ts.Node | undefined = node.parent;
      while (current) {
        if (ts.isForStatement(current) || 
            ts.isWhileStatement(current) ||
            ts.isForOfStatement(current)) {
          inLoop = true;
          break;
        }
        current = current.parent;
      }
      
      // array.concat 在循环内
      if (inLoop && text.endsWith('.concat')) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        
        issues.push({
          category: 'computation',
          severity: 'major',
          line: pos.line + 1,
          column: pos.character + 1,
          message: '循环内使用 array.concat()，性能较差',
          explanation: 'concat() 创建新数组并复制所有元素，在循环内使用会产生大量临时对象',
          suggestion: '使用 array.push(...items) 或预分配数组',
          estimatedImpact: 'O(n²) → O(n)',
          example: `// 不好\nfor (const item of items) {\n  result = result.concat([item]);\n}\n\n// 好\nfor (const item of items) {\n  result.push(item);\n}`,
        });
      }
      
      // 检测 indexOf/includes 在循环内（应该用 Set）
      if (inLoop && (text.endsWith('.indexOf') || text.endsWith('.includes'))) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        
        issues.push({
          category: 'algorithm',
          severity: 'major',
          line: pos.line + 1,
          column: pos.character + 1,
          message: '循环内使用 indexOf/includes，时间复杂度 O(n²)',
          explanation: 'indexOf 和 includes 每次调用需要遍历数组，在循环内使用导致 O(n²) 复杂度',
          suggestion: '使用 Set 进行 O(1) 查找',
          estimatedImpact: 'O(n²) → O(n)',
          example: `// 不好\nfor (const item of array1) {\n  if (array2.includes(item)) { ... }\n}\n\n// 好\nconst set = new Set(array2);\nfor (const item of array1) {\n  if (set.has(item)) { ... }\n}`,
        });
      }
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  return issues;
}

/**
 * 检测内存泄漏风险
 */
function detectMemoryLeakRisks(
  sourceFile: ts.SourceFile
): PerformanceAnalysisResult['memoryLeakRisks'] {
  const risks: PerformanceAnalysisResult['memoryLeakRisks'] = [];
  
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const text = node.expression.getText(sourceFile);
      
      // setInterval 未清理
      if (text.includes('setInterval')) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        
        // 检查是否有 clearInterval
        let hasCleanup = false;
        let current: ts.Node | undefined = node.parent;
        while (current && !ts.isSourceFile(current)) {
          const functionText = current.getText(sourceFile);
          if (functionText.includes('clearInterval')) {
            hasCleanup = true;
            break;
          }
          current = current.parent;
        }
        
        if (!hasCleanup) {
          risks.push({
            line: pos.line + 1,
            type: 'timer',
            description: 'setInterval 未清理，可能导致内存泄漏和重复执行',
          });
        }
      }
      
      // addEventListener 未移除
      if (text.includes('addEventListener')) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        
        let hasCleanup = false;
        let current: ts.Node | undefined = node.parent;
        while (current && !ts.isSourceFile(current)) {
          const functionText = current.getText(sourceFile);
          if (functionText.includes('removeEventListener')) {
            hasCleanup = true;
            break;
          }
          current = current.parent;
        }
        
        if (!hasCleanup) {
          risks.push({
            line: pos.line + 1,
            type: 'event-listener',
            description: 'addEventListener 未移除，可能导致内存泄漏',
          });
        }
      }
    }
    
    // 检测全局变量累积
    if (ts.isVariableStatement(node)) {
      const modifiers = node.modifiers;
      if (!modifiers || !modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        // 检查是否是全局作用域
        if (node.parent && ts.isSourceFile(node.parent)) {
          for (const decl of node.declarationList.declarations) {
            if (decl.initializer && 
                (ts.isArrayLiteralExpression(decl.initializer) || 
                 ts.isObjectLiteralExpression(decl.initializer))) {
              const pos = sourceFile.getLineAndCharacterOfPosition(decl.getStart());
              
              risks.push({
                line: pos.line + 1,
                type: 'global',
                description: '全局变量持有数组或对象，可能持续增长导致内存泄漏',
              });
            }
          }
        }
      }
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  return risks;
}

/**
 * 检测重复计算
 */
function detectRedundantComputations(sourceFile: ts.SourceFile): PerformanceIssue[] {
  const issues: PerformanceIssue[] = [];
  
  function visit(node: ts.Node) {
    // 检测循环内的常量计算
    if (ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isForOfStatement(node)) {
      const body = 'statement' in node ? node.statement : (node as any).statement;
      if (!body) return;
      
      // 简化版：检测循环内调用无副作用的纯函数
      function checkBody(bodyNode: ts.Node) {
        if (ts.isCallExpression(bodyNode)) {
          const text = bodyNode.expression.getText(sourceFile);
          
          // 常见的纯函数
          const pureFunctions = ['Math.sqrt', 'Math.pow', 'Math.abs', 'String.prototype.toLowerCase'];
          
          for (const func of pureFunctions) {
            if (text.includes(func)) {
              const pos = sourceFile.getLineAndCharacterOfPosition(bodyNode.getStart());
              
              issues.push({
                category: 'computation',
                severity: 'minor',
                line: pos.line + 1,
                column: pos.character + 1,
                message: `循环内重复调用 ${func}，结果可能相同`,
                explanation: '如果计算结果不变，可以提取到循环外避免重复计算',
                suggestion: '将不变的计算移到循环外',
                estimatedImpact: '减少 n-1 次重复计算',
                example: `// 不好\nfor (let i = 0; i < arr.length; i++) {\n  const x = Math.sqrt(value); // 每次循环重复计算\n}\n\n// 好\nconst x = Math.sqrt(value);\nfor (let i = 0; i < arr.length; i++) {\n  // 使用 x\n}`,
              });
            }
          }
        }
        
        ts.forEachChild(bodyNode, checkBody);
      }
      
      checkBody(body);
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  return issues;
}

/**
 * 检测昂贵的正则表达式
 */
function detectExpensiveRegex(sourceFile: ts.SourceFile): PerformanceIssue[] {
  const issues: PerformanceIssue[] = [];
  
  function visit(node: ts.Node) {
    if (ts.isRegularExpressionLiteral(node)) {
      const pattern = node.text;
      
      // 检测灾难性回溯风险（简化版）
      if (pattern.includes('.*.*') || pattern.includes('.+.+') || pattern.includes('(.+)+')) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        
        issues.push({
          category: 'computation',
          severity: 'critical',
          line: pos.line + 1,
          column: pos.character + 1,
          message: '正则表达式存在灾难性回溯风险',
          explanation: '嵌套的量词（如 .*.* 或 (.+)+）可能导致指数级回溯，输入稍长即可卡死程序',
          suggestion: '重写正则表达式，避免嵌套量词，或使用具体字符类',
          estimatedImpact: '可能从指数时间降至线性时间',
          example: `// 危险\n/(.*)*/.test(input);\n\n// 安全\n/[a-zA-Z0-9]*/.test(input);`,
        });
      }
      
      // 检测全局正则在循环内创建
      let inLoop = false;
      let current: ts.Node | undefined = node.parent;
      while (current) {
        if (ts.isForStatement(current) || ts.isWhileStatement(current)) {
          inLoop = true;
          break;
        }
        current = current.parent;
      }
      
      if (inLoop && pattern.includes('g')) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        
        issues.push({
          category: 'computation',
          severity: 'minor',
          line: pos.line + 1,
          column: pos.character + 1,
          message: '循环内创建正则表达式对象',
          explanation: '正则表达式编译有开销，应该复用',
          suggestion: '将正则表达式移到循环外定义',
          estimatedImpact: '减少 n-1 次正则编译',
        });
      }
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  return issues;
}

/**
 * 分析算法复杂度
 */
function analyzeAlgorithmComplexity(
  func: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile
): AlgorithmComplexity {
  let loopDepth = 0;
  let hasRecursion = false;
  let hasSort = false;
  let hasMap = false;
  
  function analyze(node: ts.Node, depth: number = 0) {
    if (ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isForOfStatement(node)) {
      loopDepth = Math.max(loopDepth, depth + 1);
      ts.forEachChild(node, child => analyze(child, depth + 1));
    } else if (ts.isCallExpression(node)) {
      const text = node.expression.getText(sourceFile);
      
      if (func.name && text.includes(func.name.text)) {
        hasRecursion = true;
      }
      
      if (text.includes('.sort(')) {
        hasSort = true;
      }
      
      if (text.includes('.map(') || text.includes('.filter(') || text.includes('.reduce(')) {
        hasMap = true;
      }
    } else {
      ts.forEachChild(node, child => analyze(child, depth));
    }
  }
  
  if (func.body) {
    analyze(func.body);
  }
  
  // 推断时间复杂度
  let timeComplexity = 'O(1)';
  let reasoning = '常数时间操作';
  
  if (hasRecursion) {
    timeComplexity = 'O(2^n)'; // 简化假设
    reasoning = '递归调用，未优化可能为指数时间';
  } else if (loopDepth >= 3) {
    timeComplexity = `O(n^${loopDepth})`;
    reasoning = `${loopDepth} 层嵌套循环`;
  } else if (loopDepth === 2) {
    timeComplexity = 'O(n²)';
    reasoning = '双层嵌套循环';
  } else if (hasSort) {
    timeComplexity = 'O(n log n)';
    reasoning = '包含排序操作';
  } else if (loopDepth === 1) {
    timeComplexity = 'O(n)';
    reasoning = '单层循环或线性遍历';
  }
  
  // 推断空间复杂度
  const spaceComplexity = hasMap ? 'O(n)' : 'O(1)';
  
  return {
    timeComplexity,
    spaceComplexity,
    reasoning,
  };
}

/**
 * 分析文件性能
 */
export async function analyzePerformance(
  filePath: string,
  workspaceRoot: string
): Promise<PerformanceAnalysisResult> {
  const absolutePath = resolve(workspaceRoot, filePath);
  const content = await readFile(absolutePath, 'utf-8');
  
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );
  
  const issues: PerformanceIssue[] = [];
  
  // 各项检测
  issues.push(...detectNestedLoops(sourceFile));
  issues.push(...detectSyncIO(sourceFile));
  issues.push(...detectArrayPerformanceIssues(sourceFile));
  issues.push(...detectRedundantComputations(sourceFile));
  issues.push(...detectExpensiveRegex(sourceFile));
  
  // 内存泄漏风险
  const memoryLeakRisks = detectMemoryLeakRisks(sourceFile);
  
  // 分析函数复杂度
  const algorithmComplexities = new Map<string, AlgorithmComplexity>();
  
  function visitFunctions(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const complexity = analyzeAlgorithmComplexity(node, sourceFile);
      algorithmComplexities.set(node.name.text, complexity);
    }
    ts.forEachChild(node, visitFunctions);
  }
  
  visitFunctions(sourceFile);
  
  // 热点识别
  const hotspots: PerformanceAnalysisResult['hotspots'] = [];
  
  // 计算性能评分
  const criticalCount = issues.filter(i => i.severity === 'critical').length;
  const majorCount = issues.filter(i => i.severity === 'major').length;
  const minorCount = issues.filter(i => i.severity === 'minor').length;
  
  const estimatedScore = Math.max(0, 100 - criticalCount * 20 - majorCount * 10 - minorCount * 5);
  
  // 生成优化建议
  const optimizationSuggestions: string[] = [];
  
  if (criticalCount > 0) {
    optimizationSuggestions.push(`优先修复 ${criticalCount} 个严重性能问题`);
  }
  
  if (issues.some(i => i.category === 'algorithm')) {
    optimizationSuggestions.push('使用更高效的数据结构（Map、Set）降低算法复杂度');
  }
  
  if (issues.some(i => i.category === 'io')) {
    optimizationSuggestions.push('将同步 I/O 替换为异步版本');
  }
  
  if (memoryLeakRisks.length > 0) {
    optimizationSuggestions.push('清理定时器和事件监听器，避免内存泄漏');
  }
  
  return {
    issues,
    algorithmComplexities,
    hotspots,
    memoryLeakRisks,
    optimizationSuggestions,
    estimatedScore,
  };
}
