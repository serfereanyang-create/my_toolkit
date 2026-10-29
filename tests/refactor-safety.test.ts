/**
 * refactor-safety.test.ts — 重构（Extract Method / Rename）写入安全
 *
 * 旧实现实测问题：
 *  - extract_method 工具 preview:false 只回一句“✅ 成功提取”，从未写文件；
 *  - 类方法内提取把新方法放到了文件末尾（类外），生成代码语法错误；
 *  - 选中整个函数/声明也能“提取”，产出无意义的调用；
 *  - `const c = <expr>; return c;` 的 c 没被识别为返回值；
 *  - quickRename 用 `\boldName\b` 正则替换整份文件，字符串字面量、遮蔽变量一起改。
 * 这里全部按“写盘结果 + 语法诊断”验收，不只看返回值。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ts from 'typescript';
import { previewExtractMethod, extractMethod } from '../src/refactor/extract-method.js';
import { quickRename, renameSymbol } from '../src/refactor/rename.js';
import { extractMethodTool } from '../src/refactor/tools.js';
import type { ToolContext } from '../src/tools/types.js';

/** 用 TypeScript 的语法诊断当“产出的代码还能不能编译”的判据。 */
function syntaxErrors(code: string, fileName = 'probe.ts'): string[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'refactor-safety-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 构造最小 ToolContext（工具只用到 workspaceRoot）。 */
function toolContext(workspaceRoot: string): ToolContext {
  return { workspaceRoot, approval: 'auto' };
}

const CLASS_SOURCE = [
  'export class Service {',
  '  run(xs: number[]) {',
  '    for (const x of xs) {',
  '      this.emit(x);',
  '    }',
  '  }',
  '  emit(x: number) { console.log(x); }',
  '}',
  '',
].join('\n');

test('extract method inside a class stays inside the class and parses', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'svc.ts'), CLASS_SOURCE, 'utf8');
    const preview = await previewExtractMethod('svc.ts', dir, {
      methodName: 'forward',
      startLine: 3,
      endLine: 5,
    });

    assert.ok(preview.result.isSafe, `提取应判定安全：${preview.result.warnings.join('; ')}`);
    assert.deepEqual(syntaxErrors(preview.modified), []);

    const lines = preview.modified.split('\n');
    const classOpen = lines.findIndex((l) => l.includes('export class Service'));
    // 类的闭括号在行首（成员方法体里的 `}` 有缩进，不能拿来当类结束）
    const classClose = lines.findIndex((l, i) => i > classOpen && l === '}');
    const methodLine = lines.findIndex((l) => /^\s{2}forward\(/.test(l));
    assert.ok(methodLine > classOpen, `forward 方法应在类内，实际位置 ${methodLine}`);
    assert.ok(methodLine < classClose, `forward 方法应在类结束前（类结束于 ${classClose}）`);
    // 类成员缩进与已有成员一致
    assert.match(lines[methodLine]!, /^ {2}forward\(/);
    // 调用点仍留在原方法里
    assert.ok(lines.some((l) => l.includes('this.forward(')), preview.modified);
  });
});

test('extracting a whole declaration is refused instead of emitting a bogus call', async () => {
  await withTempDir(async (dir) => {
    const source = 'export function f(a: number) {\n  let total = 0;\n  total = a + 1;\n  console.log(total);\n}\n';
    await writeFile(join(dir, 'whole.ts'), source, 'utf8');

    const result = await extractMethod('whole.ts', dir, {
      methodName: 'g',
      startLine: 1,
      endLine: 5,
    });

    assert.equal(result.isSafe, false);
    assert.ok(
      result.warnings.some((w) => w.includes('完整的声明')),
      `应提示选到了完整声明，实际警告：${JSON.stringify(result.warnings)}`,
    );
  });
});

