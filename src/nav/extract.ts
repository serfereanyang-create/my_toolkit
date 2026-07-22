import { detectNavLanguage } from './ignore.js';
import type { NavLanguage, SymbolKind, SymbolRecord } from './types.js';

const MAX_FILE_BYTES = 500_000;

export function extractSymbolsFromSource(path: string, source: string, language?: NavLanguage): SymbolRecord[] {
  if (Buffer.byteLength(source, 'utf8') > MAX_FILE_BYTES) return [];
  const lang = language ?? detectNavLanguage(path);
  if (lang === 'ts' || lang === 'js') return extractTsJs(path, source);
  if (lang === 'python') return extractPython(path, source);
  if (lang === 'go') return extractGo(path, source);
  if (lang === 'rust') return extractRust(path, source);
  if (lang === 'java' || lang === 'kotlin') return extractJvm(path, source, lang);
  return [];
}

function extractTsJs(path: string, source: string): SymbolRecord[] {
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

function extractPython(path: string, source: string): SymbolRecord[] {
  const lines = source.split(/\r?\n/);
  const symbols: SymbolRecord[] = [];
  let container: string | undefined;
  let containerIndent = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/)?.[0]?.length ?? 0;
    const line = raw.trim();

    if (container && indent <= containerIndent && !line.startsWith('@')) {
      container = undefined;
      containerIndent = -1;
    }

    const classMatch = line.match(/^class\s+([A-Za-z_][\w]*)\s*(\(|:)/);
    if (classMatch) {
      const name = classMatch[1]!;
      symbols.push(record(name, 'class', path, index + 1, true, undefined, line));
      container = name;
      containerIndent = indent;
      continue;
    }

    const defMatch = line.match(/^(async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/);
    if (defMatch) {
      const name = defMatch[2]!;
      const kind: SymbolKind = container && indent > containerIndent ? 'method' : 'function';
      symbols.push(record(name, kind, path, index + 1, !name.startsWith('_'), container, line));
    }
  }
  return dedupe(symbols);
}

function extractGo(path: string, source: string): SymbolRecord[] {
  const lines = source.split(/\r?\n/);
  const symbols: SymbolRecord[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = stripLineComment(lines[index] ?? '').trim();
    if (!line || line.startsWith('//') || line.startsWith('/*')) continue;

    const funcMatch = line.match(/^func\s+(\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*\(/);
    if (funcMatch) {
      const name = funcMatch[2]!;
      const receiver = Boolean(funcMatch[1]);
      symbols.push(record(name, receiver ? 'method' : 'function', path, index + 1, /^[A-Z]/.test(name), undefined, line));
      continue;
    }

    const typeMatch = line.match(/^type\s+([A-Za-z_][\w]*)\s+(struct|interface|[\w.]+)/);
    if (typeMatch) {
      const name = typeMatch[1]!;
      const kind: SymbolKind = typeMatch[2] === 'struct' ? 'struct' : typeMatch[2] === 'interface' ? 'interface' : 'type';
      symbols.push(record(name, kind, path, index + 1, /^[A-Z]/.test(name), undefined, line));
      continue;
    }

    const constMatch = line.match(/^const\s+([A-Za-z_][\w]*)\b/);
    if (constMatch) {
      const name = constMatch[1]!;
      symbols.push(record(name, 'const', path, index + 1, /^[A-Z]/.test(name), undefined, line));
      continue;
    }

    const varMatch = line.match(/^var\s+([A-Za-z_][\w]*)\b/);
    if (varMatch) {
      const name = varMatch[1]!;
      symbols.push(record(name, 'const', path, index + 1, /^[A-Z]/.test(name), undefined, line));
    }
  }
  return dedupe(symbols);
}

function extractRust(path: string, source: string): SymbolRecord[] {
  const lines = source.split(/\r?\n/);
  const symbols: SymbolRecord[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = stripLineComment(lines[index] ?? '').trim();
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('#')) continue;

    const pub = /^pub(\s*\([^)]*\))?\s+/.test(line);
    const body = line.replace(/^pub(\s*\([^)]*\))?\s+/, '');

    const fnMatch = body.match(/^(async\s+)?fn\s+([A-Za-z_][\w]*)\s*[<(]/);
    if (fnMatch) {
      symbols.push(record(fnMatch[2]!, 'function', path, index + 1, pub, undefined, line));
      continue;
    }

    const structMatch = body.match(/^struct\s+([A-Za-z_][\w]*)\b/);
    if (structMatch) {
      symbols.push(record(structMatch[1]!, 'struct', path, index + 1, pub, undefined, line));
      continue;
    }

    const enumMatch = body.match(/^enum\s+([A-Za-z_][\w]*)\b/);
    if (enumMatch) {
      symbols.push(record(enumMatch[1]!, 'enum', path, index + 1, pub, undefined, line));
      continue;
    }

    const traitMatch = body.match(/^trait\s+([A-Za-z_][\w]*)\b/);
    if (traitMatch) {
      symbols.push(record(traitMatch[1]!, 'trait', path, index + 1, pub, undefined, line));
      continue;
    }

    const modMatch = body.match(/^mod\s+([A-Za-z_][\w]*)\b/);
    if (modMatch) {
      symbols.push(record(modMatch[1]!, 'module', path, index + 1, pub, undefined, line));
      continue;
    }

    const typeMatch = body.match(/^type\s+([A-Za-z_][\w]*)\b/);
    if (typeMatch) {
      symbols.push(record(typeMatch[1]!, 'type', path, index + 1, pub, undefined, line));
      continue;
    }

    const implMatch = body.match(/^impl(?:\s*<[^>]+>)?\s+(?:([A-Za-z_][\w:]*)\s+for\s+)?([A-Za-z_][\w:]*)/);
    if (implMatch) {
      const name = (implMatch[2] ?? implMatch[1] ?? 'impl').split('::').pop()!;
      symbols.push(record(name, 'method', path, index + 1, false, undefined, line));
    }
  }
  return dedupe(symbols);
}

function extractJvm(path: string, source: string, language: 'java' | 'kotlin'): SymbolRecord[] {
  const lines = source.split(/\r?\n/);
  const symbols: SymbolRecord[] = [];
  let container: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = stripLineComment(lines[index] ?? '').trim();
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*') || line.startsWith('package ') || line.startsWith('import ')) continue;

    if (/^}/.test(line)) {
      container = undefined;
    }

    const classMatch = line.match(/^(public\s+|private\s+|protected\s+|internal\s+|open\s+|abstract\s+|data\s+|sealed\s+|final\s+)*class\s+([A-Za-z_][\w]*)/);
    if (classMatch) {
      const name = classMatch[2]!;
      symbols.push(record(name, 'class', path, index + 1, /public|internal|^class/.test(line), undefined, line));
      // Only treat as container when the body opens on this line; brace-less Kotlin decls stay top-level.
      container = line.includes('{') ? name : undefined;
      continue;
    }

    const interfaceMatch = line.match(/^(public\s+|private\s+|protected\s+|internal\s+)*interface\s+([A-Za-z_][\w]*)/);
    if (interfaceMatch) {
      const name = interfaceMatch[2]!;
      symbols.push(record(name, 'interface', path, index + 1, true, undefined, line));
      container = line.includes('{') ? name : undefined;
      continue;
    }

    const enumMatch = line.match(/^(public\s+|private\s+|protected\s+|internal\s+)*enum\s+(class\s+)?([A-Za-z_][\w]*)/);
    if (enumMatch) {
      symbols.push(record(enumMatch[3]!, 'enum', path, index + 1, true, undefined, line));
      continue;
    }

    if (language === 'kotlin') {
      const objectMatch = line.match(/^(public\s+|private\s+|internal\s+|data\s+)*object\s+([A-Za-z_][\w]*)/);
      if (objectMatch) {
        symbols.push(record(objectMatch[2]!, 'class', path, index + 1, true, undefined, line));
        container = line.includes('{') ? objectMatch[2] : undefined;
        continue;
      }
      const funMatch = line.match(/^(override\s+|private\s+|public\s+|internal\s+|protected\s+|open\s+|suspend\s+)*fun\s+([A-Za-z_][\w]*)\s*[<(]/);
      if (funMatch) {
        const name = funMatch[2]!;
        symbols.push(record(name, container ? 'method' : 'function', path, index + 1, !name.startsWith('_'), container, line));
        continue;
      }
    } else {
      const methodMatch = line.match(/^(public|private|protected|static|final|synchronized|native|abstract|default|\s)+[\w.<>,\[\]?]+\s+([A-Za-z_][\w]*)\s*\(/);
      if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'throw'].includes(methodMatch[2]!)) {
        const name = methodMatch[2]!;
        if (name !== container) {
          symbols.push(record(name, container ? 'method' : 'function', path, index + 1, /public/.test(line), container, line));
        }
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
