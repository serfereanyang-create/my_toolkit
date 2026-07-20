import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const instructionFiles = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'README.md'];
const maxFileBytes = 4000;
const maxContextBytes = 12000;
const cache = new Map<string, ProjectContext>();

export type ProjectContext = {
  text: string;
  cacheKey: string;
  files: Array<{ path: string; mtimeMs: number; size: number }>;
};

export async function readProjectContext(workspaceRoot: string): Promise<ProjectContext | undefined> {
  const files = await projectInstructionStats(workspaceRoot);
  const cacheKey = hashSignature(files);
  const cached = cache.get(workspaceRoot);
  if (cached?.cacheKey === cacheKey) return cached;

  const sections: string[] = [];
  for (const file of files) {
    const content = await readOptionalText(join(workspaceRoot, file.path));
    if (!content) continue;
    sections.push(`## ${file.path}\n${content.slice(0, maxFileBytes)}`);
  }
  const text = sections.join('\n\n').slice(0, maxContextBytes);
  if (!text) return undefined;
  const context = { text, cacheKey, files };
  cache.set(workspaceRoot, context);
  return context;
}

export function formatProjectContext(context: ProjectContext | undefined) {
  if (!context) return undefined;
  return `cacheKey=${context.cacheKey}; files=${context.files.map((file) => file.path).join(', ') || 'none'}\n${context.text}`;
}

async function projectInstructionStats(workspaceRoot: string) {
  const files: ProjectContext['files'] = [];
  for (const path of instructionFiles) {
    try {
      const info = await stat(join(workspaceRoot, path));
      if (info.isFile()) files.push({ path, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      // Missing instruction files are expected.
    }
  }
  return files;
}

async function readOptionalText(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function hashSignature(files: ProjectContext['files']) {
  const hash = createHash('sha1');
  hash.update(JSON.stringify(files));
  return hash.digest('hex').slice(0, 12);
}
