/**
 * template-engine.ts — 代码模板引擎
 * 
 * 支持变量替换、条件渲染、循环、函数调用
 * 用于生成重复性代码结构
 */

import * as ts from 'typescript';

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
   *
   * 变量值用占位符暂存、最后一次性还原：旧实现把值直接拼进模板字符串后继续
   * 解析，值里出现 `{% ... %}` / `{{ ... }}` 就会被当成模板语法二次求值
   * （实测 `{{ name }}` 的值写成 `{{ secret }}` 会泄漏出上下文里的 secret）。
   * 循环体每次迭代仍用各自的上下文求值，只是求值结果不再参与解析。
   */
  render(template: string, context: TemplateContext): string {
    // 值缓冲区跨迭代共享，占位符序号全局唯一。空白清理发生在「还原值」之前：
    // 模板自身的空行归一化照做，但值（多行文件内容等）内部的空行不能被压掉。
    const { text, values } = this.renderSegment(template, context, []);

    let result = text;
    if (!this.options.preserveWhitespace) {
      result = this.trimWhitespace(result);
    }
    result = result.replace(/\u0000(\d+)\u0000/g, (_, index: string) => values[Number(index)] ?? '');

    return result;
  }

  /** 渲染一段模板，返回「含占位符的文本」与全局值缓冲区。 */
  private renderSegment(template: string, context: TemplateContext, values: string[]): { text: string; values: string[] } {
    // 1. 处理表达式（条件、循环）
    const text = this.processExpressions(template, context, values);

    // 2. 替换变量（结果为占位符，不参与后续解析）
    return { text: this.replaceVariables(text, context, values), values };
  }
  
  /**
   * 处理表达式 - 使用固定定界符 {% %}
   *
   * 游标推进式解析：遇到 if/for 开标签时找到其闭合标签，将整个块
   * （含 else 分支）替换为渲染结果后跳过整段，避免块体原文残留或
   * 嵌套块被二次求值。
   */
  private processExpressions(template: string, context: TemplateContext, values: string[]): string {
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
          replacement = this.renderIfBlock(expr, template, tagEnd, elsePos, endPos, context, values);
        } else {
          replacement = this.renderForBlock(expr, template.substring(tagEnd, endPos), context, values);
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
    context: TemplateContext,
    values: string[],
  ): string {
    const condition = expr.substring(3).trim();
    const conditionValue = this.evaluate(condition, context);

    if (conditionValue) {
      const ifBlock = template.substring(bodyStart, elsePos !== -1 ? elsePos : endPos);
      return this.renderSegment(ifBlock, context, values).text;
    }
    if (elsePos !== -1) {
      const elseBlock = template.substring(elsePos, endPos);
      return this.renderSegment(elseBlock, context, values).text;
    }
    return '';
  }

  /**
   * 渲染 for 块体：对集合每一项以循环上下文递归渲染
   */
  private renderForBlock(expr: string, body: string, context: TemplateContext, values: string[]): string {
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
        return this.renderLeaf(body, loopContext, values);
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
        return this.renderLeaf(body, loopContext, values);
      }).join('');
    }

    return '';
  }

  /**
   * 叶子片段：先解析其中的 if/for，再替换变量。
   * 值只进缓冲区、以占位符留在文本里，不再参与后续解析 —— 因此这里
   * 不再调用 renderSegment 的第二步于同一个 context 上重复扫描。
   */
  private renderLeaf(template: string, context: TemplateContext, values: string[]): string {
    return this.renderSegment(template, context, values).text;
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
  private replaceVariables(template: string, context: TemplateContext, values: string[]): string {
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
        // 值存进缓冲区，模板里只留占位符：值里的 {{ }} / {% %} 不再被解析。
        // NUL 是占位符定界符，值里出现会伪造占位符，直接剔除。
        const text = value === undefined || value === null ? '' : String(value).replace(/\u0000/g, '');
        const index = values.push(text) - 1;
        const placeholder = `\u0000${index}\u0000`;
        result = result.substring(0, start) + placeholder + result.substring(end + 2);
        pos = start + placeholder.length;
      } catch (e) {
        pos = end + 2;
      }
    }

    return result;
  }
  
  /**
   * 应用管道 helper：支持 `helper` 与 `helper(arg, ...)` 两种写法。
   * 带参数时参数按模板表达式求值；helper 的实参顺序是 (value, ...args)。
   */
  private applyHelper(helperExpr: string, value: any, context: TemplateContext): any {
    const match = helperExpr.match(/^([A-Za-z_$][\w$]*)\s*(?:\((.*)\))?$/);
    if (!match) return value;
    const name = match[1]!;
    const helper = this.options.helpers[name]
      || (builtinHelpers as Record<string, (...args: any[]) => any>)[name]
      || context[name];
    if (typeof helper !== 'function') return value;

    if (!match[2]?.trim()) return helper(value);
    // 参数按顶层逗号切分（忽略引号内逗号），逐个求值。
    const args: any[] = [];
    let current = '';
    let quote: string | null = null;
    for (const char of match[2]) {
      if (quote) {
        current += char;
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
        current += char;
      } else if (char === ',') {
        args.push(this.evaluate(current.trim(), context));
        current = '';
      } else {
        current += char;
      }
    }
    if (current.trim()) args.push(this.evaluate(current.trim(), context));
    return helper(value, ...args);
  }

  /** 按顶层 `|` 切分（跳过引号内的竖线）：模板管道的分隔符。 */
  private splitTopLevelPipes(expr: string): string[] {
    const parts: string[] = [];
    let current = '';
    let quote: string | null = null;
    for (const char of expr) {
      if (quote) {
        current += char;
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
        current += char;
      } else if (char === '|') {
        parts.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    parts.push(current);
    return parts;
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
    //
    // 旧实现只把 value 传给 helper，`{{ version | default('1.0.0') }}` 这种
    // 内置模板里到处使用的写法会把 helper 名当成 `default('1.0.0')`，查不到
    // helper 就原样返回 undefined —— 实测所有 default(...) 都渲染成空串，
    // package-json / tsconfig 的默认值全部丢失且不报错。
    if (expr.includes('|')) {
      // 顶层竖线才算管道：`join("|")` 里的竖线属于 helper 参数，
      // 旧实现按字符 split 会把它当成管道符，把参数切碎。
      const parts = this.splitTopLevelPipes(expr).map(p => p.trim());
      if (parts.length > 1) {
        const base = this.evaluate(parts[0], context);
        return parts.slice(1).reduce((value, helperExpr) => this.applyHelper(helperExpr, value, context), base);
      }
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
/** 反斜杠字符（避免在源码里写出难读的转义序列）。 */
const JS_BACKSLASH = String.fromCharCode(92);

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
  /**
   * 把值转成可安全放进 JSON 字符串字面量里的内容（不含两端引号）。
   * 模板拼接 JSON 时漏了它，一个 `"` 就能让 package.json 失效。
   */
  escapeJson: (value: any) => {
    if (value === undefined || value === null) return '';
    return JSON.stringify(String(value)).slice(1, -1);
  },
  /**
   * JS/TS 字符串字面量内部转义（值两侧的引号由模板自己加）。
   * 单引号、双引号、反引号、反斜杠、换行与 U+2028/29 都会打破字面量，
   * 必须全部转义 —— 只转双引号挡不住 router.get('...') 的单引号注入。
   */
  escapeJs: (value: any) => {
    if (value === undefined || value === null) return '';
    return JSON.stringify(String(value)).slice(1, -1)
      .replace(/`/g, JS_BACKSLASH + '`')
      .replace(/'/g, JS_BACKSLASH + "'")
      .replace(/[\u2028\u2029]/g, (char) => JS_BACKSLASH + 'u' + char.charCodeAt(0).toString(16));
  },
  /**
   * 标识符位置的值：合法标识符原样返回，否则把不合法字符换成下划线。
   * 名字插进 interface X / foo.bar 这类位置时不能用字符串转义，只能清洗
   * （`a: any;` + 换行 + `}` 的注入靠的就是这里）。
   */
  identifier: (value: any) => {
    const raw = value === undefined || value === null ? '' : String(value);
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(raw)) return raw;
    const cleaned = raw.replace(/[^A-Za-z0-9_$]/g, '_');
    return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
  },
  /**
   * 类型表达式位置的值：去掉能提前结束语句/类型块的字符（分号、换行），
   * 括号不成对时退化为 unknown，避免 `Foo; }` 之类的截断。
   */
  typeExpr: (value: any) => {
    const raw = value === undefined || value === null ? '' : String(value).replace(/[;\r\n]/g, ' ').trim();
    if (!raw) return 'unknown';
    // 只靠括号配平挡不住 `foo: {a}` 这类“配平但非法”的类型：交给 TS 解析器，
    // 能解析成单个类型别名且消费者覆盖到末尾才原样放行，否则退化为 unknown。
    const prefix = 'type __T = ';
    const sourceFile = ts.createSourceFile(
      'type-expr.ts',
      `${prefix}${raw};`,
      ts.ScriptTarget.Latest,
      true,
    );
    const diagnostics = (sourceFile as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
    if (Array.isArray(diagnostics) && diagnostics.length > 0) return 'unknown';
    const statement = sourceFile.statements[0];
    if (!statement || !ts.isTypeAliasDeclaration(statement)) return 'unknown';
    return statement.type.end === prefix.length + raw.length ? raw : 'unknown';
  },
  /** 注释内容：注释结束符会提前闭合块注释，换行会破坏单行注释，一律中和。 */
  escapeComment: (value: any) => {
    if (value === undefined || value === null) return '';
    return String(value).replace(/\*\//g, '*' + JS_BACKSLASH + '/').replace(/[\r\n]+/g, ' ');
  },
  join: (arr: any[], sep: string = ', ') => arr.join(sep),
  default: (value: any, defaultValue: any) => value ?? defaultValue,
};
