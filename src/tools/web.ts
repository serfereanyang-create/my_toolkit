import { writeFile } from 'node:fs/promises';
import { pathScopeFor, resolveWorkspacePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

/**
 * Network tools (fetch_url, download_file, http_post, parse_url, extract_page_links).
 *
 * Safety model (enforced together with the network approval policy in
 * src/safety/policy.ts, which gates these tools by host allowlist + SSRF guard):
 *   - GET only for fetch/download. POST for http_post with limited content-types.
 *   - 30s timeout via AbortController.
 *   - Response body capped at 5 MB for fetch_url, 50 MB for download_file.
 *   - Only textual content-types are read by fetch_url; binary responses are refused.
 *   - Redirects are NOT followed automatically. A 3xx returns its Location so
 *     the model must call the tool again with the new URL — this re-runs the
 *     allowlist/SSRF check on every hop and closes the redirect-bypass hole.
 *   - parse_url and extract_page_links are pure text processing, no network risk.
 *
 * The host allow/deny decision does not live here; the registry passes the
 * validated `url` and the context's networkAllowlist to decideApproval before
 * execute() ever runs. By the time we get here the host is already permitted.
 */

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const TIMEOUT_MS = 30_000;

export const fetchUrlTool: ToolDefinition<{ url: string }> = {
  name: 'fetch_url',
  description:
    'Fetch a web page or API over HTTP(S) GET and return its text (HTML is reduced to readable plain text). Use for looking up documentation, articles, or JSON APIs. Only hosts on the configured network allowlist are reachable; redirects are returned rather than followed (call again with the new URL).',
  inputHint: '{ "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP" }',
  risk: 'network',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.url !== 'string' || record.url.trim() === '') throw new Error('url is required');
    return { url: record.url.trim() };
  },
  async execute(input) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(input.url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5' },
      });

      // Manual redirect handling: surface the destination so the model re-fetches
      // (and the new host is re-checked against the allowlist).
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location') ?? '';
        return {
          ok: true,
          output: location
            ? `HTTP ${response.status} redirect to: ${location}\nCall fetch_url again with this URL if you want to follow it.`
            : `HTTP ${response.status} redirect with no Location header.`,
          data: { url: input.url, status: response.status, redirectTo: location || undefined },
        };
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!response.ok) {
        return {
          ok: false,
          output: `HTTP ${response.status} ${response.statusText} for ${input.url}`,
          data: { url: input.url, status: response.status, contentType },
        };
      }

      if (!isTextualContentType(contentType)) {
        return {
          ok: false,
          output: `Refusing to read non-text content (${contentType || 'unknown'}) from ${input.url}. fetch_url only returns text/HTML/JSON.`,
          data: { url: input.url, status: response.status, contentType },
        };
      }

      const raw = await readCapped(response, MAX_BYTES);
      const isHtml = contentType.includes('html') || /^\s*<(!doctype|html)/i.test(raw);
      const text = isHtml ? htmlToText(raw) : raw;
      const truncatedNote = raw.length >= MAX_BYTES ? '\n\n[truncated at 5MB]' : '';
      return {
        ok: true,
        output: `${text}${truncatedNote}`,
        data: {
          url: input.url,
          status: response.status,
          contentType,
          bytes: Buffer.byteLength(raw),
          kind: isHtml ? 'html' : 'text',
        },
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        output: aborted
          ? `Request timed out after ${TIMEOUT_MS / 1000}s: ${input.url}`
          : `Fetch failed for ${input.url}: ${error instanceof Error ? error.message : String(error)}`,
        data: { url: input.url },
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

function isTextualContentType(contentType: string): boolean {
  if (!contentType) return true; // servers that omit it — attempt as text, still capped
  return (
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('xml') ||
    contentType.includes('javascript') ||
    contentType.includes('html')
  );
}

// Read the response body up to `maxBytes`, aborting once the cap is reached so
// a huge page can't exhaust memory. Returns decoded UTF-8 text.
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return await response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= maxBytes) break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best effort
    }
  }
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)), Math.min(total, maxBytes + 8));
  return buffer.toString('utf8');
}

