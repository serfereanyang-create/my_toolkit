/**
 * openapiTypes.ts — OpenAPI 3.x components.schemas → TypeScript 类型。
 *
 * 支持 JSON Schema 子集：object / array / string(enum) / number / integer /
 * boolean / $ref / allOf / oneOf / additionalProperties / nullable / description。
 * 纯字符串生成：无命令执行、无网络。
 */

export interface OpenApiSchema {
  type?: string;
  format?: string;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  enum?: Array<string | number>;
  nullable?: boolean;
  allOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  additionalProperties?: boolean | OpenApiSchema;
  description?: string;
  $ref?: string;
}

export interface TypeGenResult {
  ok: boolean;
  errors: string[];
  source: string;
  typeCount: number;
}

/** '#/components/schemas/Pet' → 'Pet' */
export function refName(ref: string): string | null {
  if (typeof ref !== 'string') return null;
  const parts = ref.split('/');
  return parts.length > 0 ? parts[parts.length - 1]! : null;
}

/** TS 单引号字符串字面量：引号、反斜杠、换行和 U+2028/2029 都要转义，
 *  否则 enum 值或属性名会把生成的文件变成语法错误。 */
function tsStringLiteral(value: string): string {
  let out = "'";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x2028 || code === 0x2029) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}'`;
}

/** Schema 名 → 合法 TS 类型名（PascalCase、去非法字符）。 */
export function toTypeName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9]+(.)?/g, (_, ch: string | undefined) => (ch ? ch.toUpperCase() : ''));
  const pascal = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return /^[A-Za-z]/.test(pascal) ? pascal : `Type${pascal}`;
}

/** 属性名：合法标识符直接用，否则加引号。 */
function toPropName(raw: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(raw) ? raw : tsStringLiteral(raw);
}

