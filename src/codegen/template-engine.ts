/**
 * template-engine.ts — 代码模板引擎
 * 
 * 支持变量替换、条件渲染、循环、函数调用
 * 用于生成重复性代码结构
 */

export interface TemplateContext {
  [key: string]: any;
}

export interface TemplateOptions {
  /** 是否保留空白 */
  preserveWhitespace?: boolean;
  /** 自定义辅助函数 */
  helpers?: Record<string, (...args: any[]) => any>;
}

const DEFAULT_OPTIONS: Required<TemplateOptions> = {
  preserveWhitespace: false,
  helpers: {},
};

/**
 * 模板引擎
 */
export class TemplateEngine {
  private options: Required<TemplateOptions>;
  
  constructor(options: TemplateOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }
  
  /**
   * 渲染模板
   */
  render(template: string, context: TemplateContext): string {
    let result = template;
    
    // 1. 处理表达式（条件、循环）
    result = this.processExpressions(result, context);
    
    // 2. 替换变量
    result = this.replaceVariables(result, context);
    
    // 3. 处理空白
    if (!this.options.preserveWhitespace) {
      result = this.trimWhitespace(result);
    }
    
    return result;
  }
  
  /**
   * 处理表达式 - 使用固定定界符 {% %}
   *
   * 游标推进式解析：遇到 if/for 开标签时找到其闭合标签，将整个块
   * （含 else 分支）替换为渲染结果后跳过整段，避免块体原文残留或
   * 嵌套块被二次求值。
   */
  private processExpressions(template: string, context: TemplateContext): string {
    let result = '';
    let pos = 0;

    while (pos < template.length) {
      const start = template.indexOf('{%', pos);
      if (start === -1) break;

      const end = template.indexOf('%}', start + 2);
      if (end === -1) break;

      const expr = template.substring(start + 2, end).trim();

      if (expr.startsWith('if ') || expr.startsWith('for ')) {
        const blockType: 'if' | 'for' = expr.startsWith('if ') ? 'if' : 'for';
        const tagEnd = end + 2;
        const { elsePos, endPos } = this.findBlockEnd(template, tagEnd, blockType);
        if (endPos === -1) {
          throw new Error(`Unclosed ${blockType} statement: ${expr}`);
        }
        const closeTagEnd = template.indexOf('%}', endPos) + 2;

        let replacement: string;
        if (blockType === 'if') {
          replacement = this.renderIfBlock(expr, template, tagEnd, elsePos, endPos, context);
        } else {
          replacement = this.renderForBlock(expr, template.substring(tagEnd, endPos), context);
        }

        result += template.substring(pos, start) + replacement;
        pos = closeTagEnd;
      } else if (expr === 'endif' || expr === 'endfor' || expr === 'else') {
        // 游标逻辑下不应出现游离闭标签；出现则丢弃
        result += template.substring(pos, start);
        pos = end + 2;
      } else {
        result += template.substring(pos, end + 2);
        pos = end + 2;
      }
    }

    result += template.substring(pos);
    return result;
  }

  /**
   * 渲染 if 块：条件为真取 if 体，否则取 else 体（若有）
   */
  private renderIfBlock(
    expr: string,
    template: string,
    bodyStart: number,
    elsePos: number,
    endPos: number,
    context: TemplateContext
  ): string {
    const condition = expr.substring(3).trim();
    const conditionValue = this.evaluate(condition, context);

    if (conditionValue) {
      const ifBlock = template.substring(bodyStart, elsePos !== -1 ? elsePos : endPos);
      return this.render(ifBlock, context);
    }
    if (elsePos !== -1) {
      const elseBlock = template.substring(elsePos, endPos);
      return this.render(elseBlock, context);
    }
    return '';
  }

