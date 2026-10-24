/*
 * Session markdown export — ported from zcode's conversation-share
 * sharedContextFormatter, adapted to this app's session records.
 *
 * Same contract as upstream: fenced tool I/O with a fence taller than any
 * backtick run in the payload, a sha256 over the final document, and unknown
 * message roles recorded as unsupportedKinds instead of failing the export.
 */

const { createHash } = require('node:crypto');
const path = require('node:path');
const { atomicWriteText } = require('./atomic-file.cjs');

/**
 * Fence length = the longest backtick run in the payload + 1, never below 3.
 * "Use four when the payload contains ```" is not enough: a run of four
 * backticks then closes the block early, and every line after it renders as
 * live markdown/HTML in the exported document. Tool output is not trusted text
 * — it is whatever the repo the agent was working in happened to contain.
 */
function fenced(value) {
  const longestRun = (String(value).match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${value}\n${fence}`;
}

function formatSessionMarkdown(record) {
  const title = record.title || record.id;
  const sections = [`# Conversation: ${title}`];

  const meta = [];
  if (record.provider) meta.push(`- Provider: ${record.provider}`);
  if (record.model) meta.push(`- Model: ${record.model}`);
  if (record.workspaceRoot) meta.push(`- Workspace: ${record.workspaceRoot}`);
  if (record.createdAt) meta.push(`- Created: ${new Date(record.createdAt).toISOString()}`);
  if (meta.length > 0) sections.push(`## Metadata\n\n${meta.join('\n')}`);

  const unsupportedKinds = new Set();
  let messageCount = 0;
  for (const message of record.messages ?? []) {
    if (!message || typeof message.role !== 'string') {
      unsupportedKinds.add('unknown');
      continue;
    }
    messageCount += 1;
    const text = typeof message.content === 'string' ? message.content : String(message.content ?? '');
    switch (message.role) {
      case 'user':
        sections.push(`## User\n\n${text}`);
        break;
      case 'assistant':
        sections.push(`## Assistant\n\n${text}`);
        break;
      case 'tool':
        sections.push(`## Tool: ${message.name ?? 'tool'}\n\n### Output\n\n${fenced(text)}`);
        break;
      default:
        unsupportedKinds.add(message.role);
        break;
    }
  }

  const markdown = `${sections.join('\n\n')}\n`;
  return {
    markdown,
    markdownSha256: createHash('sha256').update(markdown, 'utf8').digest('hex'),
    unsupportedKinds: [...unsupportedKinds],
    messageCount,
  };
}

async function exportSessionToFile(record, outFilePath) {
  const formatted = formatSessionMarkdown(record);
  await atomicWriteText(outFilePath, formatted.markdown);
  return formatted;
}

function defaultExportPath(workspaceRoot, sessionId) {
  if (workspaceRoot) {
    return path.join(workspaceRoot, '.aicode', 'exports', `${sessionId}.md`);
  }
  return path.join(require('node:os').tmpdir(), 'yoycode-exports', `${sessionId}.md`);
}

module.exports = { formatSessionMarkdown, exportSessionToFile, defaultExportPath, fenced };
