import { readFile } from 'node:fs/promises';
import { resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

/**
 * Markdown tools (markdown_to_html, markdown_outline, markdown_links, markdown_code_blocks).
 * 
 * Supports:
 *   - Headers (# ## ###)
 *   - Bold (**text** or __text__)
 *   - Italic (*text* or _text_)
 *   - Links ([text](url))
 *   - Images (![alt](url))
 *   - Inline code (`code`)
 *   - Code blocks (```lang ... ```)
 *   - Lists (- or * or 1.)
 *   - Blockquotes (>)
 *   - Horizontal rules (--- or ***)
 *   - Line breaks (double space or backslash at end of line)
 * 
 * This is a lightweight parser — not full CommonMark compliance, but good
 * enough for most use cases and zero dependencies.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function processInline(text: string): string {
  // Images first (to avoid conflict with links)
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');
  
  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  
  // Inline code (protect from further processing)
  const codeBlocks: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_match, code) => {
    codeBlocks.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });
  
  // Bold (** or __)
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
  
  // Italic (* or _)
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/_(.+?)_/g, '<em>$1</em>');
  
  // Restore code blocks
  text = text.replace(/\x00CODE(\d+)\x00/g, (_match, index) => codeBlocks[parseInt(index, 10)]);
  
  return text;
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.split('\n');
  const html: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let inList = false;
  let listType = '';
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
    // Code blocks
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        html.push('</code></pre>');
        inCodeBlock = false;
        codeBlockLang = '';
      } else {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        const langAttr = codeBlockLang ? ` class="language-${escapeHtml(codeBlockLang)}"` : '';
        html.push(`<pre><code${langAttr}>`);
      }
      continue;
    }
    
    if (inCodeBlock) {
      html.push(escapeHtml(line));
      continue;
    }
    
    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      if (inList) {
        html.push(`</${listType}>`);
        inList = false;
      }
      const level = headerMatch[1].length;
      const text = processInline(headerMatch[2]);
      html.push(`<h${level}>${text}</h${level}>`);
      continue;
    }
    
    // Horizontal rule
    if (/^(\*\*\*+|---+|___+)\s*$/.test(line)) {
      if (inList) {
        html.push(`</${listType}>`);
        inList = false;
      }
      html.push('<hr />');
      continue;
    }
    
    // Blockquote
    if (line.startsWith('> ')) {
      if (inList) {
        html.push(`</${listType}>`);
        inList = false;
      }
      const text = processInline(line.slice(2));
      html.push(`<blockquote>${text}</blockquote>`);
      continue;
    }
    
    // Unordered list
    const ulMatch = line.match(/^[\*\-]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) html.push(`</${listType}>`);
        html.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      const text = processInline(ulMatch[1]);
      html.push(`<li>${text}</li>`);
      continue;
    }
    
    // Ordered list
    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) html.push(`</${listType}>`);
        html.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      const text = processInline(olMatch[1]);
      html.push(`<li>${text}</li>`);
      continue;
    }
    
    // Close list if we hit non-list content
    if (inList && line.trim()) {
      html.push(`</${listType}>`);
      inList = false;
    }
    
    // Empty line
    if (!line.trim()) {
      if (inList) {
        html.push(`</${listType}>`);
        inList = false;
      }
      html.push('');
      continue;
    }
    
    // Paragraph
    const text = processInline(line);
    html.push(`<p>${text}</p>`);
  }
  
  // Close any open blocks
  if (inCodeBlock) {
    html.push('</code></pre>');
  }
  if (inList) {
    html.push(`</${listType}>`);
  }
  
  return html.join('\n');
}

export const markdownToHtmlTool: ToolDefinition<{ markdown?: string; path?: string; maxBytes: number }> = {
  name: 'markdown_to_html',
  description:
    'Convert Markdown to HTML. Supports headers, bold, italic, links, images, code blocks, lists, blockquotes, and horizontal rules. Lightweight parser with zero dependencies. Accepts Markdown string directly or reads from a file path.',
  inputHint: '{ "markdown": "# Title\\n\\nHello **world**!" } or { "path": "desktop/README.md" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    const markdown = typeof record.markdown === 'string' ? record.markdown : undefined;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    
    if (!markdown && !path) throw new Error('either markdown or path is required');
    if (markdown && path) throw new Error('provide either markdown or path, not both');
    
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 
      ? Math.min(Math.floor(record.maxBytes), 10_000_000) 
      : 1_000_000;
    
    return { markdown, path, maxBytes };
  },
  async execute(input, context) {
    let markdown: string;
    let source: string;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path);
      const raw = await readFile(target, 'utf8');
      markdown = raw.slice(0, input.maxBytes);
      source = input.path;
    } else {
      markdown = input.markdown!.slice(0, input.maxBytes);
      source = 'input';
    }
    
    const html = markdownToHtml(markdown);
    const truncated = markdown.length >= input.maxBytes ? ' (truncated)' : '';
    
    return {
      ok: true,
      output: `${html}${truncated}`,
      data: { 
        source, 
        markdownBytes: markdown.length, 
        htmlLength: html.length,
        truncated: markdown.length >= input.maxBytes,
      },
    };
  },
};

export const markdownOutlineTool: ToolDefinition<{
  markdown?: string;
  path?: string;
  maxBytes?: number;
}> = {
  name: 'markdown_outline',
  description:
    'Extract heading outline from Markdown. Returns all headers with their level, text, and line number. Use to understand document structure.',
  inputHint: '{ "path": "README.md" } or { "markdown": "# Title\\n## Section" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    const markdown = typeof record.markdown === 'string' ? record.markdown : undefined;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    
    if (!markdown && !path) throw new Error('either markdown or path is required');
    
    const maxBytes = typeof record.maxBytes === 'number' ? Math.min(10_000_000, Math.max(1000, record.maxBytes)) : 1_000_000;
    
    return { markdown, path, maxBytes };
  },
  async execute(input, context) {
    let markdown: string;
    let source: string;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path);
      const raw = await readFile(target, 'utf8');
      markdown = raw.slice(0, input.maxBytes!);
      source = input.path;
    } else {
      markdown = input.markdown!.slice(0, input.maxBytes!);
      source = 'inline markdown';
    }
    
    const lines = markdown.split('\n');
    const headings: Array<{ level: number; text: string; line: number }> = [];
    
    let inCodeBlock = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      
      if (inCodeBlock) continue;
      
      const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headerMatch) {
        headings.push({
          level: headerMatch[1].length,
          text: headerMatch[2].trim(),
          line: i + 1,
        });
      }
    }
    
    if (headings.length === 0) {
      return {
        ok: true,
        output: `No headings found in ${source}`,
        data: { source, headings: [] },
      };
    }
    
    const outline = headings
      .map(h => `${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text} (line ${h.line})`)
      .join('\n');
    
    return {
      ok: true,
      output: `Outline of ${source}:\n\n${outline}`,
      data: {
        source,
        headings,
        headingCount: headings.length,
      },
    };
  },
};

export const markdownLinksTool: ToolDefinition<{
  markdown?: string;
  path?: string;
  includeImages?: boolean;
  maxBytes?: number;
}> = {
  name: 'markdown_links',
  description:
    'Extract all links and optionally images from Markdown. Returns link text, URL, type (link/image), and line number. Use to audit external references or build a link index.',
  inputHint: '{ "path": "README.md", "includeImages": true }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    const markdown = typeof record.markdown === 'string' ? record.markdown : undefined;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    
    if (!markdown && !path) throw new Error('either markdown or path is required');
    
    const includeImages = record.includeImages === true;
    const maxBytes = typeof record.maxBytes === 'number' ? Math.min(10_000_000, Math.max(1000, record.maxBytes)) : 1_000_000;
    
    return { markdown, path, includeImages, maxBytes };
  },
  async execute(input, context) {
    let markdown: string;
    let source: string;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path);
      const raw = await readFile(target, 'utf8');
      markdown = raw.slice(0, input.maxBytes!);
      source = input.path;
    } else {
      markdown = input.markdown!.slice(0, input.maxBytes!);
      source = 'inline markdown';
    }
    
    const lines = markdown.split('\n');
    const links: Array<{ text: string; url: string; type: 'link' | 'image'; line: number }> = [];
    
    let inCodeBlock = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      
      if (inCodeBlock) continue;
      
      if (input.includeImages) {
        const imagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
        for (const match of line.matchAll(imagePattern)) {
          links.push({
            text: match[1],
            url: match[2],
            type: 'image',
            line: i + 1,
          });
        }
      }
      
      const linkPattern = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
      for (const match of line.matchAll(linkPattern)) {
        links.push({
          text: match[1],
          url: match[2],
          type: 'link',
          line: i + 1,
        });
      }
    }
    
    if (links.length === 0) {
      return {
        ok: true,
        output: `No ${input.includeImages ? 'links or images' : 'links'} found in ${source}`,
        data: { source, links: [], count: 0 },
      };
    }
    
    const linkList = links
      .map(l => `  [${l.type}] ${l.text || '(no text)'} → ${l.url} (line ${l.line})`)
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

export const markdownCodeBlocksTool: ToolDefinition<{
  markdown?: string;
  path?: string;
  maxBytes?: number;
}> = {
  name: 'markdown_code_blocks',
  description:
    'Extract all fenced code blocks from Markdown. Returns language, content, and line number for each block. Use to extract code examples or analyze code snippets in documentation.',
  inputHint: '{ "path": "README.md" } or { "markdown": "```js\\nconsole.log(1);\\n```" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    const markdown = typeof record.markdown === 'string' ? record.markdown : undefined;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    
    if (!markdown && !path) throw new Error('either markdown or path is required');
    
    const maxBytes = typeof record.maxBytes === 'number' ? Math.min(10_000_000, Math.max(1000, record.maxBytes)) : 1_000_000;
    
    return { markdown, path, maxBytes };
  },
  async execute(input, context) {
    let markdown: string;
    let source: string;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path);
      const raw = await readFile(target, 'utf8');
      markdown = raw.slice(0, input.maxBytes!);
      source = input.path;
    } else {
      markdown = input.markdown!.slice(0, input.maxBytes!);
      source = 'inline markdown';
    }
    
    const lines = markdown.split('\n');
    const codeBlocks: Array<{ language: string; content: string; lineStart: number; lineEnd: number }> = [];
    
    let inCodeBlock = false;
    let currentLang = '';
    let currentContent: string[] = [];
    let blockStart = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          codeBlocks.push({
            language: currentLang || 'plain',
            content: currentContent.join('\n'),
            lineStart: blockStart,
            lineEnd: i + 1,
          });
          inCodeBlock = false;
          currentContent = [];
          currentLang = '';
        } else {
          inCodeBlock = true;
          currentLang = line.slice(3).trim();
          blockStart = i + 1;
        }
        continue;
      }
      
      if (inCodeBlock) {
        currentContent.push(line);
      }
    }
    
    if (codeBlocks.length === 0) {
      return {
        ok: true,
        output: `No code blocks found in ${source}`,
        data: { source, codeBlocks: [], count: 0 },
      };
    }
    
    const summary = codeBlocks
      .map((block, idx) => `  Block ${idx + 1}: ${block.language} (lines ${block.lineStart}-${block.lineEnd}, ${block.content.split('\n').length} lines)`)
      .join('\n');
    
    return {
      ok: true,
      output: `Code blocks in ${source}:\n\n${summary}`,
      data: {
        source,
        codeBlocks,
        count: codeBlocks.length,
      },
    };
  },
};
