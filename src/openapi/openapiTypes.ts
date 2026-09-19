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
  const parts = ref.split('/');
  return parts.length > 0 ? parts[parts.length - 1]! : null;
}

/** Schema 名 → 合法 TS 类型名（PascalCase、去非法字符）。 */
export function toTypeName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9]+(.)?/g, (_, ch: string | undefined) => (ch ? ch.toUpperCase() : ''));
  const pascal = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return /^[A-Za-z]/.test(pascal) ? pascal : `Type${pascal}`;
}

/** 属性名：合法标识符直接用，否则加引号。 */
function toPropName(raw: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(raw) ? raw : `'${raw.replace(/'/g, "\\'")}'`;
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
): string {
  const pad = depth > 32; // 深度保护，防御循环 $ref
  if (!schema || pad) return 'unknown';
  if (schema.$ref) {
    const name = refName(schema.$ref);
    return name ? toTypeName(name) : 'unknown';
  }
  if (schema.enum && schema.enum.length > 0) {
    const literals = schema.enum.map((v) => (typeof v === 'string' ? `'${v.replace(/'/g, "\\'")}'` : String(v)));
    const base = literals.join(' | ');
    return schema.nullable === true ? `${base} | null` : base;
  }
  if (schema.allOf && schema.allOf.length > 0) {
    const parts = schema.allOf.map((part) => schemaToType(part, types, depth + 1));
    const joined = parts.join(' & ');
    return schema.nullable === true ? `(${joined}) | null` : joined;
  }
  if (schema.oneOf && schema.oneOf.length > 0) {
    const parts = schema.oneOf.map((part) => schemaToType(part, types, depth + 1));
    const joined = parts.join(' | ');
    return schema.nullable === true ? `(${joined}) | null` : joined;
  }
  if (schema.type === 'array') {
    const item = schemaToType(schema.items, types, depth + 1);
    const wrapped = item.includes(' | ') || item.includes(' & ') ? `(${item})` : item;
    const base = `${wrapped}[]`;
    return schema.nullable === true ? `${base} | null` : base;
  }
  if (schema.type === 'object' || schema.properties) {
    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const valueType = schemaToType(schema.additionalProperties, types, depth + 1);
        return `Record<string, ${valueType}>`;
      }
      return 'Record<string, unknown>';
    }
    const required = new Set(schema.required ?? []);
    const lines: string[] = [];
    for (const [name, prop] of Object.entries(schema.properties)) {
      const optional = required.has(name) ? '' : '?';
      const propType = schemaToType(prop, types, depth + 1);
      const nullSuffix = prop.nullable === true && !propType.endsWith(' | null') ? ' | null' : '';
      lines.push(`${tsDoc(prop.description, '  ')}  ${toPropName(name)}${optional}: ${propType}${nullSuffix};`);
    }
    const extra = schema.additionalProperties && typeof schema.additionalProperties === 'object'
      ? `  [key: string]: ${schemaToType(schema.additionalProperties, types, depth + 1)};\n`
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
  const root = spec as { components?: { schemas?: Record<string, OpenApiSchema> } };
  const schemas = root?.components?.schemas;
  if (!schemas || typeof schemas !== 'object' || Object.keys(schemas).length === 0) {
    return { ok: false, errors: ['spec 中没有 components.schemas，或为空。'], source: '', typeCount: 0 };
  }
  const types = new Map(Object.entries(schemas));

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
    const schema = types.get(name)!;
    const typeName = toTypeName(name);
    if (schema.enum && schema.enum.length > 0) {
      const union = schemaToType(schema, types, 0);
      blocks.push(`${tsDoc(schema.description, '')}export type ${typeName} = ${union};`);
      continue;
    }
    const body = schemaToType(schema, types, 0);
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
  if (!schema) return;
  if (schema.$ref) {
    const name = refName(schema.$ref);
    if (name) emit(name);
    return;
  }
  if (schema.items) collectRefs(schema.items, types, emit);
  if (schema.allOf) for (const part of schema.allOf) collectRefs(part, types, emit);
  if (schema.oneOf) for (const part of schema.oneOf) collectRefs(part, types, emit);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    collectRefs(schema.additionalProperties, types, emit);
  }
  if (schema.properties) {
    for (const prop of Object.values(schema.properties)) collectRefs(prop, types, emit);
  }
}
