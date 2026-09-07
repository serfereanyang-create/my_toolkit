import { readFile } from 'node:fs/promises';
import { resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';
import { htmlToText } from './web.js';

/**
 * HTML tools (html_to_text, html_links, html_metadata, html_headings).
 * 
 * Removes scripts, styles, and tags while preserving structure (block elements
 * become newlines). Decodes HTML entities. Can read from a file or accept
 * direct HTML input.
 */

export const htmlToTextTool: ToolDefinition<{ html?: string; path?: string; maxBytes: number }> = {
  name: 'html_to_text',
  description:
    'Convert HTML to readable plain text. Removes scripts, styles, and tags while preserving document structure (paragraphs, lists). Decodes HTML entities. Accepts HTML string directly or reads from a file path.',
  inputHint: '{ "html": "<p>Hello <b>world</b></p>" } or { "path": "desktop/page.html" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    const html = typeof record.html === 'string' ? record.html : undefined;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    
    if (!html && !path) throw new Error('either html or path is required');
    if (html && path) throw new Error('provide either html or path, not both');
    
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 
      ? Math.min(Math.floor(record.maxBytes), 10_000_000) 
      : 1_000_000;
    
    return { html, path, maxBytes };
  },
  async execute(input, context) {
    let html: string;
    let source: string;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path);
      const raw = await readFile(target, 'utf8');
      html = raw.slice(0, input.maxBytes);
      source = input.path;
    } else {
      html = input.html!.slice(0, input.maxBytes);
      source = 'input';
    }
    
    const text = htmlToText(html);
    const truncated = html.length >= input.maxBytes ? ' (truncated)' : '';
    
    return {
      ok: true,
      output: `${text}${truncated}`,
      data: { 
        source, 
        originalBytes: html.length, 
        textLength: text.length,
        truncated: html.length >= input.maxBytes,
      },
    };
  },
};

export const htmlLinksTool: ToolDefinition<{
  html?: string;
  path?: string;
  baseUrl?: string;
  maxBytes?: number;
}> = {
  name: 'html_links',
  description:
    'Extract all links from HTML. Returns href, link text, and optional resolved absolute URL. Use to audit external references, build site maps, or check broken links.',
  inputHint: '{ "path": "page.html", "baseUrl": "https://example.com" } or { "html": "<a href=\\"/about\\">About</a>" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    const html = typeof record.html === 'string' ? record.html : undefined;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    
    if (!html && !path) throw new Error('either html or path is required');
    
    const baseUrl = typeof record.baseUrl === 'string' && record.baseUrl.trim() ? record.baseUrl.trim() : undefined;
    const maxBytes = typeof record.maxBytes === 'number' ? Math.min(10_000_000, Math.max(1000, record.maxBytes)) : 1_000_000;
    
    return { html, path, baseUrl, maxBytes };
  },
  async execute(input, context) {
    let html: string;
    let source: string;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path);
      const raw = await readFile(target, 'utf8');
      html = raw.slice(0, input.maxBytes!);
      source = input.path;
    } else {
      html = input.html!.slice(0, input.maxBytes!);
      source = 'inline HTML';
    }
    
    const linkPattern = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
    const links: Array<{ href: string; text: string; absolute?: string }> = [];
    
    for (const match of html.matchAll(linkPattern)) {
      const href = match[1];
      const rawText = match[2];
      const text = rawText.replace(/<[^>]+>/g, '').trim();
      
      let absolute: string | undefined;
      if (input.baseUrl) {
        try {
          absolute = new URL(href, input.baseUrl).href;
        } catch {
          absolute = undefined;
        }
      }
      
      links.push({ href, text, absolute });
    }
    
    if (links.length === 0) {
      return {
        ok: true,
        output: `No links found in ${source}`,
        data: { source, links: [], count: 0 },
      };
    }
    
    const linkList = links
      .map(l => `  ${l.href} — ${l.text || '(no text)'}${l.absolute ? ` → ${l.absolute}` : ''}`)
      .join('\n');
    
    return {
      ok: true,
      output: `Links in ${source}:\n\n${linkList}`,
      data: {
        source,
        links,
        count: links.length,
      },
    };
  },
};

