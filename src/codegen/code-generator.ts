/**
 * code-generator.ts — 代码生成器
 * 
 * 基于模板生成常见代码结构：
 * - React 组件
 * - API 路由
 * - 数据模型
 * - 测试文件
 * - 配置文件
 */

import { renderTemplate, builtinHelpers, TemplateContext } from './template-engine.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface GeneratorOptions {
  /** 输出目录 */
  outputDir: string;
  /** 是否覆盖已存在文件 */
  overwrite?: boolean;
  /** 模板变量 */
  context?: TemplateContext;
  /** 自定义模板 */
  customTemplates?: Record<string, string>;
}

export interface GeneratedFile {
  path: string;
  content: string;
  created: boolean;
  skipped?: boolean;
  reason?: string;
}

/**
 * 代码生成器
 */
export class CodeGenerator {
  private options: GeneratorOptions;
  private templates: Map<string, string> = new Map();
  
  constructor(options: GeneratorOptions) {
    this.options = options;
    this.loadBuiltinTemplates();
    
    if (options.customTemplates) {
      Object.entries(options.customTemplates).forEach(([name, template]) => {
        this.templates.set(name, template);
      });
    }
  }
  
  /**
   * 加载内置模板
   */
  private loadBuiltinTemplates(): void {
    // React 函数组件
    this.templates.set('react-component', `
import React{% if hasProps %}, { useState, useEffect }{% endif %} from 'react';
{% if hasStyles %}
import './{{ name | kebabCase }}.css';
{% endif %}

{% if hasProps %}
interface {{ name | identifier }}Props {
{% for prop in props %}
  /** {{ prop.description | default(prop.name) | escapeJs }} */
  {{ prop.name | escapeJs }}{% if prop.optional %}?{% endif %}: {{ prop.type | escapeJs }};
{% endfor %}
}
{% endif %}

export const {{ name | identifier }}: React.FC{% if hasProps %}<{{ name | identifier }}Props>{% endif %} = ({% if hasProps %}props{% endif %}) => {
{% if hasState %}
{% for state in states %}
  const [{{ state.name | identifier }}, set{{ state.name | pascalCase | identifier }}] = useState<{{ state.type | escapeJs }}>({{ state.initial }});
{% endfor %}
{% endif %}

{% if hasEffect %}
  useEffect(() => {
    // Component mounted
    
    return () => {
      // Cleanup
    };
  }, []);
{% endif %}

  return (
    <div className="{{ name | kebabCase }}">
      <h1>{{ title | default(name) }}</h1>
      {/* Component content */}
    </div>
  );
};
`.trim());

    // React 类组件
    this.templates.set('react-class-component', `
import React, { Component } from 'react';
{% if hasStyles %}
import './{{ name | kebabCase }}.css';
{% endif %}

{% if hasProps %}
interface {{ name | identifier }}Props {
{% for prop in props %}
  {{ prop.name | escapeJs }}{% if prop.optional %}?{% endif %}: {{ prop.type | escapeJs }};
{% endfor %}
}
{% endif %}

{% if hasState %}
interface {{ name | identifier }}State {
{% for state in states %}
  {{ state.name | escapeJs }}: {{ state.type | escapeJs }};
{% endfor %}
}
{% endif %}

export class {{ name | identifier }} extends Component<{% if hasProps %}{{ name }}Props{% else %}{}{% endif %}{% if hasState %}, {{ name }}State{% endif %}> {
{% if hasState %}
  state{% if hasState %}: {{ name | identifier }}State{% endif %} = {
{% for state in states %}
    {{ state.name | escapeJs }}: {{ state.initial }},
{% endfor %}
  };
{% endif %}

  componentDidMount() {
    // Component mounted
  }
  
  componentWillUnmount() {
    // Cleanup
  }
  
  render() {
    return (
      <div className="{{ name | kebabCase }}">
        <h1>{{ title | default(name) }}</h1>
        {/* Component content */}
      </div>
    );
  }
}
`.trim());

    // Express API 路由
    this.templates.set('express-route', `
import { Router, Request, Response } from 'express';
{% if hasValidation %}
import { body, validationResult } from 'express-validator';
{% endif %}
{% if hasAuth %}
import { authenticate } from '../middleware/auth';
{% endif %}

const router = Router();

/**
 * GET {{ path | escapeComment }}
 * {{ description | default('获取资源列表') | escapeComment }}
 */
router.get('{{ path | escapeJs }}', {% if hasAuth %}authenticate, {% endif %}async (req: Request, res: Response) => {
  try {
    // TODO: 实现业务逻辑
    const data = [];
    
    res.json({
      success: true,
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET {{ path | escapeComment }}/:id
 * {{ description | default('获取单个资源') | escapeComment }}
 */
router.get('{{ path | escapeJs }}/:id', {% if hasAuth %}authenticate, {% endif %}async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // TODO: 实现业务逻辑
    const data = null;
    
    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
      });
    }
    
    res.json({
      success: true,
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST {{ path | escapeComment }}
 * {{ description | default('创建新资源') | escapeComment }}
 */
router.post('{{ path | escapeJs }}',
  {% if hasAuth %}authenticate,{% endif %}
  {% if hasValidation %}
  [
{% for field in validationFields %}
    body('{{ field.name | escapeJs }}'){% if field.required %}.notEmpty(){% endif %}{% if field.type == 'email' %}.isEmail(){% endif %},
{% endfor %}
  ],
  {% endif %}
  async (req: Request, res: Response) => {
    try {
{% if hasValidation %}
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array(),
        });
      }
{% endif %}
      
      // TODO: 实现业务逻辑
      const data = req.body;
      
      res.status(201).json({
        success: true,
        data,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);

/**
 * PUT {{ path | escapeComment }}/:id
 * {{ description | default('更新资源') | escapeComment }}
 */
router.put('{{ path | escapeJs }}/:id', {% if hasAuth %}authenticate, {% endif %}async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // TODO: 实现业务逻辑
    const data = null;
    
    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
      });
    }
    
    res.json({
      success: true,
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * DELETE {{ path | escapeComment }}/:id
 * {{ description | default('删除资源') | escapeComment }}
 */
router.delete('{{ path | escapeJs }}/:id', {% if hasAuth %}authenticate, {% endif %}async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // TODO: 实现业务逻辑
    
    res.status(204).send();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
`.trim());

    // TypeScript 接口/类型
    this.templates.set('typescript-interface', `
/**
 * {{ description | default(name) | escapeComment }}
 */
export interface {{ name | identifier }} {
{% for field in fields %}
  /** {{ field.description | default(field.name) | escapeComment }} */
  {{ field.name | identifier }}{% if field.optional %}?{% endif %}: {{ field.type | typeExpr }};
{% endfor %}
}
`.trim());

    // TypeScript 类
    this.templates.set('typescript-class', `
/**
 * {{ description | default(name) | escapeComment }}
 */
export class {{ name | identifier }}{% if extends %} extends {{ extends | identifier }}{% endif %}{% if implements %} implements {% for iface in implements %}{{ iface | identifier }}{% if !loop.last %}, {% endif %}{% endfor %}{% endif %} {
{% for field in fields %}
  {% if field.access %}{{ field.access | identifier }} {% endif %}{{ field.name | identifier }}{% if field.optional %}?{% endif %}: {{ field.type | typeExpr }};
{% endfor %}

  constructor({% for param in constructorParams %}{{ param.name | identifier }}{% if param.optional %}?{% endif %}: {{ param.type | typeExpr }}{% if !loop.last %}, {% endif %}{% endfor %}) {
{% if extends %}
    super();
{% endif %}
{% for param in constructorParams %}
    this.{{ param.name | identifier }} = {{ param.name | identifier }};
{% endfor %}
  }
  
{% for method in methods %}
  /**
   * {{ method.description | default(method.name) | escapeComment }}
   */
  {% if method.access %}{{ method.access | identifier }} {% endif %}{% if method.async %}async {% endif %}{{ method.name | identifier }}({% for param in method.params %}{{ param.name | identifier }}{% if param.optional %}?{% endif %}: {{ param.type | typeExpr }}{% if !loop.last %}, {% endif %}{% endfor %}){% if method.returnType %}: {{ method.returnType | typeExpr }}{% endif %} {
    // TODO: 实现方法
{% if method.returnType && method.returnType != 'void' %}
    throw new Error('Not implemented');
{% endif %}
  }
  
{% endfor %}
}
`.trim());

    // Jest 测试文件
    this.templates.set('jest-test', `
import { {{ name | identifier }} } from './{{ fileName | escapeJs }}';

describe('{{ name | escapeJs }}', () => {
{% for test in tests %}
  {% if test.async %}async {% endif %}test('{{ test.description | escapeJs }}', {% if test.async %}async {% endif %}() => {
    // Arrange
    
    // Act
    
    // Assert
    expect(true).toBe(true);
  });
  
{% endfor %}
});
`.trim());

    // Vitest 测试文件
    this.templates.set('vitest-test', `
import { describe, test, expect{% if hasMocks %}, vi{% endif %} } from 'vitest';
import { {{ name | identifier }} } from './{{ fileName | escapeJs }}';

describe('{{ name | escapeJs }}', () => {
{% for test in tests %}
  test('{{ test.description | escapeJs }}', {% if test.async %}async {% endif %}() => {
    // Arrange
    
    // Act
    
    // Assert
    expect(true).toBe(true);
  });
  
{% endfor %}
});
`.trim());

    // 包配置文件
    //
    // JSON 里的每个插值都必须 escapeJson：name/description 里一个引号就能让
    // package.json 整个失效；dependencies 为空时也不能留下悬空逗号。
    this.templates.set('package-json', `
{
  "name": "{{ name | escapeJson }}",
  "version": "{{ version | default('1.0.0') | escapeJson }}",
  "description": "{{ description | default('') | escapeJson }}",
  "main": "{{ main | default('index.js') | escapeJson }}",
  "type": "{{ type | default('commonjs') | escapeJson }}",
  "scripts": {
{% for script in scripts %}
    "{{ script.name | escapeJson }}": "{{ script.command | escapeJson }}"{% if !loop.last %},{% endif %}
{% endfor %}
  },
  "keywords": [{% for keyword in keywords %}"{{ keyword | escapeJson }}"{% if !loop.last %}, {% endif %}{% endfor %}],
  "author": "{{ author | default('') | escapeJson }}",
  "license": "{{ license | default('MIT') | escapeJson }}"{% if dependencies || devDependencies %},{% endif %}
{% if dependencies %}  "dependencies": {
{% for dep in dependencies %}
    "{{ dep.name | escapeJson }}": "{{ dep.version | escapeJson }}"{% if !loop.last %},{% endif %}
{% endfor %}
  }{% if devDependencies %},{% endif %}
{% endif %}{% if devDependencies %}  "devDependencies": {
{% for dep in devDependencies %}
    "{{ dep.name | escapeJson }}": "{{ dep.version | escapeJson }}"{% if !loop.last %},{% endif %}
{% endfor %}
  }
{% endif %}
}
`.trim());

    // tsconfig.json
    //
    // `lib` / `include` / `exclude` 是字符串数组：旧模板 `[{{ x | join('", "') }}]`
    // 只在元素之间补引号、两端没有，产出 `[ES2020", "DOM]` 这种坏 JSON。改为
    // 循环逐项加引号，并对内容做 JSON 转义。
    this.templates.set('tsconfig-json', `
{
  "compilerOptions": {
    "target": "{{ target | default('ES2020') | escapeJson }}",
    "module": "{{ module | default('ESNext') | escapeJson }}",
    "lib": [{% for lib in libs %}"{{ lib | escapeJson }}"{% if !loop.last %}, {% endif %}{% endfor %}],
    "outDir": "{{ outDir | default('./dist') | escapeJson }}",
    "rootDir": "{{ rootDir | default('./src') | escapeJson }}",
    "strict": {{ strict | default('true') }},
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
{% if jsx %}    "jsx": "{{ jsx | escapeJson }}",
{% endif %}{% if moduleResolution %}    "moduleResolution": "{{ moduleResolution | escapeJson }}",
{% endif %}    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": [{% for item in include %}"{{ item | escapeJson }}"{% if !loop.last %}, {% endif %}{% endfor %}],
  "exclude": [{% for item in exclude %}"{{ item | escapeJson }}"{% if !loop.last %}, {% endif %}{% endfor %}]
}
`.trim());
  }
  
