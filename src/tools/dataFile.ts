import { readFile } from 'node:fs/promises';
import { resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

/**
 * JSON data file tools.
 * - read_json: Read and query JSON files with dot-path extraction
 * - json_keys: List all keys/fields in a JSON object or array elements
 * - json_type_summary: Get type information about JSON structure
 * - json_merge: Merge multiple JSON objects (shallow or deep)
 *
 * The path syntax is a simple dotted accessor with bracket indices, e.g.
 * "user.addresses[0].city" or "items[2]". No wildcards or filters — just a
 * deterministic drill-down so the model can pull one value out of a large file
 * without dumping the whole thing into context.
 */

export const readJsonTool: ToolDefinition<{ path: string; query?: string; maxBytes: number }> = {
  name: 'read_json',
  description: 'Read a JSON file and return it (pretty-printed). Optional `query` is a dot-path (e.g. "a.b[0].c") to extract just one value. Use to inspect config/data files or pull a single field out of a large JSON.',
  inputHint: '{ "path": "package.json", "query": "scripts.build" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.path !== 'string' || record.path.trim() === '') throw new Error('path is required');
    const query = typeof record.query === 'string' && record.query.trim() ? record.query.trim() : undefined;
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 ? Math.min(Math.floor(record.maxBytes), 5_000_000) : 1_000_000;
    return { path: record.path.trim(), query, maxBytes };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path);
    const raw = await readFile(target, 'utf8');
    if (raw.length > input.maxBytes) {
      return { ok: false, output: `JSON file too large (${raw.length} bytes > ${input.maxBytes}). Raise maxBytes to read it.`, data: { path: target, bytes: raw.length } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { ok: false, output: `Invalid JSON in ${input.path}: ${error instanceof Error ? error.message : String(error)}`, data: { path: target } };
    }
    if (input.query) {
      const found = getByPath(parsed, input.query);
      if (found.ok === false) {
        return { ok: false, output: `Path not found: ${input.query} (${found.reason})`, data: { path: target, query: input.query } };
      }
      return {
        ok: true,
        output: typeof found.value === 'string' ? found.value : JSON.stringify(found.value, null, 2),
        data: { path: target, query: input.query, value: found.value },
      };
    }
    return { ok: true, output: JSON.stringify(parsed, null, 2), data: { path: target } };
  },
};

// Resolve a dotted path with optional [index] segments against a parsed value.
export function getByPath(root: unknown, path: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const tokens = tokenizePath(path);
  let current: unknown = root;
  for (const token of tokens) {
    if (current === null || current === undefined) {
      return { ok: false, reason: `hit ${current} before segment "${token}"` };
    }
    if (typeof token === 'number') {
      if (!Array.isArray(current)) return { ok: false, reason: `"${token}" indexes a non-array` };
      current = current[token];
      continue;
    }
    if (typeof current !== 'object' || Array.isArray(current)) {
      return { ok: false, reason: `"${token}" accesses a non-object` };
    }
    if (!(token in (current as Record<string, unknown>))) {
      return { ok: false, reason: `key "${token}" missing` };
    }
    current = (current as Record<string, unknown>)[token];
  }
  return { ok: true, value: current };
}

// Split "a.b[0].c" into ['a','b',0,'c']. Bracket contents must be integers.
function tokenizePath(path: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  for (const part of path.split('.')) {
    if (part === '') continue;
    const match = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!match) {
      tokens.push(part);
      continue;
    }
    const key = match[1];
    // A pure-numeric dotted segment (e.g. "a.b.1") is treated as an array index,
    // so both "a.b[1]" and "a.b.1" work.
    if (key) {
      if (/^\d+$/.test(key)) tokens.push(Number(key));
      else tokens.push(key);
    }
    const brackets = match[2];
    for (const idx of brackets.matchAll(/\[(\d+)\]/g)) {
      tokens.push(Number(idx[1]));
    }
  }
  return tokens;
}

