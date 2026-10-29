/**
 * codegen-injection.test.ts — 代码生成产物：模板求值与注入
 *
 * 旧模板引擎实测问题：
 *  - `{{ x | default('1.0.0') }}` 把 `default('1.0.0')` 当 helper 名，所有默认值渲染成空串；
 *  - 变量值被拼回模板后继续解析：值里写 `{{ secret }}` 会把上下文里的 secret 泄漏出来；
 *  - 模板不对插值做任何转义：字段名写 `a: any;\n}\nexport function evil(){...}` 即可生成任意代码；
 *    package.json 里一个引号就让整份 JSON 失效。
 * 这里对每个内置模板都做“产物必须能被解析”的验收，并对恶意输入断言中和效果。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ts from 'typescript';
import { renderTemplate, builtinHelpers } from '../src/codegen/template-engine.js';
import {
  CodeGenerator,
  generateExpressRoute,
  generateInterface,
} from '../src/codegen/code-generator.js';

function syntaxErrors(code: string, fileName = 'gen.ts'): string[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'codegen-inject-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('pipe helper arguments are evaluated (default(...) no longer renders empty)', () => {
  const engine = new TemplateEngineWithHelpers();
  assert.equal(engine.render('{{ version | default("1.0.0") }}', {}), '1.0.0');
  assert.equal(engine.render('{{ title | default(name) }}', { name: 'N' }), 'N');
  assert.equal(engine.render('{{ title | default(name) }}', { name: 'N', title: 'T' }), 'T');
  assert.equal(
    engine.render('{{ list | join("|") }}', { list: ['a', 'b'] }),
    'a|b',
  );
});

/** 直接走 renderTemplate（默认就带 builtinHelpers），避免测试依赖内部类。 */
class TemplateEngineWithHelpers {
  render(template: string, context: Record<string, unknown>): string {
    return renderTemplate(template, context, { helpers: builtinHelpers });
  }
}

test('values are not re-parsed as template syntax', () => {
  const output = renderTemplate('[{{ name }}]', { name: '{{ secret }}', secret: 'LEAKED' });
  assert.equal(output, '[{{ secret }}]');
  assert.ok(!output.includes('LEAKED'), output);

  const withBlock = renderTemplate('[{{ name }}]', { name: '{% if on %}X{% endif %}', on: true });
  assert.equal(withBlock, '[{% if on %}X{% endif %}]');
});

test('multiline values keep their own blank lines while template whitespace is normalized', () => {
  // 模板自身的多余空行会被归一化，但值（如文件内容）内部的空行必须原样保留。
  const body = 'a\n\n\n\nb';
  assert.equal(renderTemplate('<{{ body }}>', { body }), '<' + body + '>');
  assert.equal(renderTemplate('A\n\n\n\nB {{ x }}', { x: 'v' }), 'A\n\nB v');
});

test('interface field injection is neutralized', async () => {
  await withTempDir(async (dir) => {
    const file = await generateInterface(
      'I',
      [
        {
          name: 'a: any;\n}\nexport function evil(){ return 1; }\ninterface B',
          type: 'any;\n}\nexport function evil2(){ return 2; }',
          description: '*/ evil(); /*',
        },
      ],
      dir,
    );

    assert.deepEqual(syntaxErrors(file.content), [], file.content);
    assert.ok(!file.content.includes('export function evil'), '未中和的注入:\n' + file.content);
    // 描述里的 */ 必须转义，否则注释会提前闭合
    assert.ok(file.content.includes('*\\/'), '注释结束符未转义:\n' + file.content);
    // 字段名被清洗成合法标识符
    assert.match(file.content, /^\s+a__any/m);
  });
});

test('express route path injection is escaped inside the string literal', async () => {
  await withTempDir(async (dir) => {
    const malicious = "/x'); require('child_process').execSync('calc'); //";
    const file = await generateExpressRoute(malicious, dir, { description: 'desc*/ })(); /*' });

    assert.deepEqual(syntaxErrors(file.content), [], file.content);
    assert.ok(
      !file.content.includes("'/x'); require("),
      '单引号未转义，路由字符串被提前闭合:\n' + file.content,
    );
    // 转义后字符串里出现反斜杠+单引号，而不是提前闭合的单引号
    assert.ok(file.content.includes(String.fromCharCode(92) + "'"), '应出现转义后的引号:\n' + file.content);
    // 注释里的 */ 也必须中和，否则后续代码会被裁掉
    assert.ok(
      !file.content.includes('desc*/ })(); /*'),
      '注释中的注入未中和:\n' + file.content,
    );
    assert.ok(file.content.includes('*\\/'), '注释结束符未转义:\n' + file.content);
  });
});

test('package.json template always emits valid JSON', async () => {
  await withTempDir(async (dir) => {
    const generator = new CodeGenerator({ outputDir: dir });
    const file = await generator.generate('package-json', 'package.json', {
      name: 'pkg"with\\quote',
      description: 'line1\nline2\ttab',
      scripts: [
        { name: 'build', command: 'tsc "x"' },
        { name: 'test', command: 'echo \'y\'' },
      ],
      keywords: ['a"b', 'c\\d'],
      dependencies: [{ name: '@scope/pkg', version: '^1.0.0' }],
    });

    const parsed = JSON.parse(file.content) as Record<string, unknown>;
    assert.equal(parsed.name, 'pkg"with\\quote');
    assert.equal(parsed.description, 'line1\nline2\ttab');
    assert.deepEqual(Object.keys(parsed.scripts as object), ['build', 'test']);
    assert.equal(
      (parsed.dependencies as Record<string, string>)['@scope/pkg'],
      '^1.0.0',
    );
  });
});

