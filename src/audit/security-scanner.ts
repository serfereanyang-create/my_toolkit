/**
 * security-scanner.ts — 安全漏洞扫描器
 * 
 * 扫描常见安全问题：
 * - SQL 注入
 * - XSS 跨站脚本
 * - 路径遍历
 * - 不安全的加密
 * - 敏感信息泄露
 * - 依赖安全问题
 */

import * as ts from 'typescript';
import { readFile } from 'node:fs/promises';

export interface SecurityIssue {
  category: 'injection' | 'xss' | 'crypto' | 'secrets' | 'path-traversal' | 'dependency';
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  line: number;
  column: number;
  message: string;
  description: string;
  recommendation: string;
  cwe?: string; // Common Weakness Enumeration ID
  example?: string;
}

export interface SecurityScanResult {
  file: string;
  issues: SecurityIssue[];
  riskScore: number; // 0-100
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
}

/**
 * 扫描安全问题
 */
export async function scanSecurity(filePath: string): Promise<SecurityScanResult> {
  const content = await readFile(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );
  
  const issues: SecurityIssue[] = [
    ...detectInjectionVulnerabilities(sourceFile),
    ...detectXSSVulnerabilities(sourceFile),
    ...detectInsecureCrypto(sourceFile),
    ...detectSecretLeaks(sourceFile),
    ...detectPathTraversal(sourceFile),
  ];
  
  const summary = {
    critical: issues.filter(i => i.severity === 'critical').length,
    high: issues.filter(i => i.severity === 'high').length,
    medium: issues.filter(i => i.severity === 'medium').length,
    low: issues.filter(i => i.severity === 'low').length,
    info: issues.filter(i => i.severity === 'info').length,
  };
  
  const riskScore = calculateRiskScore(summary);
  
  return {
    file: filePath,
    issues,
    riskScore,
    summary,
  };
}

/**
 * 检测注入漏洞（SQL、NoSQL、Command）
 */
