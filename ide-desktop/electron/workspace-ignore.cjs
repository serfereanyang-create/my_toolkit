/*
 * Workspace ignore rules — port of zcode's workspaceFileIgnore.
 *
 * `.zcodeignore` (workspace root, gitignore syntax) is the single source of
 * truth for file-search candidates. It is auto-created on first use: a copy
 * of the root `.gitignore` when one exists, otherwise the builtin template.
 * After that, `.gitignore` changes no longer affect search — the user edits
 * `.zcodeignore` directly (or deletes it to regenerate).
 *
 * Rule parsing is the `ignore` npm package (gitignore spec 2.22 reference
 * implementation) — the same one zcode uses; hand-rolling gitignore parsing
 * is explicitly off the table.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const ignoreFactory = require('ignore');
const { renameWithRetry } = require('./atomic-file.cjs');
/**
 * Publish the ignore file whole. Writing it in place truncates first: a crash
 * leaves a half-written .zcodeignore, which the next run then reads as the
 * user's own rules — the search silently stops honouring most of them.
 */
async function writeIgnoreFile(target, content) {
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, content, 'utf-8');
  try {
    await renameWithRetry(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

const IGNORE_FILE_NAME = '.zcodeignore';
const GITIGNORE_FILE_NAME = '.gitignore';

// Seeds the template; matches upstream's builtin exclusion set.
const BUILTIN_IGNORE_LINES = [
  '.git/', '.hg/', '.svn/',
  'node_modules/', 'bower_components/', 'jspm_packages/',
  '__pycache__/', 'site-packages/', 'venv/', 'coverage/', 'htmlcov/', 'lcov-report/',
  'cmakefiles/', 'cmake-build-*/', 'bazel-*/', 'pods/', 'deriveddata/',
  'storybook-static/', 'playwright-report/', 'test-results/', 'allure-results/', 'allure-report/',
  'cdk.out/', '*.egg-info/', '*.dist-info/', 'eggs/', 'pip-wheel-metadata/', 'wheels/',
  '.aicode/', '.zcode/',
];

const TEMPLATE_HEADER = [
  '# YOYcode 工作区文件搜索忽略规则（.zcodeignore）',
  '# 语法与 .gitignore 一致，只影响文件搜索候选（@ 引用 / 快速打开）。',
  '# 删除本文件后重新搜索会按当前 .gitignore 重新生成。',
].join('\n');

function builtinTemplateContent() {
  return `${TEMPLATE_HEADER}\n\n${BUILTIN_IGNORE_LINES.join('\n')}\n`;
}

async function pathExists(candidate) {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns { matcher, source } where source is one of:
 *   file | created-from-gitignore | created-from-template | fallback-builtin
 * `created-*` sources also wrote the file to disk.
 */
async function ensureIgnoreRules(rootPath) {
  const ignorePath = path.join(rootPath, IGNORE_FILE_NAME);
  const gitignorePath = path.join(rootPath, GITIGNORE_FILE_NAME);

  if (await pathExists(ignorePath)) {
    try {
      const content = await fs.readFile(ignorePath, 'utf-8');
      return { matcher: ignoreFactory().add(content), source: 'file' };
    } catch {
      // fall through to builtin
    }
  }

  if (await pathExists(gitignorePath)) {
    try {
      const content = await fs.readFile(gitignorePath, 'utf-8');
      await writeIgnoreFile(ignorePath, content);
      return { matcher: ignoreFactory().add(content), source: 'created-from-gitignore' };
    } catch {
      // fall through to builtin
    }
  }

  const content = builtinTemplateContent();
  try {
    await writeIgnoreFile(ignorePath, content);
    return { matcher: ignoreFactory().add(content), source: 'created-from-template' };
  } catch {
    return { matcher: ignoreFactory().add(BUILTIN_IGNORE_LINES.join('\n')), source: 'fallback-builtin' };
  }
}

module.exports = { IGNORE_FILE_NAME, BUILTIN_IGNORE_LINES, ensureIgnoreRules, builtinTemplateContent };