test('package.json without dependencies has no dangling comma', async () => {
  await withTempDir(async (dir) => {
    const generator = new CodeGenerator({ outputDir: dir });
    const file = await generator.generate('package-json', 'package.json', {
      name: 'plain',
      scripts: [{ name: 'build', command: 'tsc' }],
    });
    assert.deepEqual(Object.keys(JSON.parse(file.content)), [
      'name', 'version', 'description', 'main', 'type', 'scripts', 'keywords', 'author', 'license',
    ]);
  });
});

test('tsconfig template emits quoted array entries and valid JSON', async () => {
  await withTempDir(async (dir) => {
    const generator = new CodeGenerator({ outputDir: dir });
    const file = await generator.generate('tsconfig-json', 'tsconfig.json', {
      libs: ['ES2020', 'DOM'],
      include: ['src/**/*.ts', 'types/**/*.d.ts'],
      exclude: ['node_modules'],
    });

    const parsed = JSON.parse(file.content) as {
      compilerOptions: { lib: string[] };
      include: string[];
      exclude: string[];
    };
    assert.deepEqual(parsed.compilerOptions.lib, ['ES2020', 'DOM']);
    assert.deepEqual(parsed.include, ['src/**/*.ts', 'types/**/*.d.ts']);
    assert.deepEqual(parsed.exclude, ['node_modules']);
  });
});

test('every builtin template stays parseable for benign context', async () => {
  await withTempDir(async (dir) => {
    const generator = new CodeGenerator({ outputDir: dir });
    const cases: Array<{ template: string; file: string; context: Record<string, unknown> }> = [
      {
        template: 'react-component',
        file: 'A.tsx',
        context: {
          name: 'Widget',
          hasProps: true,
          hasStyles: true,
          hasState: true,
          hasEffect: true,
          props: [{ name: 'title', type: 'string', optional: true, description: '标题' }],
          states: [{ name: 'count', type: 'number', initial: 0 }],
        },
      },
      {
        template: 'react-class-component',
        file: 'B.tsx',
        context: {
          name: 'Legacy',
          hasProps: true,
          hasState: true,
          props: [{ name: 'value', type: 'number' }],
          states: [{ name: 'open', type: 'boolean', initial: false }],
        },
      },
      {
        template: 'express-route',
        file: 'r.route.ts',
        context: {
          path: '/items',
          hasAuth: true,
          hasValidation: true,
          validationFields: [{ name: 'email', required: true, type: 'email' }],
        },
      },
      {
        template: 'typescript-interface',
        file: 'I.ts',
        context: { name: 'Item', fields: [{ name: 'id', type: 'string' }, { name: 'n', type: 'number', optional: true }] },
      },
      {
        template: 'typescript-class',
        file: 'K.ts',
        context: {
          name: 'Service',
          extends: 'Base',
          implements: ['Runnable', 'Disposable'],
          fields: [{ access: 'private', name: 'id', type: 'string' }],
          constructorParams: [{ name: 'id', type: 'string' }],
          methods: [{ name: 'run', returnType: 'void', async: false, access: 'public' }],
        },
      },
      {
        template: 'jest-test',
        file: 'j.test.ts',
        context: { name: 'sum', fileName: 'sum', tests: [{ description: 'adds', async: false }] },
      },
      {
        template: 'vitest-test',
        file: 'v.test.ts',
        context: { name: 'sum', fileName: 'sum', hasMocks: true, tests: [{ description: 'adds', async: true }] },
      },
    ];

    for (const c of cases) {
      const file = await generator.generate(c.template, c.file, c.context);
      const errors = syntaxErrors(file.content, c.file);
      assert.deepEqual(errors, [], `${c.template} 生成物语法错误：\n${file.content}`);
    }
  });
});

/** mulberry32：定种子伪随机，失败信息打印种子与 case 编号。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NASTY_CHARS = ['a', 'Z', '0', '_', '$', '"', "'", '`', '\\', '\n', '\r', '{', '}', ';', '(', ')', '<', '>', '*', '/', ' ', '\u2028'];

test('randomized: interface/express generation with hostile identifiers never yields injected code', async () => {
  const seed = 0xc0de1;
  const rand = mulberry32(seed);

  await withTempDir(async (dir) => {
    const generator = new CodeGenerator({ outputDir: dir });

    for (let caseIndex = 0; caseIndex < 40; caseIndex++) {
      const piece = (max: number) => {
        const len = 1 + Math.floor(rand() * max);
        let out = '';
        for (let i = 0; i < len; i++) out += NASTY_CHARS[Math.floor(rand() * NASTY_CHARS.length)]!;
        return out;
      };

      const marker = `evil_${caseIndex}`;
      const injectedName = `${piece(12)}\n} export function ${marker}(){ return 1; } interface Z`;
      const injectedType = `${piece(10)}; } export function ${marker}_2(){ return 2; }`;
      const injectedDescription = `${piece(12)}*/ ${marker}(); /*`;
      const injectedPath = `/p${piece(14)}'); require('${marker}'); //`;

      const iface = await generator.generate('typescript-interface', `I${caseIndex}.ts`, {
        name: 'I',
        fields: [{ name: injectedName, type: injectedType, description: injectedDescription }],
      });
      const route = await generator.generate('express-route', `r${caseIndex}.ts`, {
        path: injectedPath,
        description: injectedDescription,
      });

      for (const [label, content] of [
        ['interface', iface.content],
        ['route', route.content],
      ] as const) {
        assert.deepEqual(
          syntaxErrors(content),
          [],
          `seed=${seed} case=${caseIndex} (${label}): 生成物语法错误\n${content}`,
        );
        assert.ok(
          !new RegExp(`function\\s+${marker}\\s*\\(`).test(content),
          `seed=${seed} case=${caseIndex} (${label}): 注入出了函数 ${marker}\n${content}`,
        );
      }
    }
  });
});
