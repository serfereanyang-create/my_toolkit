import type { AgentAction, AgentMessage } from '../providers/types.js';
import type { SessionRecord } from '../session/store.js';

type ToolAction = Extract<AgentAction, { type: 'tool' }>;

export function planLocalFallback(prompt: string, session: SessionRecord): ToolAction[] {
  const normalized = prompt.trim().toLowerCase();
  const effectivePrompt = isRetryPrompt(normalized) ? previousUserPrompt(session.messages) ?? prompt : prompt;
  const rename = planRename(effectivePrompt, session);
  if (rename) return [rename];
  return [];
}

function isRetryPrompt(normalized: string) {
  return ['重新', '重试', '再来', 'retry', 'again'].includes(normalized);
}

function previousUserPrompt(messages: AgentMessage[]) {
  const users = messages.filter((message) => message.role === 'user').map((message) => message.content);
  return users.length >= 2 ? users[users.length - 2] : undefined;
}

function planRename(prompt: string, session: SessionRecord): ToolAction | undefined {
  const normalized = prompt.toLowerCase();
  if (!hasAny(normalized, ['改名', '重命名', 'rename', '名字'])) return undefined;
  const targetName = extractRenameTarget(prompt);
  if (!targetName) return undefined;
  const previousPath = latestCreatedPath(session) ?? 'desktop/新建文档.docx';
  const nextPath = toDesktopDocxPath(targetName);
  return { type: 'tool', tool: 'rename_file', input: { from: previousPath, to: nextPath } };
}

function latestCreatedPath(session: SessionRecord) {
  for (const call of [...session.toolCalls].reverse()) {
    if (!call.ok || typeof call.data !== 'object' || call.data === null) continue;
    const data = call.data as Record<string, unknown>;
    if (typeof data.path === 'string') return normalizeDesktopPath(data.path);
    if (typeof data.to === 'string') return normalizeDesktopPath(data.to);
  }
  return undefined;
}

function normalizeDesktopPath(path: string) {
  const normalized = path.replace(/\\/g, '/');
  const desktopIndex = normalized.toLowerCase().lastIndexOf('/desktop/');
  if (desktopIndex >= 0) return `desktop/${normalized.slice(desktopIndex + '/desktop/'.length)}`;
  return normalized;
}

function extractRenameTarget(prompt: string) {
  const patterns = [/改(?:成|为|名为)([^，。\n]+)/, /名字(?:改成|改为|为)([^，。\n]+)/, /rename\s+(?:it\s+)?(?:to\s+)?([^，。\n]+)/i];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match?.[1]) return cleanupName(match[1]);
  }
  const fallback = prompt.match(/为([^，。\n]+)/);
  return fallback?.[1] ? cleanupName(fallback[1]) : undefined;
}

function cleanupName(value: string) {
  return value.replace(/["'“”‘’]/g, '').trim();
}

function toDesktopDocxPath(name: string) {
  const clean = name.replace(/[\\/:*?"<>|]/g, '').trim() || '测试文档';
  return `desktop/${clean.toLowerCase().endsWith('.docx') ? clean : `${clean}.docx`}`;
}

function hasAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}
