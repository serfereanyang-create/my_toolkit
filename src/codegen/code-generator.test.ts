/**
 * code-generator.test.ts — 模板引擎 + 代码生成器测试
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TemplateEngine, renderTemplate, builtinHelpers } from './template-engine.js';
import { CodeGenerator, generateReactComponent, generateInterface, generateExpressRoute } from './code-generator.js';

describe('TemplateEngine', () => {
  it('替换简单变量', () => {
    const engine = new TemplateEngine();
    expect(engine.render('Hello {{ name }}!', { name: 'World' })).toBe('Hello World!');
  });

  it('支持管道辅助函数', () => {
    const engine = new TemplateEngine({ helpers: builtinHelpers });
    expect(engine.render('{{ name | kebabCase }}', { name: 'MyComponent' })).toBe('my-component');
    expect(engine.render('{{ name | upper }}', { name: 'abc' })).toBe('ABC');
    expect(engine.render('{{ name | pascalCase }}', { name: 'my-component' })).toBe('MyComponent');
  });

  it('渲染 if / else 分支', () => {
    const engine = new TemplateEngine();
    const template = '{% if hasState %}state{% else %}plain{% endif %}';

    expect(engine.render(template, { hasState: true })).toBe('state');
    expect(engine.render(template, { hasState: false })).toBe('plain');
  });

  it('渲染 for 循环并支持嵌套 if（回归：findBlockEnd 对称深度计数）', () => {
    const engine = new TemplateEngine();
    const template = [
      '{% for item in items %}',
      '{{ item.name }}{% if item.active %}!{% endif %};',
      '{% endfor %}',
    ].join('\n');

    const output = engine.render(template, {
      items: [
        { name: 'a', active: true },
        { name: 'b', active: false },
      ],
    });

    expect(output).toContain('a!;');
    expect(output).toContain('b;');
    expect(output).not.toContain('{%');
  });

  it('渲染包含 for 循环的 if 块（回归：if 含 for 不再误判未闭合）', () => {
    const engine = new TemplateEngine();
    const template = '{% if hasItems %}[{% for i in items %}{{ i }},{% endfor %}]{% endif %}';

    const output = engine.render(template, { hasItems: true, items: [1, 2, 3] });
    expect(output).toBe('[1,2,3,]');

    expect(engine.render(template, { hasItems: false, items: [1] })).toBe('');
  });

  it('支持 loop 元变量', () => {
    const engine = new TemplateEngine();
    const output = engine.render(
      '{% for x in xs %}{{ loop.index }}:{{ x }} {% endfor %}',
      { xs: ['p', 'q'] }
    );
    expect(output).toContain('0:p');
    expect(output).toContain('1:q');
  });

  it('支持比较与逻辑运算', () => {
    const engine = new TemplateEngine();
    expect(engine.render('{% if count > 2 %}many{% else %}few{% endif %}', { count: 5 })).toBe('many');
    expect(engine.render('{% if a && b %}both{% endif %}', { a: true, b: true })).toBe('both');
    expect(engine.render('{% if a || b %}either{% endif %}', { a: false, b: true })).toBe('either');
  });

  it('调用上下文函数与辅助函数', () => {
    const engine = new TemplateEngine({ helpers: builtinHelpers });
    expect(engine.render('{{ shout(name) }}', { name: 'hi', shout: (s: string) => s.toUpperCase() })).toBe('HI');
    expect(engine.render('{{ join(list, "-") }}', { list: [1, 2, 3] })).toBe('1-2-3');
  });

  it('未知变量渲染为空字符串而不是报错', () => {
    const engine = new TemplateEngine();
    expect(engine.render('x={{ missing }}', {})).toBe('x=');
  });

  it('renderTemplate 便捷函数透传选项', () => {
    const output = renderTemplate('{{ a }}-{{ b }}', { a: 1, b: 2 });
    expect(output).toBe('1-2');
  });
});

describe('CodeGenerator', () => {
  let outputDir: string;

  beforeAll(() => {
    outputDir = mkdtempSync(join(tmpdir(), 'codegen-'));
  });

  afterAll(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it('列出全部内置模板', () => {
    const generator = new CodeGenerator({ outputDir });
    const names = generator.getTemplateNames();

    expect(names).toContain('react-component');
    expect(names).toContain('typescript-interface');
    expect(names).toContain('express-route');
  });

  it('生成 TypeScript 接口文件', async () => {
    const generator = new CodeGenerator({ outputDir });
    const file = await generator.generate('typescript-interface', 'User.ts', {
      name: 'User',
      fields: [
        { name: 'id', type: 'string' },
        { name: 'age', type: 'number', optional: true },
      ],
    });

    expect(file.created).toBe(true);
    expect(existsSync(file.path)).toBe(true);
    const content = readFileSync(file.path, 'utf-8');
    expect(content).toContain('interface User');
    expect(content).toContain('id: string');
  });

  it('不覆盖已存在文件除非显式 overwrite', async () => {
    const generator = new CodeGenerator({ outputDir });
    const context = { name: 'Dup', fields: [{ name: 'x', type: 'string' }] };

    const first = await generator.generate('typescript-interface', 'Dup.ts', context);
    expect(first.created).toBe(true);

    const second = await generator.generate('typescript-interface', 'Dup.ts', context);
    expect(second.created).toBe(false);
    expect(second.skipped).toBe(true);

    const overwriting = new CodeGenerator({ outputDir, overwrite: true });
    const third = await overwriting.generate('typescript-interface', 'Dup.ts', context);
    expect(third.created).toBe(true);
  });

  it('批量生成多个文件', async () => {
    const generator = new CodeGenerator({ outputDir });
    const files = await generator.generateBatch([
      { template: 'typescript-interface', fileName: 'BatchA.ts', context: { name: 'BatchA', fields: [] } },
      { template: 'typescript-interface', fileName: 'BatchB.ts', context: { name: 'BatchB', fields: [] } },
    ]);

    expect(files).toHaveLength(2);
    expect(files.every((f) => f.created || f.skipped)).toBe(true);
  });

  it('注册并使用自定义模板', async () => {
    const generator = new CodeGenerator({ outputDir });
    generator.registerTemplate('greeting', 'const MSG = "{{ text | upper }}";\n');

    const file = await generator.generate('greeting', 'greeting.ts', { text: 'hello' });
    expect(file.content).toContain('const MSG = "HELLO";');
  });

  it('generateReactComponent 便捷函数产出组件文件', async () => {
    const file = await generateReactComponent('TestButton', outputDir, {
      withProps: true,
      props: [{ name: 'label', type: 'string' }],
    });

    expect(existsSync(file.path)).toBe(true);
    const content = readFileSync(file.path, 'utf-8');
    expect(content).toContain('TestButton');
  });

  it('generateInterface 便捷函数产出接口文件', async () => {
    const file = await generateInterface('Point', [
      { name: 'x', type: 'number' },
      { name: 'y', type: 'number' },
    ], outputDir);

    const content = readFileSync(file.path, 'utf-8');
    expect(content).toContain('interface Point');
    expect(content).toContain('x: number');
  });

  it('generateExpressRoute 便捷函数产出路由文件', async () => {
    const file = await generateExpressRoute('/api/widgets', outputDir, {
      hasValidation: true,
      validationFields: [{ name: 'title', required: true }],
    });

    const content = readFileSync(file.path, 'utf-8');
    expect(content).toContain('widgets');
  });
});