  /**
   * 渲染 for 块体：对集合每一项以循环上下文递归渲染
   */
  private renderForBlock(expr: string, body: string, context: TemplateContext): string {
    const match = expr.match(/^for\s+(\w+)(?:\s*,\s*(\w+))?\s+in\s+(.+)$/);
    if (!match) {
      throw new Error(`Invalid for syntax: ${expr}`);
    }

    const [, item, value, collectionExpr] = match;
    const collection = this.evaluate(collectionExpr, context);

    if (Array.isArray(collection)) {
      return collection.map((element, index) => {
        const loopContext: TemplateContext = {
          ...context,
          [item]: value ? index : element,
          ...(value ? { [value]: element } : {}),
          loop: {
            index,
            index0: index,
            index1: index + 1,
            first: index === 0,
            last: index === collection.length - 1,
            length: collection.length,
          },
        };
        return this.render(body, loopContext);
      }).join('');
    }

    if (typeof collection === 'object' && collection !== null) {
      const entries = Object.entries(collection);
      return entries.map(([key, val], index) => {
        const loopContext: TemplateContext = {
          ...context,
          [item]: key,
          ...(value ? { [value]: val } : {}),
          loop: {
            index,
            index0: index,
            index1: index + 1,
            first: index === 0,
            last: index === entries.length - 1,
            length: entries.length,
          },
        };
        return this.render(body, loopContext);
      }).join('');
    }

    return '';
  }

  /**
   * 找到块结束位置 - 使用固定定界符
   *
   * 深度计数是对称的：'if '/'for ' 开标签递增，'endif'/'endfor' 闭标签递减，
   * 否则一个包含 {% for %} 的 {% if %} 块会因 endfor 不减深度而被误判为未闭合。
   */
  private findBlockEnd(
    template: string,
    startPos: number,
    blockType: 'if' | 'for'
  ): { elsePos: number; endPos: number } {
    let depth = 1;
    let elsePos = -1;
    let pos = startPos;

    while (pos < template.length) {
      const tagStart = template.indexOf('{%', pos);
      if (tagStart === -1) break;

      const tagEnd = template.indexOf('%}', tagStart + 2);
      if (tagEnd === -1) break;

      const tag = template.substring(tagStart + 2, tagEnd).trim();

      if (tag.startsWith('if ') || tag.startsWith('for ')) {
        depth++;
      } else if (tag === 'endif' || tag === 'endfor') {
        depth--;
        if (depth === 0) {
          // 闭标签类型必须与块类型匹配，否则继续（嵌套块不平衡时防御）
          return { elsePos, endPos: tagStart };
        }
      } else if (tag === 'else' && depth === 1 && blockType === 'if' && elsePos === -1) {
        elsePos = tagEnd + 2;
      }

      pos = tagEnd + 2;
    }

    return { elsePos: -1, endPos: -1 };
  }
  
  /**
   * 替换变量 - 使用固定定界符 {{ }}
   */
  private replaceVariables(template: string, context: TemplateContext): string {
    let result = template;
    let pos = 0;
    
    while (pos < result.length) {
      const start = result.indexOf('{{', pos);
      if (start === -1) break;
      
      const end = result.indexOf('}}', start + 2);
      if (end === -1) break;
      
      const expr = result.substring(start + 2, end).trim();
      
      try {
        const value = this.evaluate(expr, context);
        const replacement = value === undefined || value === null ? '' : String(value);
        result = result.substring(0, start) + replacement + result.substring(end + 2);
        pos = start + replacement.length;
      } catch (e) {
        pos = end + 2;
      }
    }
    
    return result;
  }
  
  /**
   * 计算表达式的值
   */
  private evaluate(expr: string, context: TemplateContext): any {
    // 字符串字面量
    if ((expr.startsWith('"') && expr.endsWith('"')) || 
        (expr.startsWith("'") && expr.endsWith("'"))) {
      return expr.slice(1, -1);
    }
    
    // 数字
    if (/^-?\d+(\.\d+)?$/.test(expr)) {
      return parseFloat(expr);
    }
    
    // 布尔值和特殊值
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === 'null') return null;
    if (expr === 'undefined') return undefined;
    
    // 逻辑运算符
    if (expr.includes('&&')) {
      const parts = expr.split('&&');
      return parts.every(p => this.evaluate(p.trim(), context));
    }
    if (expr.includes('||')) {
      const parts = expr.split('||');
      return parts.some(p => this.evaluate(p.trim(), context));
    }

    // 管道：value | helper1 | helper2（模板中 {{ name | kebabCase }} 语法）
    if (expr.includes('|')) {
      const parts = expr.split('|').map(p => p.trim());
      const base = this.evaluate(parts[0], context);
      return parts.slice(1).reduce((value, helperName) => {
        const helper = this.options.helpers[helperName]
          || (builtinHelpers as Record<string, (...args: any[]) => any>)[helperName]
          || context[helperName];
        return typeof helper === 'function' ? helper(value) : value;
      }, base);
    }
    