// Reduce HTML to readable plain text: drop script/style/head noise, convert
// block-level tags to newlines, strip remaining tags, and decode common
// entities. Not a full parser — deliberately dependency-free and good enough to
// give the model the article text.
export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<head\b[\s\S]*?<\/head>/gi, ' ');
  // Block elements → newline so structure survives.
  text = text.replace(/<\/(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|br|blockquote|pre)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  // Drop all remaining tags.
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  // Collapse whitespace runs but keep paragraph breaks.
  text = text.replace(/[ \t\f\v]+/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
    '&copy;': '©',
    '&reg;': '®',
  };
  let out = text.replace(/&[a-z]+;|&#39;/gi, (match) => named[match.toLowerCase()] ?? match);
  out = out.replace(/&#(\d+);/g, (_m, code) => {
    const n = Number(code);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _m;
  });
  out = out.replace(/&#x([0-9a-f]+);/gi, (_m, code) => {
    const n = parseInt(code, 16);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _m;
  });
  return out;
}

export const downloadFileTool: ToolDefinition<{
  url: string;
  to: string;
  maxBytes: number;
}> = {
  name: 'download_file',
  description:
    'Download a file from a URL and save it to the workspace. Supports binary and text files up to 50MB. Returns saved path and file size.',
  inputHint: '{ "url": "https://example.com/data.json", "to": "downloads/data.json" }',
  risk: 'network',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    if (typeof record.url !== 'string' || !record.url.trim()) throw new Error('url is required');
    if (typeof record.to !== 'string' || !record.to.trim()) throw new Error('to path is required');
    
    const maxBytes = typeof record.maxBytes === 'number' 
      ? Math.max(1024, Math.min(50 * 1024 * 1024, record.maxBytes)) 
      : 50 * 1024 * 1024;
    
    return {
      url: record.url.trim(),
      to: record.to.trim(),
      maxBytes,
    };
  },
  async execute(input, context) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    
    try {
      const response = await fetch(input.url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location') ?? '';
        return {
          ok: true,
          output: location
            ? `HTTP ${response.status} redirect to: ${location}\nCall download_file again with this URL to follow it.`
            : `HTTP ${response.status} redirect with no Location header.`,
          data: { url: input.url, status: response.status, redirectTo: location || undefined },
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          output: `HTTP ${response.status} ${response.statusText} for ${input.url}`,
        };
      }

      const buffer = await readCappedBinary(response, input.maxBytes);
      const targetPath = resolveWorkspacePath(context.workspaceRoot, input.to, pathScopeFor(context.approval));
      const checkpoint = await context.checkpoints?.beforeWrite(targetPath);
      
      await writeFile(targetPath, buffer);
      await context.checkpoints?.confirm(checkpoint);

      return {
        ok: true,
        output: `Downloaded ${buffer.length} bytes from ${input.url}\nSaved to: ${input.to}`,
        data: {
          url: input.url,
          path: input.to,
          bytes: buffer.length,
          checkpointId: checkpoint?.id,
        },
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        output: aborted
          ? `Request timed out after ${TIMEOUT_MS / 1000}s: ${input.url}`
          : `Download failed for ${input.url}: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

export const httpPostTool: ToolDefinition<{
  url: string;
  body: string;
  contentType?: string;
}> = {
  name: 'http_post',
  description:
    'Send an HTTP POST request with a JSON or text body. Returns the response text. Limited to allowed hosts.',
  inputHint: '{ "url": "https://api.example.com/data", "body": "{\\"key\\": \\"value\\"}", "contentType": "application/json" }',
  risk: 'network',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    if (typeof record.url !== 'string' || !record.url.trim()) throw new Error('url is required');
    if (typeof record.body !== 'string') throw new Error('body must be a string');
    
    const contentType = typeof record.contentType === 'string' 
      ? record.contentType.trim() 
      : 'application/json';
    
    return {
      url: record.url.trim(),
      body: record.body,
      contentType,
    };
  },
  async execute(input) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    
    try {
      const response = await fetch(input.url, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'content-type': input.contentType,
        },
        body: input.body,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location') ?? '';
        return {
          ok: true,
          output: location
            ? `HTTP ${response.status} redirect to: ${location}`
            : `HTTP ${response.status} redirect with no Location header.`,
          data: { url: input.url, status: response.status, redirectTo: location || undefined },
        };
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      
      if (!response.ok) {
        return {
          ok: false,
          output: `HTTP ${response.status} ${response.statusText} for ${input.url}`,
          data: { url: input.url, status: response.status },
        };
      }

      const raw = await readCapped(response, MAX_BYTES);
      const truncatedNote = raw.length >= MAX_BYTES ? '\n\n[truncated at 5MB]' : '';

      return {
        ok: true,
        output: `HTTP ${response.status}\nContent-Type: ${contentType}\n\n${raw}${truncatedNote}`,
        data: {
          url: input.url,
          status: response.status,
          contentType,
          bytes: Buffer.byteLength(raw),
        },
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        output: aborted
          ? `Request timed out after ${TIMEOUT_MS / 1000}s: ${input.url}`
          : `POST failed for ${input.url}: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

export const parseUrlTool: ToolDefinition<{ url: string }> = {
  name: 'parse_url',
  description:
    'Parse a URL into components: protocol, host, port, pathname, query parameters, hash. Pure text processing, no network request.',
  inputHint: '{ "url": "https://example.com:8080/path?key=value#section" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    if (typeof record.url !== 'string' || !record.url.trim()) throw new Error('url is required');
    
    return { url: record.url.trim() };
  },
  async execute(input) {
    try {
      const parsed = new URL(input.url);
      const params = Object.fromEntries(parsed.searchParams.entries());
      
      return {
        ok: true,
        output: `URL: ${input.url}\n\nProtocol: ${parsed.protocol}\nHost: ${parsed.hostname}\nPort: ${parsed.port || '(default)'}\nPath: ${parsed.pathname}\nQuery: ${parsed.search || '(none)'}\nHash: ${parsed.hash || '(none)'}`,
        data: {
          url: input.url,
          protocol: parsed.protocol.replace(':', ''),
          hostname: parsed.hostname,
          port: parsed.port || null,
          pathname: parsed.pathname,
          search: parsed.search,
          hash: parsed.hash,
          params,
        },
      };
    } catch (error) {
      return {
        ok: false,
        output: `Invalid URL: ${input.url}\n${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export const extractPageLinksTool: ToolDefinition<{
  html: string;
  baseUrl?: string;
}> = {
  name: 'extract_page_links',
  description:
    'Extract all links from an HTML string. Returns URL and anchor text for each link. Optionally resolve relative URLs against a base URL. Pure text processing, no network request.',
  inputHint: '{ "html": "<a href=\\"/page\\">Link</a>", "baseUrl": "https://example.com" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    if (typeof record.html !== 'string') throw new Error('html is required');
    
    return {
      html: record.html,
      baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl.trim() : undefined,
    };
  },
  async execute(input) {
    const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const links: Array<{ url: string; text: string }> = [];
    
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(input.html)) !== null) {
      let url = match[1].trim();
      const rawText = match[2];
      const text = htmlToText(rawText).trim() || '(no text)';
      
      if (input.baseUrl && url && !url.startsWith('http://') && !url.startsWith('https://')) {
        try {
          url = new URL(url, input.baseUrl).href;
        } catch {
          // Keep original if resolution fails
        }
      }
      
      links.push({ url, text });
    }

    const listing = links.length > 0
      ? links.map((link, i) => `${i + 1}. ${link.text}\n   ${link.url}`).join('\n\n')
      : '(no links found)';

    return {
      ok: true,
      output: `Found ${links.length} link${links.length === 1 ? '' : 's'}:\n\n${listing}`,
      data: {
        count: links.length,
        links,
        baseUrl: input.baseUrl,
      },
    };
  },
};

async function readCappedBinary(response: Response, maxBytes: number): Promise<Buffer> {
  const body = response.body;
  if (!body) {
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= maxBytes) break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best effort
    }
  }
  
  return Buffer.concat(chunks.map((c) => Buffer.from(c)), Math.min(total, maxBytes));
}
