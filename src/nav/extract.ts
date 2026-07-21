import type { SymbolKind, SymbolRecord } from './types.js';

const MAX_FILE_BYTES = 500_000;

export function extractSymbolsFromSource(path: string, source: string): SymbolRecord[] {
  if (Buffer.byteLength(source, 'utf8') > MAX_FILE_BYTES) return [];

  const lines = source.split(/\r?\n/);
  const symbols: SymbolRecord[] = [];
  let container: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const line = stripLineComment(raw).trim();
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;

    if (/^}/.test(line) || /^};?$/.test(line)) {
      container = undefined;
    }

    const classMatch = line.match(/^(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_][\w]*)/);
    if (classMatch) {
      const name = classMatch[4]!;
      symbols.push(record(name, 'class', path, index + 1, Boolean(classMatch[1] || classMatch[2]), undefined, line));
      container = name;
      continue;
    }

    const interfaceMatch = line.match(/^(export\s+)?interface\s+([A-Za-z_][\w]*)/);
    if (interfaceMatch) {
      symbols.push(record(interfaceMatch[2]!, 'interface', path, index + 1, Boolean(interfaceMatch[1]), undefined, line));
      container = interfaceMatch[2];
      continue;
    }

    const typeMatch = line.match(/^(export\s+)?type\s+([A-Za-z_][\w]*)\s*=/);
    if (typeMatch) {
      symbols.push(record(typeMatch[2]!, 'type', path, index + 1, Boolean(typeMatch[1]), undefined, line));
      continue;
    }

    const enumMatch = line.match(/^(export\s+)?enum\s+([A-Za-z_][\w]*)/);
    if (enumMatch) {
      symbols.push(record(enumMatch[2]!, 'enum', path, index + 1, Boolean(enumMatch[1]), undefined, line));
      continue;
    }

    const fnMatch = line.match(/^(export\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_][\w]*)\s*\(/);
    if (fnMatch) {
      symbols.push(record(fnMatch[3]!, 'function', path, index + 1, Boolean(fnMatch[1]), undefined, line));
      continue;
    }

    const constFnMatch = line.match(/^(export\s+)?(const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*(async\s*)?(\([^)]*\)|[A-Za-z_][\w]*)\s*=>/);
    if (constFnMatch) {
      symbols.push(record(constFnMatch[3]!, 'function', path, index + 1, Boolean(constFnMatch[1]), undefined, line));
      continue;
    }

    const constMatch = line.match(/^(export\s+)?(const|let|var)\s+([A-Za-z_][\w]*)\b/);
    if (constMatch) {
      symbols.push(record(constMatch[3]!, 'const', path, index + 1, Boolean(constMatch[1]), undefined, line));
      continue;
    }

    const exportNamed = line.match(/^export\s+\{\s*([^}]+)\s*\}/);
    if (exportNamed) {
      for (const part of exportNamed[1]!.split(',')) {
        const name = part.trim().split(/\s+as\s+/i)[0]?.trim();
        if (name && /^[A-Za-z_][\w]*$/.test(name)) {
          symbols.push(record(name, 'export', path, index + 1, true, undefined, line));
        }
      }
      continue;
    }

    if (container) {
      const methodMatch = line.match(/^(async\s+)?([A-Za-z_][\w]*)\s*\([^;]*\)\s*\{/);
      if (methodMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(methodMatch[2]!)) {
        symbols.push(record(methodMatch[2]!, 'method', path, index + 1, false, container, line));
      }
    }
  }

  return dedupe(symbols);
}

function stripLineComment(line: string) {
  const index = line.indexOf('//');
  if (index < 0) return line;
  const before = line.slice(0, index);
  const quotes = (before.match(/['"`]/g) ?? []).length;
  if (quotes % 2 === 1) return line;
  return before;
}

function record(
  name: string,
  kind: SymbolKind,
  path: string,
  line: number,
  exported: boolean,
  container: string | undefined,
  signature: string,
): SymbolRecord {
  const symbol: SymbolRecord = {
    name,
    kind,
    path,
    line,
    exported,
    signature: signature.slice(0, 160),
  };
  if (container) symbol.container = container;
  return symbol;
}

function dedupe(symbols: SymbolRecord[]) {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.path}:${symbol.line}:${symbol.kind}:${symbol.name}:${symbol.container ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