test('const declared with initializer and returned is treated as an output', async () => {
  await withTempFileFixture(async (dir) => {
    // 只选声明行：选中范围一旦包含 return，提取会改动控制流，引擎会拒绝。
    const result = await extractMethod('calc.ts', dir, {
      methodName: 'compute',
      startLine: 5,
      endLine: 5,
    });
    assert.deepEqual(result.variableAnalysis.outputs, ['c']);
    assert.match(result.callSite, /const c = compute\(/);
  });
});

/** const 初始化 + 立即返回：提取后调用点必须把结果赋回 c。 */
async function withTempFileFixture(fn: (dir: string) => Promise<void>): Promise<void> {
  const source = [
    'export function use(a: number) {',
    '  const unused = 0;',
    '  console.log(unused);',
    '  // comment keeps line numbers stable',
    '  const c = a * 2;',
    '  return c;',
    '}',
    '',
  ].join('\n');
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'calc.ts'), source, 'utf8');
    await fn(dir);
  });
}

test('extracted function is placed after the enclosing function, not nested inside it', async () => {
  await withTempFileFixture(async (dir) => {
    const preview = await previewExtractMethod('calc.ts', dir, {
      methodName: 'compute',
      startLine: 5,
      endLine: 5,
    });
    assert.deepEqual(syntaxErrors(preview.modified), [], preview.modified);

    // 解析 AST：compute 必须是顶层函数，不能出现在 use() 的函数体里
    const sf = ts.createSourceFile('calc.ts', preview.modified, ts.ScriptTarget.Latest, true);
    const outer = sf.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'use',
    );
    assert.ok(outer, preview.modified);
    const nestedNames: string[] = [];
    const walk = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) nestedNames.push(node.name.text);
      ts.forEachChild(node, walk);
    };
    if (outer.body) walk(outer.body);
    assert.deepEqual(nestedNames, [], `compute 不应嵌进 use()，实际嵌套函数：${nestedNames.join(', ')}
${preview.modified}`);
    assert.ok(
      sf.statements.some(
        (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'compute',
      ),
      `compute 应作为顶层函数存在：
${preview.modified}`,
    );
  });
});

test('extract_method tool with preview:false actually writes the file', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'svc.ts'), CLASS_SOURCE, 'utf8');

    const result = await extractMethodTool.execute(
      { file: 'svc.ts', startLine: 3, endLine: 5, methodName: 'forward', preview: false },
      toolContext(dir),
    );

    assert.equal(result.ok, true, result.output);
    const written = await readFile(join(dir, 'svc.ts'), 'utf8');
    assert.ok(written.includes('forward('), `文件应被真正改写，实际内容：\n${written}`);
    assert.deepEqual(syntaxErrors(written), []);
    // 输出文案必须与事实一致（旧实现声称成功却一个字节都没写）
    assert.ok(result.output.includes('已写入'), result.output);
  });
});

test('extract_method tool refuses to write unsafe extraction', async () => {
  await withTempDir(async (dir) => {
    const source = 'export function f(a: number) {\n  let total = 0;\n  total = a + 1;\n  console.log(total);\n}\n';
    await writeFile(join(dir, 'whole.ts'), source, 'utf8');

    const result = await extractMethodTool.execute(
      { file: 'whole.ts', startLine: 1, endLine: 5, methodName: 'g', preview: false },
      toolContext(dir),
    );

    assert.equal(result.ok, false, '不安全的提取不能写盘');
    const after = await readFile(join(dir, 'whole.ts'), 'utf8');
    assert.equal(after, source, '被拒绝时文件必须保持原样');
  });
});