export const jsonKeysTool: ToolDefinition<{
  path?: string;
  json?: string;
  query?: string;
  maxDepth: number;
}> = {
  name: 'json_keys',
  description:
    'List all keys in a JSON object or array length/sample elements. Optional query to inspect a nested path. Use to understand JSON structure without dumping the entire content.',
  inputHint: '{ "path": "data.json", "query": "users", "maxDepth": 2 }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    if (typeof record.path !== 'string' && typeof record.json !== 'string') {
      throw new Error('either path or json is required');
    }
    
    const maxDepth = typeof record.maxDepth === 'number' ? Math.max(1, Math.min(10, record.maxDepth)) : 3;
    
    return {
      path: typeof record.path === 'string' ? record.path.trim() : undefined,
      json: typeof record.json === 'string' ? record.json : undefined,
      query: typeof record.query === 'string' && record.query.trim() ? record.query.trim() : undefined,
      maxDepth,
    };
  },
  async execute(input, context) {
    let parsed: unknown;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path);
      const raw = await readFile(target, 'utf8');
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        return { ok: false, output: `Invalid JSON in ${input.path}: ${error instanceof Error ? error.message : String(error)}` };
      }
    } else {
      try {
        parsed = JSON.parse(input.json!);
      } catch (error) {
        return { ok: false, output: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    
    if (input.query) {
      const found = getByPath(parsed, input.query);
      if (!found.ok) {
        return { ok: false, output: `Path not found: ${input.query} (${found.reason})` };
      }
      parsed = found.value;
    }
    
    const summary = summarizeKeys(parsed, input.maxDepth);
    const source = input.path || '(inline JSON)';
    const queryNote = input.query ? ` at ${input.query}` : '';
    
    return {
      ok: true,
      output: `Keys for ${source}${queryNote}:\n\n${summary}`,
      data: {
        source,
        query: input.query,
        structure: analyzeStructure(parsed),
      },
    };
  },
};

export const jsonTypeSummaryTool: ToolDefinition<{
  path?: string;
  json?: string;
  query?: string;
}> = {
  name: 'json_type_summary',
  description:
    'Analyze JSON structure and return type information: object/array/scalar, key count, array length, sample fields. Use to quickly understand data shape without full content.',
  inputHint: '{ "path": "config.json" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    if (typeof record.path !== 'string' && typeof record.json !== 'string') {
      throw new Error('either path or json is required');
    }
    
    return {
      path: typeof record.path === 'string' ? record.path.trim() : undefined,
      json: typeof record.json === 'string' ? record.json : undefined,
      query: typeof record.query === 'string' && record.query.trim() ? record.query.trim() : undefined,
    };
  },
  async execute(input, context) {
    let parsed: unknown;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path);
      const raw = await readFile(target, 'utf8');
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        return { ok: false, output: `Invalid JSON in ${input.path}: ${error instanceof Error ? error.message : String(error)}` };
      }
    } else {
      try {
        parsed = JSON.parse(input.json!);
      } catch (error) {
        return { ok: false, output: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    
    if (input.query) {
      const found = getByPath(parsed, input.query);
      if (!found.ok) {
        return { ok: false, output: `Path not found: ${input.query} (${found.reason})` };
      }
      parsed = found.value;
    }
    
    const structure = analyzeStructure(parsed);
    const source = input.path || '(inline JSON)';
    const queryNote = input.query ? ` at ${input.query}` : '';
    
    let details: string;
    if (structure.kind === 'object') {
      details = `Type: Object\nKeys: ${structure.keyCount}\nSample fields: ${structure.sampleKeys?.slice(0, 10).join(', ') || '(none)'}`;
    } else if (structure.kind === 'array') {
      details = `Type: Array\nLength: ${structure.length}\nElement types: ${structure.elementTypes?.join(', ') || 'mixed'}`;
    } else {
      details = `Type: ${structure.kind}\nValue: ${JSON.stringify(parsed)}`;
    }
    
    return {
      ok: true,
      output: `JSON type summary for ${source}${queryNote}:\n\n${details}`,
      data: {
        source,
        query: input.query,
        ...structure,
      },
    };
  },
};

export const jsonMergeTool: ToolDefinition<{
  sources: Array<{ path?: string; json?: string }>;
  deep?: boolean;
}> = {
  name: 'json_merge',
  description:
    'Merge multiple JSON objects into one. Shallow merge by default, or deep merge with deep=true. Returns the merged result. Use to combine config files or data sources.',
  inputHint: '{ "sources": [{ "path": "base.json" }, { "json": "{\\"override\\": true}" }], "deep": false }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    if (!Array.isArray(record.sources) || record.sources.length === 0) {
      throw new Error('sources must be a non-empty array');
    }
    
    const deep = record.deep === true;
    
    return {
      sources: record.sources as Array<{ path?: string; json?: string }>,
      deep,
    };
  },
  async execute(input, context) {
    const objects: unknown[] = [];
    
    for (const source of input.sources) {
      let parsed: unknown;
      
      if (source.path) {
        const target = resolveReadablePath(context.workspaceRoot, source.path);
        const raw = await readFile(target, 'utf8');
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          return { ok: false, output: `Invalid JSON in ${source.path}: ${error instanceof Error ? error.message : String(error)}` };
        }
      } else if (source.json) {
        try {
          parsed = JSON.parse(source.json);
        } catch (error) {
          return { ok: false, output: `Invalid JSON in source: ${error instanceof Error ? error.message : String(error)}` };
        }
      } else {
        continue;
      }
      
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, output: 'All sources must be JSON objects (not arrays or primitives)' };
      }
      
      objects.push(parsed);
    }
    
    const merged = input.deep ? deepMerge(...objects) : Object.assign({}, ...objects);
    
    return {
      ok: true,
      output: JSON.stringify(merged, null, 2),
      data: {
        merged,
        sourceCount: objects.length,
        mode: input.deep ? 'deep' : 'shallow',
      },
    };
  },
};

