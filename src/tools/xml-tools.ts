import { readFile } from 'node:fs/promises';
import { pathScopeFor, resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

function parseAttributes(raw: string) {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g)) {
    attrs[match[1]!] = decodeXml(match[3] ?? '');
  }
  return attrs;
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripXmlComments(xml: string) {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

function xmlToText(xml: string) {
  const withoutComments = stripXmlComments(xml);
  return decodeXml(withoutComments.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export const xmlToTextTool: ToolDefinition<{ xml?: string; path?: string; maxBytes: number }> = {
  name: 'xml_to_text',
  description: 'Convert XML into readable plain text by stripping tags and decoding entities. Useful for SVG, config XML, Office XML, and feed inspection.',
  inputHint: '{ "path": "config.xml" } or { "xml": "<root><title>Hello</title></root>" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    const xml = typeof record.xml === 'string' ? record.xml : undefined;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    if (!xml && !path) throw new Error('either xml or path is required');
    if (xml && path) throw new Error('provide either xml or path, not both');
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 ? Math.min(Math.floor(record.maxBytes), 5_000_000) : 1_000_000;
    return { xml, path, maxBytes };
  },
  async execute(input, context) {
    const xml = input.path
      ? (await readFile(resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval)), 'utf8')).slice(0, input.maxBytes)
      : input.xml!.slice(0, input.maxBytes);
    const text = xmlToText(xml);
    return {
      ok: true,
      output: text || '(empty XML text)',
      data: { source: input.path ?? 'inline XML', textLength: text.length },
    };
  },
};

export const xmlSummaryTool: ToolDefinition<{ xml?: string; path?: string; maxBytes: number }> = {
  name: 'xml_summary',
  description: 'Summarize XML structure: root element, element counts, attribute counts, and whether namespaces/CDATAs are present.',
  inputHint: '{ "path": "feed.xml" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    const xml = typeof record.xml === 'string' ? record.xml : undefined;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    if (!xml && !path) throw new Error('either xml or path is required');
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 ? Math.min(Math.floor(record.maxBytes), 5_000_000) : 1_000_000;
    return { xml, path, maxBytes };
  },
  async execute(input, context) {
    const xml = input.path
      ? (await readFile(resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval)), 'utf8')).slice(0, input.maxBytes)
      : input.xml!.slice(0, input.maxBytes);
    const cleaned = stripXmlComments(xml);
    const tagNames: string[] = [];
    let attributeCount = 0;
    for (const match of cleaned.matchAll(/<([A-Za-z_][\w:.-]*)([^>]*)>/g)) {
      const tag = match[1]!;
      if (tag.startsWith('?') || tag.startsWith('!') || tag.startsWith('/')) continue;
      tagNames.push(tag);
      attributeCount += Object.keys(parseAttributes(match[2] ?? '')).length;
    }
    const root = tagNames[0] ?? '(none)';
    const unique = [...new Set(tagNames)];
    const hasNamespaces = /xmlns(?::\w+)?=/.test(cleaned);
    const hasCdata = /<!\[CDATA\[/.test(cleaned);
    return {
      ok: true,
      output: [
        `Root: ${root}`,
        `Elements: ${tagNames.length}`,
        `Unique tags: ${unique.length}`,
        `Attributes: ${attributeCount}`,
        `Namespaces: ${hasNamespaces ? 'yes' : 'no'}`,
        `CDATA: ${hasCdata ? 'yes' : 'no'}`,
      ].join('\n'),
      data: { root, elementCount: tagNames.length, uniqueTags: unique, attributeCount, hasNamespaces, hasCdata },
    };
  },
};

export const xmlQueryTool: ToolDefinition<{ xml?: string; path?: string; tag: string; maxMatches: number; maxBytes: number }> = {
  name: 'xml_query',
  description: 'Find XML elements by tag name and return their attributes and text content. Lightweight lookup for feeds, config files, and document XML.',
  inputHint: '{ "path": "feed.xml", "tag": "item", "maxMatches": 20 }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    const xml = typeof record.xml === 'string' ? record.xml : undefined;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    if (!xml && !path) throw new Error('either xml or path is required');
    if (typeof record.tag !== 'string' || !record.tag.trim()) throw new Error('tag is required');
    const maxMatches = typeof record.maxMatches === 'number' ? Math.max(1, Math.min(100, Math.floor(record.maxMatches))) : 20;
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 ? Math.min(Math.floor(record.maxBytes), 5_000_000) : 1_000_000;
    return { xml, path, tag: record.tag.trim(), maxMatches, maxBytes };
  },
  async execute(input, context) {
    const xml = input.path
      ? (await readFile(resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval)), 'utf8')).slice(0, input.maxBytes)
      : input.xml!.slice(0, input.maxBytes);
    const escapedTag = input.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`<${escapedTag}([^>]*)>([\\s\\S]*?)<\\/${escapedTag}>`, 'g');
    const matches = [...xml.matchAll(pattern)].slice(0, input.maxMatches).map((match) => ({
      attributes: parseAttributes(match[1] ?? ''),
      text: xmlToText(match[2] ?? ''),
    }));
    return {
      ok: true,
      output: matches.length === 0
        ? `No <${input.tag}> elements found`
        : matches.map((item, index) => `${index + 1}. attrs=${JSON.stringify(item.attributes)} text=${item.text || '(empty)'}`).join('\n'),
      data: { tag: input.tag, count: matches.length, matches },
    };
  },
};
