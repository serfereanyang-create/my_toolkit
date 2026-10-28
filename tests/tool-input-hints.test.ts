/**
 * tool-input-hints.test.ts — 守住工具调用契约的「说明书」那一半。
 *
 * 模型能不能正确调用一个工具，取决于两件事：参数能被解析（providers 一层的
 * 修复），以及工具规格有没有告诉模型该发什么。规格这半边的载体就是
 * `ToolDefinition.inputHint`：`providers/protocol.ts` 里
 * `tool.inputSchema ?? schemaFromInputHint(tool.inputHint)` 把它变成模型看到的
 * JSON Schema。所以 hint 一旦变成空的 `'{}'`、写坏成非法 JSON、或者漏掉了
 * handler 真正要读的键，schema 就会退化成一个「什么都不说」的 object，
 * 模型只能凭猜发参数，然后拿到「path is required」再原样重试。
 *
 * 这个测试就是防它再次衰减的闸门：所有断言都是泛化的（不写死工具名/数量），
 * 新增工具只要 hint 是一个合法的 JSON 对象示例就能通过。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schemaFromInputHint } from '../src/providers/protocol.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { createBackgroundAppTools } from '../src/tools/backgroundApp.js';
import { createBackgroundBrowserTools } from '../src/tools/backgroundBrowser.js';
import { createBackgroundNativeTools } from '../src/tools/backgroundNative.js';
import { createComputerTools } from '../src/tools/computer.js';

/** 桌面桥注入的工具在 agent.ts 里按需注册，用桩 invoke 也能拿到规格。 */
const hostInvoke = async () => ({ ok: true, output: '' });

/**
 * 真正的工具全集：createDefaultToolRegistry 的静态工具 + agent 运行时注入的
 * computer_* / background_* 工具。（propose_plan / supervisor_status /
 * open_pull_request 需要完整 runtime 才能构造，它们的 hint 是就地
 * JSON.stringify 出来的对象字面量，随源码一起评审。）
 */
function registeredTools(): ToolDefinition[] {
  return [
    ...createDefaultToolRegistry().list(),
    ...createComputerTools(),
    ...createBackgroundBrowserTools(hostInvoke),
    ...createBackgroundAppTools(hostInvoke),
    ...createBackgroundNativeTools(hostInvoke),
  ];
}

/** 取 hint 里第一个配平的 `{...}`，用于判断它是不是一个合法的 JSON 对象示例。 */
function hintObjectLiteral(hint: string): { ok: boolean; text?: string; value?: unknown; reason?: string } {
  const start = hint.indexOf('{');
  if (start < 0) return { ok: false, reason: 'hint 里没有对象字面量' };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < hint.length; i += 1) {
    const ch = hint[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const text = hint.slice(start, i + 1);
        try {
          return { ok: true, text, value: JSON.parse(text) };
        } catch (error) {
          return { ok: false, text, reason: error instanceof Error ? error.message : String(error) };
        }
      }
    }
  }
  return { ok: false, reason: 'hint 里的对象没有闭合' };
}

/** provider 层真正会交给模型的 schema；显式给了 inputSchema 的工具不经过 hint 派生。 */
function schemaFor(tool: ToolDefinition): Record<string, unknown> {
  return tool.inputSchema ?? schemaFromInputHint(tool.inputHint);
}

function schemaProperties(tool: ToolDefinition): Record<string, { type?: unknown }> {
  const schema = schemaFor(tool);
  const properties = schema.properties;
  if (properties === undefined) return {}; // 无参数工具的 schema 是 { type: 'object', additionalProperties: true }
  assert.ok(properties && typeof properties === 'object', `${tool.name}: schema 的 properties 不是对象`);
  return properties as Record<string, { type?: unknown }>;
}

/**
 * 一份 hint 若只由这些「工作区通用键」组成，两个不同家族的工具共用它是合理的
 * （例如都在说「扫这个 path / 这个 glob」）。反之，一个带专属取值（某个工具的
 * 特征字符串、某个只有那个工具读的键）的 hint 出现在两个不相关的工具上，
 * 基本就是复制粘贴留下的残迹。
 */
const GENERIC_HINT_KEYS = new Set([
  'path',
  'pattern',
  'query',
  'file',
  'text',
  'needle',
  'count',
  'limit',
  'maxFiles',
  'maxResults',
  'maxShow',
  'topN',
]);

function familyOf(toolName: string): string {
  return toolName.split('_')[0] ?? toolName;
}

test('every registered tool ships a non-empty inputHint', () => {
  const tools = registeredTools();
  assert.ok(tools.length > 0, '工具列表为空');
  for (const tool of tools) {
    assert.equal(typeof tool.inputHint, 'string', `${tool.name}: inputHint 必须是字符串`);
    assert.notEqual(tool.inputHint.trim(), '', `${tool.name}: inputHint 为空，模型看不到任何参数示例`);
  }
});

