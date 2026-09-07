import { readFile } from 'node:fs/promises';
import { resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';
import { getByPath } from './dataFile.js';

/**
 * YAML tools (yaml_parse, yaml_stringify, yaml_query, yaml_keys).
 * 
 * Simple YAML parser supporting:
 * - Key-value pairs (key: value)
 * - Lists (- item)
 * - Nested objects (indentation)
 * - Strings, numbers, booleans, null
 * - Comments (#)
 */

type LineInfo = { indent: number; content: string; raw: string };

function parseYaml(text: string): unknown {
  const lines: LineInfo[] = text.split('\n').map(raw => {
    const commentIndex = raw.indexOf('#');
    const withoutComment = commentIndex >= 0 ? raw.slice(0, commentIndex) : raw;
    return {
      raw,
      indent: withoutComment.search(/\S/) >= 0 ? withoutComment.search(/\S/) : 0,
      content: withoutComment.trim(),
    };
  }).filter(line => line.content);

  const root: Record<string, unknown> = {};
  parseBlock(lines, 0, root, -1);
  return root;
}

function parseBlock(
  lines: LineInfo[],
  startIndex: number,
  target: Record<string, unknown> | unknown[],
  parentIndent: number
): number {
  let i = startIndex;
  
  while (i < lines.length) {
    const line = lines[i];
    
    // If indentation decreased or equal to parent, we're done with this block
    if (line.indent <= parentIndent) {
      break;
    }
    
    const content = line.content;
    
    // Handle list items
    if (content.startsWith('- ')) {
      if (!Array.isArray(target)) {
        i++;
        continue;
      }
      
      const itemContent = content.slice(2).trim();
      
      // Check if inline key:value
      const colonIndex = itemContent.indexOf(':');
      if (colonIndex > 0 && itemContent.slice(colonIndex + 1).trim()) {
        // Inline key:value like "- name: John"
        const key = itemContent.slice(0, colonIndex).trim();
        const value = parseValue(itemContent.slice(colonIndex + 1).trim());
        
        // Check if next lines belong to this object (greater indent, not a new list item)
        const obj: Record<string, unknown> = { [key]: value };
        target.push(obj);
        
        // Look ahead for additional properties
        let j = i + 1;
        while (j < lines.length) {
          const nextLine = lines[j];
          if (nextLine.indent <= line.indent) break;
          if (nextLine.content.startsWith('- ')) break;
          
          const nextColon = nextLine.content.indexOf(':');
          if (nextColon > 0) {
            const nextKey = nextLine.content.slice(0, nextColon).trim();
            const nextValue = parseValue(nextLine.content.slice(nextColon + 1).trim());
            obj[nextKey] = nextValue;
            j++;
          } else {
            break;
          }
        }
        i = j;
        continue;
      }
      
      // Simple scalar value
      target.push(parseValue(itemContent));
      i++;
      continue;
    }
    
    // Handle key:value pairs
    const colonIndex = content.indexOf(':');
    if (colonIndex > 0) {
      const key = content.slice(0, colonIndex).trim();
      const valuePart = content.slice(colonIndex + 1).trim();
      
      if (!valuePart) {
        // Check what comes next
        const nextLine = i + 1 < lines.length ? lines[i + 1] : null;
        
        if (nextLine && nextLine.indent > line.indent) {
          if (nextLine.content.startsWith('- ')) {
            // It's a list
            const list: unknown[] = [];
            (target as Record<string, unknown>)[key] = list;
            i = parseBlock(lines, i + 1, list, line.indent);
          } else {
            // It's a nested object
            const obj: Record<string, unknown> = {};
            (target as Record<string, unknown>)[key] = obj;
            i = parseBlock(lines, i + 1, obj, line.indent);
          }
        } else {
          // Empty value
          (target as Record<string, unknown>)[key] = null;
          i++;
        }
      } else {
        // Has value
        (target as Record<string, unknown>)[key] = parseValue(valuePart);
        i++;
      }
      continue;
    }
    
    i++;
  }
  
  return i;
}

function parseValue(str: string): unknown {
  if (!str) return null;
  
  // Boolean
  if (str === 'true') return true;
  if (str === 'false') return false;
  
  // Null
  if (str === 'null' || str === '~') return null;
  
  // Number
  if (/^-?\d+(\.\d+)?$/.test(str)) {
    const num = Number(str);
    if (!isNaN(num)) return num;
  }
  
  // String (remove quotes if present)
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  
  return str;
}

function stringifyYaml(obj: unknown, indent = 0): string {
  const spaces = '  '.repeat(indent);
  
  if (obj === null || obj === undefined) {
    return 'null';
  }
  
  if (typeof obj === 'boolean' || typeof obj === 'number') {
    return String(obj);
  }
  
  if (typeof obj === 'string') {
    // Quote strings with special characters
    if (/[:#\[\]{}|>@`]/.test(obj) || obj.includes('\n')) {
      return `"${obj.replace(/"/g, '\\"')}"`;
    }
    return obj;
  }
  
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map(item => {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        const entries = Object.entries(item);
        if (entries.length === 1) {
          // Single key-value: inline format
          const [k, v] = entries[0];
          return `${spaces}- ${k}: ${stringifyYaml(v, 0)}`;
        }
        // Multiple keys: multiline format
        const [firstKey, firstValue] = entries[0];
        let result = `${spaces}- ${firstKey}: ${stringifyYaml(firstValue, 0)}`;
        for (let i = 1; i < entries.length; i++) {
          const [k, v] = entries[i];
          result += `\n${spaces}  ${k}: ${stringifyYaml(v, 0)}`;
        }
        return result;
      }
      return `${spaces}- ${stringifyYaml(item, 0)}`;
    }).join('\n');
  }
  
  if (typeof obj === 'object') {
    const entries = Object.entries(obj);
    if (entries.length === 0) return '{}';
    
    return entries.map(([key, value]) => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const nested = stringifyYaml(value, indent + 1);
        return `${spaces}${key}:\n${nested}`;
      }
      if (Array.isArray(value)) {
        if (value.length === 0) {
          return `${spaces}${key}: []`;
        }
        const nested = stringifyYaml(value, indent + 1);
        return `${spaces}${key}:\n${nested}`;
      }
      return `${spaces}${key}: ${stringifyYaml(value, 0)}`;
    }).join('\n');
  }
  
  return String(obj);
}

