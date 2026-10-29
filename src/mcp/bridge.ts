import { createHash } from 'node:crypto';
import type { ToolDefinition, ToolResult } from '../tools/types.js';
import type { ToolRisk } from '../safety/policy.js';
import type { McpClient } from './client.js';
import type { McpToolDescriptor } from './types.js';

/**
 * Provider APIs cap a function name at 64 characters (OpenAI is the strictest).
 * Names built from a long server + tool pair are folded deterministically so
 * the same server always maps to the same registered tool.
 */
export const MCP_TOOL_NAME_MAX = 64;

export function mcpToolName(serverName: string, toolName: string) {
  const full = `mcp_${sanitizeToken(serverName)}_${sanitizeToken(toolName)}`;
  if (full.length <= MCP_TOOL_NAME_MAX) return full;
  const digest = createHash('sha256').update(full).digest('hex').slice(0, 8);
  return `${full.slice(0, MCP_TOOL_NAME_MAX - 9)}_${digest}`;
}

export function bridgeMcpTools(client: McpClient): ToolDefinition[] {
  return client.getTools().map((tool) => bridgeOne(client, tool));
}

function bridgeOne(client: McpClient, tool: McpToolDescriptor): ToolDefinition<Record<string, unknown>> {
  const name = mcpToolName(client.name, tool.name);
  const { risk, ...governance } = governanceForTool(tool);
  const description = `[mcp:${client.name}] ${tool.description ?? tool.name}`;
  const inputHint = inputHintForSchema(tool.inputSchema);

  return {
    name,
    description,
    inputHint,
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    risk,
    ...governance,
    validate(input) {
      return validateMcpInput(tool, input);
    },
    async execute(input): Promise<ToolResult> {
      try {
        const result = await client.callTool(tool.name, input);
        const text = formatContent(result.content);
        if (result.isError) {
          return { ok: false, output: text || `MCP tool ${tool.name} returned isError`, data: result };
        }
        return { ok: true, output: text || '(no output)', data: result };
      } catch (error) {
        return {
          ok: false,
          output: `MCP tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * Risk and approval flags for an externally declared tool.
 *
 * The annotations come from the MCP server itself; they are a claim, not a
 * capability check. `read` is never granted for them: `decideApproval`
 * short-circuits a read-risk tool with `allowed: true, needsPrompt: false` in
 * EVERY mode, including `deny`, so a server that writes files while claiming
 * `readOnlyHint: true` used to run with no approval anywhere. Both hints now
 * only raise the tier to `write`; no annotation stays at the conservative
 * `shell` tier.
 *
 * - `destructiveHint` wins over a simultaneous `readOnlyHint` (a tool that
 *   says it destroys work must not be downgraded by a contradictory field) and
 *   carries `alwaysPrompt`, so it is never approved silently in auto mode.
 * - `readOnlyHint` alone is advisory: it still prompts in ask/plan and is
 *   refused in deny, and in auto mode a write tool without a workspace path
 *   target is refused by the path allowlist. It deliberately gets no
 *   `autoApprove`: that flag exists for tools the *workspace owner* declared,
 *   and granting it from a server's own claim would recreate the bypass at a
 *   lower tier. A server that wants frictionless auto-mode calls can ship a
 *   plugin manifest instead, where the owner opted in.
 */
export function governanceForTool(tool: McpToolDescriptor): { risk: ToolRisk; autoApprove?: true; alwaysPrompt?: true } {
  if (tool.annotations?.destructiveHint === true) return { risk: 'write', alwaysPrompt: true };
  if (tool.annotations?.readOnlyHint === true) return { risk: 'write' };
  // Unannotated stays the conservative `shell` tier: auto mode refuses it
  // unless its arguments carry a command on the built-in allowlist, ask/plan
  // prompt for every call, and deny refuses it.
  return { risk: 'shell' };
}

export function riskForTool(tool: McpToolDescriptor): ToolRisk {
  return governanceForTool(tool).risk;
}

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);

/**
 * Validate the model-supplied arguments against the tool's declared JSON
 * schema.
 *
 * This is a deliberate subset (the top-level contract: object-ness, `required`,
 * property types, `enum`) rather than a JSON Schema implementation. Before it
 * existed the bridge only checked "is an object", so a schema saying
 * `{ text: string, required: ['text'] }` happily forwarded `{ text: 42 }`
 * and `{}` to the server. Nested values are still passed through: MCP servers
 * own their own validation for those, and rewriting or stripping them here
 * could change what a correct call means.
 */
export function validateMcpInput(tool: McpToolDescriptor, input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) {
    const required = requiredFields(tool.inputSchema);
    if (required.length > 0) {
      throw new Error(`missing required argument${required.length === 1 ? '' : 's'}: ${required.join(', ')}`);
    }
    return {};
  }
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('expected an object');
  const record = input as Record<string, unknown>;
  const schema = tool.inputSchema;
  if (!isRecord(schema)) return record;

  const declaredType = schema.type;
  if (typeof declaredType === 'string' && declaredType !== 'object' && JSON_TYPES.has(declaredType)) {
    // An MCP tool whose top-level schema is not an object cannot take JSON-RPC
    // arguments at all; refuse instead of sending a value that can never match.
    throw new Error(`expected arguments matching schema type "${declaredType}"`);
  }

  for (const field of requiredFields(schema)) {
    if (record[field] === undefined) throw new Error(`missing required argument: ${field}`);
  }

  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (!properties) return record;
  for (const [field, propertySchema] of Object.entries(properties)) {
    if (!(field in record)) continue;
    const value = record[field];
    if (value === undefined) continue;
    if (!isRecord(propertySchema)) continue;
    const typeError = checkType(field, value, propertySchema);
    if (typeError) throw new Error(typeError);
    const enumValues = Array.isArray(propertySchema.enum) ? propertySchema.enum : undefined;
    if (enumValues && !enumValues.some((candidate) => primitiveEquals(candidate, value))) {
      throw new Error(`argument "${field}" must be one of: ${enumValues.map((v) => JSON.stringify(v)).join(', ')}`);
    }
  }
  return record;
}

function requiredFields(schema: Record<string, unknown> | undefined): string[] {
  if (!isRecord(schema) || !Array.isArray(schema.required)) return [];
  return schema.required.filter((field): field is string => typeof field === 'string');
}

function checkType(field: string, value: unknown, schema: Record<string, unknown>): string | undefined {
  const declared = schema.type;
  const types = Array.isArray(declared)
    ? declared.filter((t): t is string => typeof t === 'string')
    : typeof declared === 'string' ? [declared] : [];
  if (types.length === 0) return undefined;
  const known = types.filter((t) => JSON_TYPES.has(t));
  if (known.length === 0) return undefined;
  if (known.some((type) => matchesType(value, type))) return undefined;
  return `argument "${field}" must be of type ${known.join(' | ')}; received ${describeValue(value)}`;
}

function matchesType(value: unknown, type: string) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return isRecord(value);
    case 'null': return value === null;
    default: return true;
  }
}

function describeValue(value: unknown) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function primitiveEquals(a: unknown, b: unknown) {
  return a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b));
}

function sanitizeToken(value: string) {
  const cleaned = value.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'tool';
}

function inputHintForSchema(schema: Record<string, unknown> | undefined) {
  if (!schema) return '{}';
  try {
    const text = JSON.stringify(schema);
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  } catch {
    return '{}';
  }
}

function formatContent(content: Array<{ type: string; text?: string }> | undefined) {
  if (!content || content.length === 0) return '';
  return content
    .map((block) => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      return JSON.stringify(block);
    })
    .filter(Boolean)
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