test('every hint parses to a JSON object with at least one property (or is the explicit no-argument {})', () => {
  const emptyHintTools: string[] = [];
  for (const tool of registeredTools()) {
    // 显式 inputSchema 的工具不靠 hint 派生 schema，hint 只是纯文本提示，
    // 允许它带说明性文字（例如「url 或 path 二选一」）。
    if (tool.inputSchema) continue;
    const parsed = hintObjectLiteral(tool.inputHint);
    assert.ok(parsed.ok, `${tool.name}: inputHint 不是合法的 JSON 对象示例（${parsed.reason}）: ${tool.inputHint}`);
    assert.equal(typeof parsed.value, 'object', `${tool.name}: inputHint 的示例必须是对象`);
    assert.ok(!Array.isArray(parsed.value), `${tool.name}: inputHint 的示例不能是数组`);

    const exampleKeys = Object.keys(parsed.value as Record<string, unknown>);
    const properties = schemaProperties(tool);
    const propertyNames = Object.keys(properties);

    if (exampleKeys.length === 0) {
      // 真正无参数可传的工具：'{}' 是诚实的写法，派生结果应退化为
      // 「任意对象」而不是伪装出属性。
      emptyHintTools.push(tool.name);
      assert.deepEqual(propertyNames, [], `${tool.name}: hint 是 '{}' 却派生出属性 ${propertyNames.join(', ')}`);
      continue;
    }

    assert.ok(
      propertyNames.length > 0,
      `${tool.name}: hint 示例有 ${exampleKeys.length} 个键，派生出的 schema 却一个属性都没有`,
    );
    for (const key of exampleKeys) {
      assert.ok(
        propertyNames.includes(key),
        `${tool.name}: hint 里写了 "${key}"，派生出的 schema 却漏掉了它（${propertyNames.join(', ')}）`,
      );
    }
  }
  // 无参数工具只能是少数几个面生的例外；数量暴涨通常意味着大家都在写 '{}'。
  assert.ok(
    emptyHintTools.length < registeredTools().length / 2,
    `写成 '{}' 的工具过多（${emptyHintTools.length} 个）: ${emptyHintTools.join(', ')}`,
  );
});

test('every schema property is a non-empty type and required only names declared properties', () => {
  for (const tool of registeredTools()) {
    const properties = schemaProperties(tool);
    for (const [name, spec] of Object.entries(properties)) {
      assert.ok(spec && typeof spec === 'object', `${tool.name}.${name}: 属性规格必须是对象`);
      assert.equal(typeof spec.type, 'string', `${tool.name}.${name}: 属性缺少 type`);
      assert.notEqual((spec.type as string).trim(), '', `${tool.name}.${name}: 属性 type 为空`);
    }
    const schema = schemaFor(tool);
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const name of required) {
        assert.ok(
          typeof name === 'string' && Object.hasOwn(properties, name),
          `${tool.name}: required 里的 "${String(name)}" 并没有在 properties 里声明`,
        );
      }
    }
  }
});

test('no two tools share a hint that clearly belongs to a different tool', () => {
  const byHint = new Map<string, string[]>();
  for (const tool of registeredTools()) {
    const key = tool.inputHint.trim();
    const names = byHint.get(key) ?? [];
    names.push(tool.name);
    byHint.set(key, names);
  }
  for (const [hint, names] of byHint) {
    if (names.length < 2) continue;
    if (hint === '{}') continue; // 无参数工具天然共用空示例
    const families = new Set(names.map(familyOf));
    if (families.size === 1) continue; // 同一家族共用一套「工作区扫描」形状是正常的
    const parsed = hintObjectLiteral(hint);
    const keys = parsed.ok ? Object.keys(parsed.value as Record<string, unknown>) : [];
    const generic = keys.length > 0 && keys.every((key) => GENERIC_HINT_KEYS.has(key));
    assert.ok(
      generic,
      `hint ${JSON.stringify(hint)} 被不同家族的工具共用（${names.join(', ')}），疑似复制粘贴残迹；` +
        `若确属通用示例，请把键限制在 ${[...GENERIC_HINT_KEYS].join('/')} 里`,
    );
  }
});

test('a hint example the handler would reject is a bug: validate() accepts its own hint', () => {
  for (const tool of registeredTools()) {
    if (tool.inputSchema) continue; // 桌面桥工具用 inputSchema 校验，hint 只是提示文本
    const parsed = hintObjectLiteral(tool.inputHint);
    if (!parsed.ok) continue; // 由上一条断言负责报告
    assert.doesNotThrow(
      () => tool.validate(parsed.value),
      `${tool.name}: 自己的 hint 示例过不了自己的 validate(): ${tool.inputHint}`,
    );
  }
});