function tsDoc(description: string | undefined, indent: string): string {
  if (!description) return '';
  const lines = description.trim().split('\n').slice(0, 6);
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`;
}

/** 内联 schema → TS 类型表达式（不生成命名类型）。 */
export function schemaToType(
  schema: OpenApiSchema | undefined,
  types: Map<string, OpenApiSchema>,
  depth: number,
  nameOf?: (raw: string) => string,
): string {
  const pad = depth > 32; // 深度保护，防御循环 $ref
  // 规范可能是手写的：null / 数组 / 数字条目以前会在这里 `.enum` 崩掉。
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || pad) return 'unknown';
  if (schema.$ref !== undefined) {
    const name = typeof schema.$ref === 'string' ? refName(schema.$ref) : null;
    if (!name) return 'unknown';
    return nameOf ? nameOf(name) : toTypeName(name);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const literals = schema.enum.map((v) => (typeof v === 'string' ? tsStringLiteral(v) : Number.isFinite(v as number) ? String(v) : 'null'));
    const base = literals.join(' | ');
    return schema.nullable === true ? `${base} | null` : base;
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const parts = schema.allOf.map((part) => schemaToType(part, types, depth + 1, nameOf));
    const joined = parts.join(' & ');
    return schema.nullable === true ? `(${joined}) | null` : joined;
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const parts = schema.oneOf.map((part) => schemaToType(part, types, depth + 1, nameOf));
    const joined = parts.join(' | ');
    return schema.nullable === true ? `(${joined}) | null` : joined;
  }
  if (schema.type === 'array') {
    const item = schemaToType(schema.items, types, depth + 1, nameOf);
    const wrapped = item.includes(' | ') || item.includes(' & ') ? `(${item})` : item;
    const base = `${wrapped}[]`;
    return schema.nullable === true ? `${base} | null` : base;
  }
  if (schema.type === 'object' || schema.properties) {
    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const valueType = schemaToType(schema.additionalProperties, types, depth + 1, nameOf);
        return `Record<string, ${valueType}>`;
      }
      return 'Record<string, unknown>';
    }
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const lines: string[] = [];
    for (const [name, prop] of Object.entries(schema.properties)) {
      const optional = required.has(name) ? '' : '?';
      const propType = schemaToType(prop, types, depth + 1, nameOf);
      const nullSuffix = prop?.nullable === true && !propType.endsWith(' | null') ? ' | null' : '';
      lines.push(`${tsDoc(prop?.description, '  ')}  ${toPropName(name)}${optional}: ${propType}${nullSuffix};`);
    }
    const extra = schema.additionalProperties && typeof schema.additionalProperties === 'object'
      ? `  [key: string]: ${schemaToType(schema.additionalProperties, types, depth + 1, nameOf)};\n`
      : '';
    return `{\n${extra}${lines.join('\n')}\n}`;
  }
  if (schema.type === 'string') return schema.nullable === true ? 'string | null' : 'string';
  if (schema.type === 'integer' || schema.type === 'number') return schema.nullable === true ? 'number | null' : 'number';
  if (schema.type === 'boolean') return schema.nullable === true ? 'boolean | null' : 'boolean';
  return 'unknown';
}

/** 生成全部命名类型。依赖顺序：被引用者先输出。 */
export function generateTypes(spec: unknown): TypeGenResult {
  const errors: string[] = [];
  const root = (spec && typeof spec === 'object' ? spec : {}) as { components?: { schemas?: Record<string, OpenApiSchema> } };
  const schemas = root.components?.schemas;
  if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas) || Object.keys(schemas).length === 0) {
    return { ok: false, errors: ['spec 中没有 components.schemas，或为空。'], source: '', typeCount: 0 };
  }
  const types = new Map(Object.entries(schemas));

  // 两层不同 schema 名可能折叠成同一个 TS 名（pet-tag / pet_tag → PetTag）。
  // 不处理的话生成的文件里会出现重复的 interface 声明，TS 里会合并成一个
  // 类型、在别处则直接报错。给后续重名项加数字后缀并记一条 error。
  const names = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const raw of types.keys()) {
    let candidate = toTypeName(raw);
    if (usedNames.has(candidate)) {
      let suffix = 2;
      while (usedNames.has(`${candidate}${suffix}`)) suffix += 1;
      const unique = `${candidate}${suffix}`;
      errors.push(`类型名冲突：${raw} 与已生成的 ${candidate} 同名，已改为 ${unique}。`);
      candidate = unique;
    }
    usedNames.add(candidate);
    names.set(raw, candidate);
  }
  const nameOf = (raw: string) => names.get(raw) ?? toTypeName(raw);

  // 拓扑排序：$ref 依赖先输出
  const emitted = new Set<string>();
  const order: string[] = [];
  const visiting = new Set<string>();

  function visit(name: string): void {
    if (emitted.has(name) || visiting.has(name)) return;
    visiting.add(name);
    const schema = types.get(name);
    if (schema) {
      collectRefs(schema, types, (dep) => {
        if (types.has(dep) && !emitted.has(dep)) visit(dep);
      });
    }
    visiting.delete(name);
    emitted.add(name);
    order.push(name);
  }

  for (const name of types.keys()) visit(name);

  const blocks: string[] = [];
  for (const name of order) {
    const schema = types.get(name);
    const typeName = nameOf(name);
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      blocks.push(`export type ${typeName} = unknown;`);
      continue;
    }
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      const union = schemaToType(schema, types, 0, nameOf);
      blocks.push(`${tsDoc(schema.description, '')}export type ${typeName} = ${union};`);
      continue;
    }
    const body = schemaToType(schema, types, 0, nameOf);
    if (body.startsWith('{')) {
      blocks.push(`${tsDoc(schema.description, '')}export interface ${typeName} ${body}`);
    } else {
      blocks.push(`${tsDoc(schema.description, '')}export type ${typeName} = ${body};`);
    }
  }

  const header = [
    '/**',
    ' * 由 OpenAPI 规范自动生成 — 不要手工编辑。',
    ` * 类型数：${order.length}`,
    ' */',
    '',
  ].join('\n');

  return { ok: errors.length === 0, errors, source: header + blocks.join('\n\n') + '\n', typeCount: order.length };
}

function collectRefs(
  schema: OpenApiSchema | undefined,
  types: Map<string, OpenApiSchema>,
  emit: (name: string) => void,
): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  if (schema.$ref !== undefined) {
    const name = typeof schema.$ref === 'string' ? refName(schema.$ref) : null;
    if (name) emit(name);
    return;
  }
  if (schema.items) collectRefs(schema.items, types, emit);
  if (Array.isArray(schema.allOf)) for (const part of schema.allOf) collectRefs(part, types, emit);
  if (Array.isArray(schema.oneOf)) for (const part of schema.oneOf) collectRefs(part, types, emit);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    collectRefs(schema.additionalProperties, types, emit);
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const prop of Object.values(schema.properties)) collectRefs(prop, types, emit);
  }
}
