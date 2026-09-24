/*
 * Custom slash commands — ported from zcode's commandFileParser +
 * commandsService (commands living as markdown files with frontmatter).
 *
 * Discovery reads two flat-ish directories: a user-level dir (userData) and
 * the workspace's .zcode/commands (same layout zcode uses, so command files
 * are portable between tools). On a name collision the workspace file wins.
 * Subdirectories become namespaces: <dir>/<file>.md -> /<dir>/<file>.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteText } = require('./atomic-file.cjs');

const REPLACED_FRONTMATTER_KEYS = new Set(['description', 'argument-hint']);

function getCrossPlatformBasename(filePath) {
  return filePath.split(/[\\/]+/).pop() ?? '';
}

function splitMarkdownCommandContent(content) {
  const lines = content.split('\n');
  const frontmatterStart = lines.findIndex((line) => line.trim() === '---');
  const frontmatterEnd = lines.findIndex((line, index) => index > frontmatterStart && line.trim() === '---');
  if (frontmatterStart === -1 || frontmatterEnd === -1) {
    return { frontmatterLines: [], contentLines: lines };
  }
  return {
    frontmatterLines: lines.slice(frontmatterStart + 1, frontmatterEnd),
    contentLines: lines.slice(frontmatterEnd + 1),
  };
}

function readFrontmatterKey(line) {
  if (line.startsWith(' ') || line.startsWith('\t')) return undefined;
  const match = /^([A-Za-z0-9_-]+)\s*:/.exec(line.trim());
  return match?.[1]?.toLowerCase();
}

function readFrontmatterMultilineValue(lines, targetKey) {
  const collected = [];
  let collecting = false;
  for (const line of lines) {
    const key = readFrontmatterKey(line);
    if (key) {
      if (collecting) break;
      if (key === targetKey) {
        collecting = true;
        const value = line.split(':').slice(1).join(':').trim();
        if (value) collected.push(value);
      }
      continue;
    }
    if (collecting && (line.startsWith(' ') || line.startsWith('\t'))) {
      collected.push(line.trim());
    }
  }
  const value = collected.join(' ').trim();
  return value || undefined;
}

function preserveFrontmatterLines(existingContent, replacedKeys) {
  const preserved = [];
  let skipUntilNextKey = false;
  for (const line of splitMarkdownCommandContent(existingContent ?? '').frontmatterLines) {
    const key = readFrontmatterKey(line);
    if (key) {
      skipUntilNextKey = replacedKeys.has(key);
    }
    if (!skipUntilNextKey) {
      preserved.push(line);
    }
  }
  return preserved;
}

function parseCommandFile(content, filePath) {
  try {
    const { frontmatterLines, contentLines } = splitMarkdownCommandContent(content);
    const fileName = getCrossPlatformBasename(filePath);
    const name = `/${fileName.replace(/\.md$/i, '')}`;
    if (!name) return null;
    return {
      name,
      prompt: contentLines.join('\n').trim(),
      content: contentLines.join('\n'),
      filePath,
      description: readFrontmatterMultilineValue(frontmatterLines, 'description'),
      argumentHint: readFrontmatterMultilineValue(frontmatterLines, 'argument-hint'),
    };
  } catch {
    return null;
  }
}

function generateCommandFileContent(config, existingContent) {
  const frontmatterLines = preserveFrontmatterLines(existingContent, REPLACED_FRONTMATTER_KEYS);
  if (config.description?.trim()) {
    frontmatterLines.push(`description: ${config.description.trim()}`);
  }
  if (config.argumentHint?.trim()) {
    frontmatterLines.push(`argument-hint: ${config.argumentHint.trim()}`);
  }
  if (frontmatterLines.length === 0) {
    return config.prompt;
  }
  return `---\n${frontmatterLines.join('\n')}\n---\n\n${config.prompt}`;
}

async function readCommandsDir(dir, namespace = '') {
  let dirEntries;
  try {
    dirEntries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const commands = [];
  for (const dirEntry of dirEntries) {
    const childPath = path.join(dir, dirEntry.name);
    if (dirEntry.isDirectory()) {
      commands.push(...await readCommandsDir(childPath, namespace ? `${namespace}/${dirEntry.name}` : dirEntry.name));
      continue;
    }
    if (!dirEntry.isFile() || !dirEntry.name.toLowerCase().endsWith('.md')) continue;
    const content = await fs.readFile(childPath, 'utf-8').catch(() => null);
    if (content === null) continue;
    const parsed = parseCommandFile(content, childPath);
    if (!parsed) continue;
    const prefix = namespace ? `/${namespace}` : '';
    commands.push({
      ...parsed,
      name: `${prefix}${parsed.name}`,
      source: 'file',
    });
  }
  return commands;
}

function createCommandsService(options = {}) {
  const userCommandsDir = options.userCommandsDir;
  const workspaceCommandsDir = options.workspaceCommandsDir;

  function dirFor(name) {
    // Names may carry a namespace segment (/dir/file) — create parents.
    const cleaned = name.replace(/^\/+/, '');
    if (workspaceCommandsDir) return { dir: workspaceCommandsDir, relative: `${cleaned}.md` };
    return { dir: userCommandsDir, relative: `${cleaned}.md` };
  }

  return {
    async listCommands() {
      const [user, workspace] = await Promise.all([
        readCommandsDir(userCommandsDir),
        workspaceCommandsDir ? readCommandsDir(workspaceCommandsDir) : Promise.resolve([]),
      ]);
      const byName = new Map();
      for (const command of user) byName.set(command.name, { ...command, scope: 'user' });
      for (const command of workspace) byName.set(command.name, { ...command, scope: 'workspace' });
      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    },

    async saveCommand({ name, prompt, description, argumentHint }) {
      if (!/^\/[A-Za-z0-9_/:-]+$/.test(name)) {
        throw new Error(`Invalid command name: ${name}`);
      }
      const { dir, relative } = dirFor(name);
      const filePath = path.join(dir, ...relative.split('/'));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const existing = await fs.readFile(filePath, 'utf-8').catch(() => undefined);
      const content = generateCommandFileContent({ prompt, description, argumentHint }, existing);
      await atomicWriteText(filePath, content);
      return { name, filePath };
    },

    async deleteCommand({ name }) {
      const { dir, relative } = dirFor(name);
      const filePath = path.join(dir, ...relative.split('/'));
      await fs.rm(filePath, { force: true });
    },
  };
}

module.exports = {
  parseCommandFile,
  generateCommandFileContent,
  readCommandsDir,
  createCommandsService,
};