export const htmlMetadataTool: ToolDefinition<{
  html?: string;
  path?: string;
  maxBytes?: number;
}> = {
  name: 'html_metadata',
  description:
    'Extract metadata from HTML: title, description, canonical URL, Open Graph tags. Use to understand page SEO and social sharing metadata.',
  inputHint: '{ "path": "page.html" } or { "html": "<title>My Page</title>" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    const html = typeof record.html === 'string' ? record.html : undefined;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    
    if (!html && !path) throw new Error('either html or path is required');
    
    const maxBytes = typeof record.maxBytes === 'number' ? Math.min(10_000_000, Math.max(1000, record.maxBytes)) : 1_000_000;
    
    return { html, path, maxBytes };
  },
  async execute(input, context) {
    let html: string;
    let source: string;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path);
      const raw = await readFile(target, 'utf8');
      html = raw.slice(0, input.maxBytes!);
      source = input.path;
    } else {
      html = input.html!.slice(0, input.maxBytes!);
      source = 'inline HTML';
    }
    
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : undefined;
    
    const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    const description = descMatch ? descMatch[1] : undefined;
    
    const canonicalMatch = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i);
    const canonical = canonicalMatch ? canonicalMatch[1] : undefined;
    
    const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
    const ogTitle = ogTitleMatch ? ogTitleMatch[1] : undefined;
    
    const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
    const ogDescription = ogDescMatch ? ogDescMatch[1] : undefined;
    
    const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
    const ogImage = ogImageMatch ? ogImageMatch[1] : undefined;
    
    const metadata = {
      title,
      description,
      canonical,
      openGraph: {
        title: ogTitle,
        description: ogDescription,
        image: ogImage,
      },
    };
    
    const summary = [
      title ? `Title: ${title}` : undefined,
      description ? `Description: ${description}` : undefined,
      canonical ? `Canonical: ${canonical}` : undefined,
      ogTitle ? `OG Title: ${ogTitle}` : undefined,
      ogDescription ? `OG Description: ${ogDescription}` : undefined,
      ogImage ? `OG Image: ${ogImage}` : undefined,
    ].filter(Boolean).join('\n');
    
    return {
      ok: true,
      output: summary || `No metadata found in ${source}`,
      data: {
        source,
        ...metadata,
      },
    };
  },
};

export const htmlHeadingsTool: ToolDefinition<{
  html?: string;
  path?: string;
  maxBytes?: number;
}> = {
  name: 'html_headings',
  description:
    'Extract all headings (h1-h6) from HTML. Returns level, text content, and position. Use to understand document structure or build a table of contents.',
  inputHint: '{ "path": "page.html" } or { "html": "<h1>Title</h1><h2>Section</h2>" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    const html = typeof record.html === 'string' ? record.html : undefined;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    
    if (!html && !path) throw new Error('either html or path is required');
    
    const maxBytes = typeof record.maxBytes === 'number' ? Math.min(10_000_000, Math.max(1000, record.maxBytes)) : 1_000_000;
    
    return { html, path, maxBytes };
  },
  async execute(input, context) {
    let html: string;
    let source: string;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path);
      const raw = await readFile(target, 'utf8');
      html = raw.slice(0, input.maxBytes!);
      source = input.path;
    } else {
      html = input.html!.slice(0, input.maxBytes!);
      source = 'inline HTML';
    }
    
    const headingPattern = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi;
    const headings: Array<{ level: number; text: string }> = [];
    
    for (const match of html.matchAll(headingPattern)) {
      const level = parseInt(match[1], 10);
      const rawText = match[2];
      const text = rawText.replace(/<[^>]+>/g, '').trim();
      
      headings.push({ level, text });
    }
    
    if (headings.length === 0) {
      return {
        ok: true,
        output: `No headings found in ${source}`,
        data: { source, headings: [], count: 0 },
      };
    }
    
    const outline = headings
      .map(h => `${'  '.repeat(h.level - 1)}h${h.level}: ${h.text}`)
      .join('\n');
    
    return {
      ok: true,
      output: `Headings in ${source}:\n\n${outline}`,
      data: {
        source,
        headings,
        count: headings.length,
      },
    };
  },
};
