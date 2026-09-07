/**
 * TypeScript-compiler-backed precise language tools for the agent.
 *
 * Thin wrappers over the shared `language/tsService` engine (also used by the
 * desktop editor language bridge), so agent lookups and editor hover/goto stay
 * consistent. Three read-only tools:
 *   ts_hover            — symbol type + doc at path:line:column
 *   ts_goto_definition  — definition file/line for the symbol
 *   ts_exact_references — type-aware references (no comment/string false hits)
 */

import type { ToolDefinition } from './types.js';
import { hoverAt, definitionAt, referencesAt } from '../language/tsService.js';

type PositionInput = { path: string; line: number; column: number };

function validatePosition(input: unknown): PositionInput {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (typeof obj.path !== 'string' || !obj.path) throw new Error('path is required');
  const line = typeof obj.line === 'number' ? obj.line : 1;
  const column = typeof obj.column === 'number' ? obj.column : 1;
  if (line < 1 || column < 1) throw new Error('line/column are 1-based');
  return { path: obj.path, line, column };
}

const tsHoverTool: ToolDefinition<PositionInput> = {
  name: 'ts_hover',
  description: 'TypeScript type info for a symbol at path:line:column using the real compiler (exact types, docs). Read-only.',
  inputHint: '{ "path": "src/index.ts", "line": 10, "column": 5 }',
  risk: 'read',
  validate: validatePosition,
  async execute(input, context) {
    const info = hoverAt(context.workspaceRoot, input.path, input.line, input.column);
    if (!info) return { ok: true, output: '(no type info at this position)' };
    const parts = [
      info.type,
      info.documentation ? `doc: ${info.documentation}` : undefined,
      `${info.path}:${info.range.line}:${info.range.column}`,
    ].filter(Boolean);
    return { ok: true, output: parts.join('\n'), data: { type: info.type, ...info.range } };
  },
};

const tsGotoDefinitionTool: ToolDefinition<PositionInput> = {
  name: 'ts_goto_definition',
  description: 'Jump to the real definition of a symbol via the TypeScript compiler. Returns file:line:column. Read-only.',
  inputHint: '{ "path": "src/app.ts", "line": 3, "column": 12 }',
  risk: 'read',
  validate: validatePosition,
  async execute(input, context) {
    const defs = definitionAt(context.workspaceRoot, input.path, input.line, input.column);
    if (!defs.length) return { ok: true, output: '(no definition found)' };
    const out = defs.map((def) => `${def.path}:${def.range.line}:${def.range.column}`);
    return { ok: true, output: out.join('\n'), data: { definitions: out } };
  },
};

const tsExactReferencesTool: ToolDefinition<PositionInput> = {
  name: 'ts_exact_references',
  description: 'Type-aware exact references to a symbol (no comment/string false positives) via the TypeScript compiler. Read-only. Prefer over find_references when the language is TS/JS.',
  inputHint: '{ "path": "src/index.ts", "line": 10, "column": 5 }',
  risk: 'read',
  validate: validatePosition,
  async execute(input, context) {
    const refs = referencesAt(context.workspaceRoot, input.path, input.line, input.column);
    if (!refs.length) return { ok: true, output: '(no references found)' };
    const out = refs.map((ref) => {
      const kind = ref.isDefinition ? ' (definition)' : '';
      return `${ref.path}:${ref.range.line}${kind}: ${ref.lineText.slice(0, 120)}`;
    });
    return { ok: true, output: [`共 ${out.length} 处引用`, ...out].join('\n'), data: { count: out.length, references: out } };
  },
};

export { tsHoverTool, tsGotoDefinitionTool, tsExactReferencesTool };