function summarizeKeys(value: unknown, maxDepth: number, currentDepth = 0): string {
  if (currentDepth >= maxDepth) return '(max depth reached)';
  
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const types = new Set(value.slice(0, 10).map(v => typeof v === 'object' && v !== null ? (Array.isArray(v) ? 'array' : 'object') : typeof v));
    return `Array[${value.length}] (${[...types].join(', ')})`;
  }
  
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    
    const lines = keys.slice(0, 20).map(key => {
      const val = (value as Record<string, unknown>)[key];
      const typeInfo = typeof val === 'object' && val !== null 
        ? (Array.isArray(val) ? `Array[${val.length}]` : `Object{${Object.keys(val).length}}`)
        : typeof val;
      return `  ${key}: ${typeInfo}`;
    });
    
    if (keys.length > 20) lines.push(`  ... (${keys.length - 20} more keys)`);
    return lines.join('\n');
  }
  
  return typeof value;
}

function analyzeStructure(value: unknown): {
  kind: string;
  keyCount?: number;
  sampleKeys?: string[];
  length?: number;
  elementTypes?: string[];
} {
  if (value === null) return { kind: 'null' };
  if (value === undefined) return { kind: 'undefined' };
  
  if (Array.isArray(value)) {
    const types = new Set(value.slice(0, 50).map(v => 
      typeof v === 'object' && v !== null ? (Array.isArray(v) ? 'array' : 'object') : typeof v
    ));
    return {
      kind: 'array',
      length: value.length,
      elementTypes: [...types],
    };
  }
  
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return {
      kind: 'object',
      keyCount: keys.length,
      sampleKeys: keys.slice(0, 20),
    };
  }
  
  return { kind: typeof value };
}

function deepMerge(...objects: unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  
  for (const obj of objects) {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) continue;
    
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value) && 
          typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])) {
        result[key] = deepMerge(result[key], value);
      } else {
        result[key] = value;
      }
    }
  }
  
  return result;
}