export const yamlParseTool: ToolDefinition<{ yaml?: string; path?: string }> = {
  name: 'yaml_parse',
  description:
    'Parse YAML to JSON. Supports basic YAML syntax: key-value pairs, lists, nested objects, strings, numbers, booleans, null, and comments. Provide either inline YAML text or a file path.',
  inputHint: '{ "yaml": "name: John\\nage: 30\\nhobbies:\\n  - reading\\n  - coding" } or { "path": "config.yaml" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    if (typeof record.yaml === 'string') {
      return { yaml: record.yaml };
    }
    
    if (typeof record.path === 'string' && record.path.trim()) {
      return { path: record.path.trim() };
    }
    
    throw new Error('either yaml or path is required');
  },
  async execute(input, context) {
    let yamlText: string;
    let source: string;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path);
      yamlText = await readFile(target, 'utf8');
      source = input.path;
    } else {
      yamlText = input.yaml!;
      source = 'input';
    }
    
    try {
      const parsed = parseYaml(yamlText);
      const jsonText = JSON.stringify(parsed, null, 2);
      
      return {
        ok: true,
        output: `Parsed YAML from ${source}:\n${jsonText}`,
        data: {
          source,
          parsed,
          yamlBytes: yamlText.length,
        },
      };
    } catch (error) {
      return {
        ok: false,
        output: `Failed to parse YAML: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export const yamlStringifyTool: ToolDefinition<{ json: unknown; pretty?: boolean }> = {
  name: 'yaml_stringify',
  description:
    'Convert JSON to YAML format. Produces clean, indented YAML output. Input can be any JSON-serializable object.',
  inputHint: '{ "json": {"name": "John", "age": 30, "hobbies": ["reading", "coding"]} }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    if (record.json === undefined) {
      throw new Error('json field is required');
    }
    
    return {
      json: record.json,
      pretty: typeof record.pretty === 'boolean' ? record.pretty : true,
    };
  },
  async execute(input) {
    try {
      const yaml = stringifyYaml(input.json, 0);
      
      return {
        ok: true,
        output: `YAML output:\n${yaml}`,
        data: {
          yaml,
          yamlLength: yaml.length,
        },
      };
    } catch (error) {
      return {
        ok: false,
        output: `Failed to stringify to YAML: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export const yamlQueryTool: ToolDefinition<{
  path?: string;
  yaml?: string;
  query: string;
}> = {
  name: 'yaml_query',
  description:
    'Query a specific value from YAML using a dot-notation path (e.g., "server.port" or "users[0].name"). Provide either a file path or inline YAML text. Returns the value at the specified path.',
  inputHint: '{ "path": "config.yaml", "query": "database.host" } or { "yaml": "db:\\n  host: localhost", "query": "db.host" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    if (typeof record.query !== 'string' || !record.query.trim()) {
      throw new Error('query is required');
    }
    
    if (typeof record.yaml === 'string') {
      return { yaml: record.yaml, query: record.query.trim() };
    }
    
    if (typeof record.path === 'string' && record.path.trim()) {
      return { path: record.path.trim(), query: record.query.trim() };
    }
    
    throw new Error('either yaml or path is required');
  },
  async execute(input, context) {
    let yamlText: string;
    let source: string;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path);
      yamlText = await readFile(target, 'utf8');
      source = input.path;
    } else {
      yamlText = input.yaml!;
      source = 'inline YAML';
    }
    
    try {
      const parsed = parseYaml(yamlText);
      const value = getByPath(parsed, input.query);
      
      if (value === undefined) {
        return {
          ok: false,
          output: `Query path "${input.query}" not found in ${source}`,
        };
      }
      
      const valueStr = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
      
      return {
        ok: true,
        output: `Query "${input.query}" from ${source}:\n${valueStr}`,
        data: {
          source,
          query: input.query,
          value,
        },
      };
    } catch (error) {
      return {
        ok: false,
        output: `Failed to query YAML: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export const yamlKeysTool: ToolDefinition<{
  path?: string;
  yaml?: string;
  maxDepth?: number;
}> = {
  name: 'yaml_keys',
  description:
    'List all top-level keys in a YAML document. Optionally specify maxDepth to explore nested structure. Provide either a file path or inline YAML text.',
  inputHint: '{ "path": "config.yaml", "maxDepth": 2 } or { "yaml": "server:\\n  port: 8080" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    const maxDepth = typeof record.maxDepth === 'number' ? Math.max(1, Math.min(10, record.maxDepth)) : 1;
    
    if (typeof record.yaml === 'string') {
      return { yaml: record.yaml, maxDepth };
    }
    
    if (typeof record.path === 'string' && record.path.trim()) {
      return { path: record.path.trim(), maxDepth };
    }
    
    throw new Error('either yaml or path is required');
  },
  async execute(input, context) {
    let yamlText: string;
    let source: string;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path);
      yamlText = await readFile(target, 'utf8');
      source = input.path;
    } else {
      yamlText = input.yaml!;
      source = 'inline YAML';
    }
    
    try {
      const parsed = parseYaml(yamlText);
      
      function extractKeys(obj: unknown, depth: number, prefix = ''): string[] {
        if (depth > input.maxDepth!) return [];
        
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          const keys: string[] = [];
          for (const [key, value] of Object.entries(obj)) {
            const path = prefix ? `${prefix}.${key}` : key;
            keys.push(path);
            
            if (depth < input.maxDepth!) {
              keys.push(...extractKeys(value, depth + 1, path));
            }
          }
          return keys;
        }
        
        if (Array.isArray(obj) && depth < input.maxDepth!) {
          const keys: string[] = [];
          obj.forEach((item, idx) => {
            const path = `${prefix}[${idx}]`;
            keys.push(path);
            keys.push(...extractKeys(item, depth + 1, path));
          });
          return keys;
        }
        
        return [];
      }
      
      const keys = extractKeys(parsed, 1);
      
      if (keys.length === 0) {
        return {
          ok: true,
          output: `No keys found in ${source}`,
          data: { source, keys: [], maxDepth: input.maxDepth },
        };
      }
      
      const keyList = keys.map(k => `  ${k}`).join('\n');
      
      return {
        ok: true,
        output: `Keys in ${source} (maxDepth=${input.maxDepth}):\n${keyList}`,
        data: {
          source,
          keys,
          keyCount: keys.length,
          maxDepth: input.maxDepth,
        },
      };
    } catch (error) {
      return {
        ok: false,
        output: `Failed to extract keys from YAML: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