  /**
   * 生成文件
   */
  async generate(
    templateName: string,
    fileName: string,
    context: TemplateContext = {}
  ): Promise<GeneratedFile> {
    const template = this.templates.get(templateName);
    if (!template) {
      throw new Error(`Template not found: ${templateName}`);
    }
    
    const fullPath = join(this.options.outputDir, fileName);
    
    // 检查文件是否已存在
    if (!this.options.overwrite) {
      try {
        await import('node:fs/promises').then(fs => fs.access(fullPath));
        return {
          path: fullPath,
          content: '',
          created: false,
          skipped: true,
          reason: 'File already exists',
        };
      } catch {
        // 文件不存在，继续
      }
    }
    
    // 合并上下文
    const mergedContext = {
      ...this.options.context,
      ...context,
    };
    
    // 渲染模板
    const content = renderTemplate(template, mergedContext, {
      helpers: builtinHelpers,
    });
    
    // 确保目录存在
    await mkdir(dirname(fullPath), { recursive: true });
    
    // 写入文件
    await writeFile(fullPath, content, 'utf-8');
    
    return {
      path: fullPath,
      content,
      created: true,
    };
  }
  
  /**
   * 批量生成文件
   */
  async generateBatch(
    items: Array<{
      template: string;
      fileName: string;
      context?: TemplateContext;
    }>
  ): Promise<GeneratedFile[]> {
    const results: GeneratedFile[] = [];
    
    for (const item of items) {
      const result = await this.generate(item.template, item.fileName, item.context);
      results.push(result);
    }
    
    return results;
  }
  