test('quickRename does not touch string literals or shadowed variables', async () => {
  const source = [
    'function outer() {',
    '  const data = 1;',
    '  const label = "data";',
    '  {',
    '    const data = 2;',
    '    return data;',
    '  }',
    '}',
    '',
  ].join('\n');

  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'shadow.ts'), source, 'utf8');
    // 第 2 行第 9 列 = outer 作用域里的 data
    const result = await quickRename('shadow.ts', dir, 2, 9, 'payload');

    assert.equal(result.success, true, result.message);
    const modified = result.modified!;
    assert.ok(modified.includes('const payload = 1;'), modified);
    assert.ok(modified.includes('"data"'), `字符串字面量不应被改：\n${modified}`);
    assert.ok(modified.includes('const data = 2;'), `内层遮蔽变量不应被改：\n${modified}`);
    assert.deepEqual(syntaxErrors(modified), []);
  });
});

test('renameSymbol replaces exactly the reference span (destructuring / property shorthand)', async () => {
  const source = [
    'export const value = 1;',
    'export function read(obj: { value: number }) {',
    '  const { value: local } = obj;',
    '  return local + obj.value - value;',
    '}',
    '',
  ].join('\n');

  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'prop.ts'), source, 'utf8');
    // 第 1 行第 14 列 = 顶层 const value
    const result = await renameSymbol(dir, { file: 'prop.ts', line: 1, column: 14, newName: 'amount' });
    assert.ok(result.isSafe, `重命名应安全：${result.errors.join('; ')}`);

    const modified = result.files.find((f) => f.path.replace(/\\/g, '/').endsWith('prop.ts'))!.modified;
    assert.deepEqual(syntaxErrors(modified), [], modified);
    assert.match(modified, /^export const amount = 1;/m);
    // 解构里 `{ value: local }` 的属性名不属于该符号，不能被替换成 amount: local 再叠字
    assert.ok(modified.includes('{ value: local }'), `解构键名应保持 value：\n${modified}`);
    assert.ok(modified.includes('obj.value'), `对象属性访问应保持 value：\n${modified}`);
    assert.ok(!/amount:\s*local/.test(modified), modified);
  });
});

/** 简易 mulberry32，随机化用例失败时打印种子与编号。 */
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

test('randomized: quickRename on random local identifiers never breaks syntax', async () => {
  const seed = 0x51c0de;
  const rand = mulberry32(seed);
  const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];

  await withTempDir(async (dir) => {
    for (let caseIndex = 0; caseIndex < 40; caseIndex++) {
      const pick = () => names[Math.floor(rand() * names.length)]!;
      const original = pick();
      const replacement = names.filter((n) => n !== original)[Math.floor(rand() * (names.length - 1))]!;
      const marker = `str_${caseIndex}`;

      // 变量出现在：声明、算术、字符串字面量、对象键、内层遮蔽作用域。
      const lines = [
        'export function run() {',
        `  const ${original} = ${caseIndex};`,
        `  const label = "${original}:${marker}";`,
        `  const box = { ${original}: ${original} + 1 };`,
        '  {',
        `    const ${original} = 9;`,
        `    console.log(${original});`,
        '  }',
        `  return [label, box, ${original}] as const;`,
        '}',
        '',
      ];
      const source = lines.join('\n');
      await writeFile(join(dir, `case${caseIndex}.ts`), source, 'utf8');

      const result = await quickRename(`case${caseIndex}.ts`, dir, 2, 9, replacement);
      assert.equal(
        result.success,
        true,
        `seed=${seed} case=${caseIndex}: ${result.message}`,
      );
      const modified = result.modified!;
      assert.deepEqual(
        syntaxErrors(modified),
        [],
        `seed=${seed} case=${caseIndex}: 改名后语法错误\n${modified}`,
      );
      assert.ok(
        modified.includes(`"${original}:${marker}"`),
        `seed=${seed} case=${caseIndex}: 字符串字面量被误改\n${modified}`,
      );
      assert.ok(
        modified.includes(`const ${original} = 9;`),
        `seed=${seed} case=${caseIndex}: 内层遮蔽变量被误改\n${modified}`,
      );
      assert.ok(
        modified.includes(`const ${replacement} = ${caseIndex};`),
        `seed=${seed} case=${caseIndex}: 声明未改名\n${modified}`,
      );
    }
  });
});
