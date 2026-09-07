import { readFile } from 'node:fs/promises';
import { resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';
import { getByPath } from './dataFile.js';

function parseIniLike(text: string) {
  const result: Record<string, unknown> = {};
  let section: Record<string, unknown> = result;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[(.+?)\]$/);
    if (sectionMatch) {
      section = {};
      result[sectionMatch[1]!.trim()] = section;
      continue;
    }
    const eq = line.indexOf('=');
    const colon = line.indexOf(':');
    const splitAt = eq >= 0 && colon >= 0 ? Math.min(eq, colon) : Math.max(eq, colon);
    if (splitAt <= 0) continue;
    const key = line.slice(0, splitAt).trim();
    const value = line.slice(splitAt + 1).trim();
    section[key] = value;
  }
  return result;
}

function parseProperties(text: string) {
  const result: Record<string, string> = {};
  let pending = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = pending ? `${pending}${raw}` : raw;
    if (line.endsWith('\\')) {
      pending = line.slice(0, -1);
      continue;
    }
    pending = '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const match = trimmed.match(/^([^:=\s]+)\s*[:=]\s*(.*)$/);
    if (!match) continue;
    result[match[1]!] = match[2]!;
  }
  return result;
}

function parseTomlValue(value: string): unknown {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseTomlValue(item));
  }
  return trimmed;
}

function parseToml(text: string) {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[(.+?)\]$/);
    if (sectionMatch) {
      const parts = sectionMatch[1]!.split('.').map((part) => part.trim()).filter(Boolean);
      current = root;
      for (const part of parts) {
        const next = typeof current[part] === 'object' && current[part] !== null ? current[part] as Record<string, unknown> : {};
        current[part] = next;
        current = next;
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    current[key] = parseTomlValue(value);
  }
  return root;
}

async function loadText(contextRoot: string, path?: string, text?: string, maxBytes = 1_000_000) {
  if (path) {
    return (await readFile(resolveReadablePath(contextRoot, path), 'utf8')).slice(0, maxBytes);
  }
  return (text ?? '').slice(0, maxBytes);
}

function renderObjectSummary(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export const iniParseTool: ToolDefinition<{ path?: string; text?: string; query?: string; maxBytes: number }> = {
  name: 'ini_parse',
  description: 'Parse INI-style config files into objects. Supports sections and key=value pairs. Optional dot-path query drills into a section/key.',
  inputHint: '{ "path": "settings.ini", "query": "server.port" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    const text = typeof record.text === 'string' ? record.text : undefined;
    if (!path && !text) throw new Error('either path or text is required');
    const query = typeof record.query === 'string' && record.query.trim() ? record.query.trim() : undefined;
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 ? Math.min(Math.floor(record.maxBytes), 2_000_000) : 500_000;
    return { path, text, query, maxBytes };
  },
  async execute(input, context) {
    const parsed = parseIniLike(await loadText(context.workspaceRoot, input.path, input.text, input.maxBytes));
    if (input.query) {
      const found = getByPath(parsed, input.query);
      if (!found.ok) return { ok: false, output: `Path not found: ${input.query} (${found.reason})` };
      return { ok: true, output: renderObjectSummary(found.value), data: { query: input.query, value: found.value } };
    }
    return { ok: true, output: JSON.stringify(parsed, null, 2), data: parsed };
  },
};

export const propertiesParseTool: ToolDefinition<{ path?: string; text?: string; query?: string; maxBytes: number }> = {
  name: 'properties_parse',
  description: 'Parse Java .properties files into key/value objects. Supports continuation lines and optional key query.',
  inputHint: '{ "path": "app.properties", "query": "spring.datasource.url" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    const text = typeof record.text === 'string' ? record.text : undefined;
    if (!path && !text) throw new Error('either path or text is required');
    const query = typeof record.query === 'string' && record.query.trim() ? record.query.trim() : undefined;
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 ? Math.min(Math.floor(record.maxBytes), 2_000_000) : 500_000;
    return { path, text, query, maxBytes };
  },
  async execute(input, context) {
    const parsed = parseProperties(await loadText(context.workspaceRoot, input.path, input.text, input.maxBytes));
    if (input.query) {
      const value = parsed[input.query];
      if (value === undefined) return { ok: false, output: `Key not found: ${input.query}` };
      return { ok: true, output: value, data: { key: input.query, value } };
    }
    return { ok: true, output: JSON.stringify(parsed, null, 2), data: parsed };
  },
};

export const tomlParseTool: ToolDefinition<{ path?: string; text?: string; query?: string; maxBytes: number }> = {
  name: 'toml_parse',
  description: 'Parse TOML config into structured JSON. Supports dotted sections, booleans, numbers, strings, and simple arrays. Optional dot-path query supported.',
  inputHint: '{ "path": "pyproject.toml", "query": "tool.poetry.name" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    const text = typeof record.text === 'string' ? record.text : undefined;
    if (!path && !text) throw new Error('either path or text is required');
    const query = typeof record.query === 'string' && record.query.trim() ? record.query.trim() : undefined;
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 ? Math.min(Math.floor(record.maxBytes), 2_000_000) : 500_000;
    return { path, text, query, maxBytes };
  },
  async execute(input, context) {
    const parsed = parseToml(await loadText(context.workspaceRoot, input.path, input.text, input.maxBytes));
    if (input.query) {
      const found = getByPath(parsed, input.query);
      if (!found.ok) return { ok: false, output: `Path not found: ${input.query} (${found.reason})` };
      return { ok: true, output: renderObjectSummary(found.value), data: { query: input.query, value: found.value } };
    }
    return { ok: true, output: JSON.stringify(parsed, null, 2), data: parsed };
  },
};