  /**
   * 注册自定义模板
   */
  registerTemplate(name: string, template: string): void {
    this.templates.set(name, template);
  }
  
  /**
   * 获取所有可用模板名称
   */
  getTemplateNames(): string[] {
    return Array.from(this.templates.keys());
  }
}

/**
 * 便捷函数：生成 React 组件
 */
export async function generateReactComponent(
  name: string,
  outputDir: string,
  options: {
    functional?: boolean;
    withProps?: boolean;
    withState?: boolean;
    withStyles?: boolean;
    props?: Array<{ name: string; type: string; optional?: boolean }>;
    states?: Array<{ name: string; type: string; initial: any }>;
  } = {}
): Promise<GeneratedFile> {
  const generator = new CodeGenerator({ outputDir });
  
  return generator.generate(
    options.functional !== false ? 'react-component' : 'react-class-component',
    `${name}.tsx`,
    {
      name,
      hasProps: options.withProps || (options.props && options.props.length > 0),
      hasState: options.withState || (options.states && options.states.length > 0),
      hasStyles: options.withStyles,
      hasEffect: true,
      props: options.props || [],
      states: options.states || [],
    }
  );
}

/**
 * 便捷函数：生成 Express 路由
 */
export async function generateExpressRoute(
  path: string,
  outputDir: string,
  options: {
    hasAuth?: boolean;
    hasValidation?: boolean;
    validationFields?: Array<{ name: string; required?: boolean; type?: string }>;
    description?: string;
  } = {}
): Promise<GeneratedFile> {
  const generator = new CodeGenerator({ outputDir });
  
  return generator.generate(
    'express-route',
    `${path.replace(/^\//, '').replace(/\//g, '-')}.route.ts`,
    {
      path,
      hasAuth: options.hasAuth,
      hasValidation: options.hasValidation,
      validationFields: options.validationFields || [],
      description: options.description,
    }
  );
}

/**
 * 便捷函数：生成 TypeScript 接口
 */
export async function generateInterface(
  name: string,
  fields: Array<{ name: string; type: string; optional?: boolean; description?: string }>,
  outputDir: string,
  options: {
    description?: string;
  } = {}
): Promise<GeneratedFile> {
  const generator = new CodeGenerator({ outputDir });
  
  return generator.generate(
    'typescript-interface',
    `${name}.ts`,
    {
      name,
      fields,
      description: options.description,
    }
  );
}