    // 比较运算符
    const operators = ['==', '!=', '>=', '<=', '>', '<'];
    for (const op of operators) {
      if (expr.includes(op)) {
        const [left, right] = expr.split(op).map(e => e.trim());
        const leftVal = this.evaluate(left, context);
        const rightVal = this.evaluate(right, context);
        
        switch (op) {
          case '==': return leftVal == rightVal;
          case '!=': return leftVal != rightVal;
          case '>=': return leftVal >= rightVal;
          case '<=': return leftVal <= rightVal;
          case '>': return leftVal > rightVal;
          case '<': return leftVal < rightVal;
        }
      }
    }
    
    // 取反运算符
    if (expr.startsWith('!')) {
      return !this.evaluate(expr.substring(1).trim(), context);
    }
    
    // 函数调用
    if (expr.includes('(') && expr.includes(')')) {
      return this.evaluateFunction(expr, context);
    }
    
    // 属性访问
    if (expr.includes('.') || expr.includes('[')) {
      return this.evaluatePropertyAccess(expr, context);
    }
    
    // 直接从上下文获取
    return context[expr];
  }
  
  /**
   * 计算函数调用
   */
  private evaluateFunction(expr: string, context: TemplateContext): any {
    const match = expr.match(/^(\w+)\((.*)\)$/);
    if (!match) return undefined;
    
    const [, funcName, argsStr] = match;
    const func = this.options.helpers[funcName] || context[funcName];
    
    if (typeof func !== 'function') {
      return undefined;
    }
    
    const args = argsStr
      .split(',')
      .map(arg => this.evaluate(arg.trim(), context));
    
    return func(...args);
  }
  
  /**
   * 计算属性访问
   */
  private evaluatePropertyAccess(expr: string, context: TemplateContext): any {
    const parts = expr.split(/\.|\[|\]/).filter(Boolean);
    let value: any = context;
    
    for (const part of parts) {
      if (value === undefined || value === null) return undefined;
      
      if (/^\d+$/.test(part)) {
        value = value[parseInt(part, 10)];
      } else {
        const key = part.replace(/^["']|["']$/g, '');
        value = value[key];
      }
    }
    
    return value;
  }
  
  /**
   * 清理多余空白
   */
  private trimWhitespace(text: string): string {
    return text
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .replace(/^[ \t]+$/gm, '')
      .trim();
  }
}

/**
 * 便捷渲染函数
 */
export function renderTemplate(
  template: string,
  context: TemplateContext,
  options?: TemplateOptions
): string {
  const engine = new TemplateEngine(options);
  return engine.render(template, context);
}

/**
 * 内置辅助函数
 */
export const builtinHelpers = {
  capitalize: (str: string) => str.charAt(0).toUpperCase() + str.slice(1),
  upper: (str: string) => str.toUpperCase(),
  lower: (str: string) => str.toLowerCase(),
  camelCase: (str: string) => 
    str.replace(/[-_](\w)/g, (_, c) => c.toUpperCase()),
  pascalCase: (str: string) => {
    const camel = builtinHelpers.camelCase(str);
    return camel.charAt(0).toUpperCase() + camel.slice(1);
  },
  snakeCase: (str: string) =>
    str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, ''),
  kebabCase: (str: string) =>
    str.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^-/, ''),
  pluralize: (str: string) => {
    if (str.endsWith('y')) return str.slice(0, -1) + 'ies';
    if (str.endsWith('s')) return str + 'es';
    return str + 's';
  },
  singularize: (str: string) => {
    if (str.endsWith('ies')) return str.slice(0, -3) + 'y';
    if (str.endsWith('ses')) return str.slice(0, -2);
    if (str.endsWith('s')) return str.slice(0, -1);
    return str;
  },
  date: (date: Date | string, format: string = 'YYYY-MM-DD') => {
    const d = typeof date === 'string' ? new Date(date) : date;
    return format
      .replace('YYYY', String(d.getFullYear()))
      .replace('MM', String(d.getMonth() + 1).padStart(2, '0'))
      .replace('DD', String(d.getDate()).padStart(2, '0'))
      .replace('HH', String(d.getHours()).padStart(2, '0'))
      .replace('mm', String(d.getMinutes()).padStart(2, '0'))
      .replace('ss', String(d.getSeconds()).padStart(2, '0'));
  },
  json: (obj: any, indent: number = 2) => JSON.stringify(obj, null, indent),
  join: (arr: any[], sep: string = ', ') => arr.join(sep),
  default: (value: any, defaultValue: any) => value ?? defaultValue,
};