function detectInjectionVulnerabilities(sourceFile: ts.SourceFile): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  
  function visit(node: ts.Node) {
    // SQL 查询拼接
    if (ts.isTemplateExpression(node) || ts.isBinaryExpression(node)) {
      const text = node.getText(sourceFile);
      const sqlKeywords = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN)\b/i;
      
      if (sqlKeywords.test(text) && hasUserInput(node, sourceFile)) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        issues.push({
          category: 'injection',
          severity: 'critical',
          line: pos.line + 1,
          column: pos.character + 1,
          message: '可能存在 SQL 注入漏洞',
          description: '直接拼接用户输入到 SQL 查询中可能导致 SQL 注入攻击',
          recommendation: '使用参数化查询（prepared statements）或 ORM',
          cwe: 'CWE-89',
          example: `// 不安全\nconst query = \`SELECT * FROM users WHERE id = \${userId}\`;\n\n// 安全\nconst query = db.prepare('SELECT * FROM users WHERE id = ?').bind(userId);`,
        });
      }
    }
    
    // 命令注入
    if (ts.isCallExpression(node)) {
      const text = node.expression.getText(sourceFile);
      const dangerousFunctions = ['exec', 'execSync', 'spawn', 'spawnSync', 'eval'];
      
      if (dangerousFunctions.some(fn => text.includes(fn))) {
        const args = node.arguments;
        if (args.length > 0 && hasUserInput(args[0], sourceFile)) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          issues.push({
            category: 'injection',
            severity: 'critical',
            line: pos.line + 1,
            column: pos.character + 1,
            message: '可能存在命令注入漏洞',
            description: `使用 ${text} 执行包含用户输入的命令可能导致任意代码执行`,
            recommendation: '验证和清理用户输入，使用参数数组而非字符串拼接',
            cwe: 'CWE-78',
            example: `// 不安全\nexec(\`rm -rf \${userPath}\`);\n\n// 较安全\nexecFile('rm', ['-rf', userPath]);`,
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
 * 检测 XSS 漏洞
 */
function detectXSSVulnerabilities(sourceFile: ts.SourceFile): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  
  function visit(node: ts.Node) {
    // innerHTML / dangerouslySetInnerHTML
    if (ts.isPropertyAccessExpression(node)) {
      const propName = node.name.getText(sourceFile);
      if (propName === 'innerHTML') {
        const parent = node.parent;
        if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          issues.push({
            category: 'xss',
            severity: 'high',
            line: pos.line + 1,
            column: pos.character + 1,
            message: '使用 innerHTML 可能导致 XSS 攻击',
            description: '直接设置 innerHTML 可能执行恶意脚本',
            recommendation: '使用 textContent 或进行 HTML 转义',
            cwe: 'CWE-79',
            example: `// 不安全\nelement.innerHTML = userInput;\n\n// 安全\nelement.textContent = userInput;\n// 或使用 DOMPurify.sanitize(userInput)`,
          });
        }
      }
    }
    
    // React dangerouslySetInnerHTML
    if (ts.isJsxAttribute(node)) {
      const attrName = node.name.getText(sourceFile);
      if (attrName === 'dangerouslySetInnerHTML') {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        issues.push({
          category: 'xss',
          severity: 'high',
          line: pos.line + 1,
          column: pos.character + 1,
          message: 'dangerouslySetInnerHTML 可能导致 XSS',
          description: '直接渲染 HTML 可能执行恶意脚本',
          recommendation: '使用 DOMPurify 清理 HTML，或避免使用此属性',
          cwe: 'CWE-79',
        });
      }
    }
    
    // document.write
    if (ts.isCallExpression(node)) {
      const text = node.expression.getText(sourceFile);
      if (text.includes('document.write')) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        issues.push({
          category: 'xss',
          severity: 'medium',
          line: pos.line + 1,
          column: pos.character + 1,
          message: 'document.write 可能导致 XSS',
          description: 'document.write 可能执行恶意脚本且影响页面加载',
          recommendation: '使用现代 DOM 操作方法',
          cwe: 'CWE-79',
        });
      }
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  return issues;
}

/**
 * 检测不安全的加密
 */
function detectInsecureCrypto(sourceFile: ts.SourceFile): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  
  const weakAlgorithms = {
    'md5': { severity: 'high' as const, message: 'MD5 已被破解，不应用于安全场景' },
    'sha1': { severity: 'medium' as const, message: 'SHA-1 存在碰撞攻击，建议使用 SHA-256+' },
    'des': { severity: 'critical' as const, message: 'DES 加密强度不足，应使用 AES' },
    'rc4': { severity: 'critical' as const, message: 'RC4 存在严重漏洞，应使用 AES' },
  };
  
  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node)) {
      const text = node.text.toLowerCase();
      
      for (const [algo, info] of Object.entries(weakAlgorithms)) {
        if (text.includes(algo)) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          issues.push({
            category: 'crypto',
            severity: info.severity,
            line: pos.line + 1,
            column: pos.character + 1,
            message: `使用弱加密算法: ${algo.toUpperCase()}`,
            description: info.message,
            recommendation: '使用现代加密算法（AES-256-GCM, SHA-256, bcrypt）',
            cwe: 'CWE-327',
            example: `// 不安全\ncrypto.createHash('md5');\n\n// 安全\ncrypto.createHash('sha256');`,
          });
        }
      }
    }
    
    // 硬编码密钥
    if (ts.isVariableDeclaration(node)) {
      const name = node.name.getText(sourceFile).toLowerCase();
      if ((name.includes('key') || name.includes('secret') || name.includes('password')) &&
          node.initializer && ts.isStringLiteral(node.initializer)) {
        const value = node.initializer.text;
        if (value.length > 0 && !value.startsWith('process.env')) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          issues.push({
            category: 'crypto',
            severity: 'high',
            line: pos.line + 1,
            column: pos.character + 1,
            message: '硬编码的加密密钥',
            description: '密钥不应硬编码在源代码中',
            recommendation: '从环境变量或密钥管理服务读取',
            cwe: 'CWE-321',
            example: `// 不安全\nconst apiKey = 'sk-1234567890';\n\n// 安全\nconst apiKey = process.env.API_KEY;`,
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
 * 检测敏感信息泄露
 */
function detectSecretLeaks(sourceFile: ts.SourceFile): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  
  const secretPatterns = [
    { regex: /sk-[a-zA-Z0-9]{32,}/, name: 'OpenAI API Key', severity: 'critical' as const },
    { regex: /AKIA[0-9A-Z]{16}/, name: 'AWS Access Key', severity: 'critical' as const },
    { regex: /ghp_[a-zA-Z0-9]{36}/, name: 'GitHub Personal Token', severity: 'critical' as const },
    { regex: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}/, name: 'Slack Token', severity: 'critical' as const },
    { regex: /-----BEGIN (RSA|DSA|EC|OPENSSH) PRIVATE KEY-----/, name: 'Private Key', severity: 'critical' as const },
    { regex: /password\s*[:=]\s*['"][^'"]{8,}['"]/, name: 'Hard-coded Password', severity: 'high' as const },
  ];
  
  const content = sourceFile.getFullText();
  
  secretPatterns.forEach(pattern => {
    const matches = content.matchAll(new RegExp(pattern.regex, 'g'));
    for (const match of matches) {
      const pos = sourceFile.getLineAndCharacterOfPosition(match.index || 0);
      issues.push({
        category: 'secrets',
        severity: pattern.severity,
        line: pos.line + 1,
        column: pos.character + 1,
        message: `检测到 ${pattern.name}`,
        description: '源代码中不应包含敏感凭证',
        recommendation: '从环境变量、密钥管理服务或加密配置文件读取',
        cwe: 'CWE-798',
        example: `// 不安全\nconst apiKey = 'sk-proj-abc123...';\n\n// 安全\nconst apiKey = process.env.OPENAI_API_KEY;`,
      });
    }
  });
  
  return issues;
}

/**
 * 检测路径遍历漏洞
 */
function detectPathTraversal(sourceFile: ts.SourceFile): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const text = node.expression.getText(sourceFile);
      const fileOps = ['readFile', 'writeFile', 'unlink', 'open', 'readdir'];
      
      if (fileOps.some(op => text.includes(op))) {
        const args = node.arguments;
        if (args.length > 0 && hasUserInput(args[0], sourceFile)) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          issues.push({
            category: 'path-traversal',
            severity: 'high',
            line: pos.line + 1,
            column: pos.character + 1,
            message: '可能存在路径遍历漏洞',
            description: '直接使用用户输入构造文件路径可能访问任意文件',
            recommendation: '验证路径在允许的目录内，使用 path.resolve 规范化路径',
            cwe: 'CWE-22',
            example: `// 不安全\nfs.readFile(userPath);\n\n// 安全\nconst safePath = path.resolve(UPLOAD_DIR, path.basename(userPath));\nif (safePath.startsWith(UPLOAD_DIR)) {\n  fs.readFile(safePath);\n}`,
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
 * 检测节点是否可能包含用户输入
 */
function hasUserInput(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const text = node.getText(sourceFile).toLowerCase();
  
  const userInputIndicators = [
    'req.body', 'req.query', 'req.params', 'req.headers',
    'input', 'userdata', 'userinput', 'params',
    'searchparams', 'formdata', 'props.',
  ];
  
  return userInputIndicators.some(indicator => text.includes(indicator));
}

/**
 * 计算风险评分
 */
function calculateRiskScore(summary: SecurityScanResult['summary']): number {
  const weights = {
    critical: 20,
    high: 10,
    medium: 5,
    low: 2,
    info: 1,
  };
  
  const totalRisk = 
    summary.critical * weights.critical +
    summary.high * weights.high +
    summary.medium * weights.medium +
    summary.low * weights.low +
    summary.info * weights.info;
  
  // 归一化到 0-100，100 表示风险最高
  return Math.min(100, totalRisk);
}
