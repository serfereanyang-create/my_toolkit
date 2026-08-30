const fs = require('node:fs/promises');
const path = require('node:path');

/*
 * Materializes the "个性化" (Personalize) settings into a workspace file the CLI
 * already reads as project context (.aicode/persona.md — see cli context.ts
 * instructionFiles). This is how the desktop persona actually reaches the model:
 * the CLI injects instruction files into the system prompt at prompt-build time.
 *
 * Keeping it as a real file (rather than a hidden prompt prefix) means it is
 * transparent, workspace-scoped, and reuses the CLI's existing, tested path.
 *
 * Preference keys: the settings UI stores dotted keys (persona.nickname,
 * gitBranchPrefix, …). Older tests and any legacy writes used camelCase
 * (personaNickname). Look up both so neither path is a silent no-op.
 */

const TONE_LABELS = {
  default: null,
  concise: '语气：简洁、直接，减少寒暄。',
  friendly: '语气：友好、鼓励，适度使用口语。',
  formal: '语气：正式、专业、严谨。',
};

const VERBOSITY_LABELS = {
  low: '详细程度：精简。优先给结论和最小可用示例。',
  medium: null,
  high: '详细程度：详尽。给出背景、权衡与完整示例。',
};

const MERGE_LABELS = {
  merge: 'merge commit（保留完整历史）',
  squash: 'squash merge（压成单提交）',
  rebase: 'rebase 后合并',
};

const REVIEW_LABELS = {
  inline: '尽可能在当前聊天中启动 /review',
  separate: '启动单独的审查聊天',
};

/** Read a string pref under either `dotted` or `camel` key. */
function prefString(prefs, dotted, camel, fallback = '') {
  const a = prefs[dotted];
  if (typeof a === 'string') return a;
  const b = prefs[camel];
  if (typeof b === 'string') return b;
  return fallback;
}

/** Read a boolean pref under either key; undefined means "use default". */
function prefBoolean(prefs, dotted, camel, fallback) {
  const a = prefs[dotted];
  if (typeof a === 'boolean') return a;
  const b = prefs[camel];
  if (typeof b === 'boolean') return b;
  return fallback;
}

/** Build the persona markdown from persisted preferences. Returns '' when the
 *  persona is disabled and there is no git guidance either. Pure + exported for tests. */
function buildPersonaMarkdown(preferences) {
  const prefs = preferences || {};
  const personaEnabled = prefBoolean(prefs, 'persona.enabled', 'personaEnabled', true);

  const nickname = prefString(prefs, 'persona.nickname', 'personaNickname').trim();
  const role = prefString(prefs, 'persona.role', 'personaRole').trim();
  const toneKey = prefString(prefs, 'persona.tone', 'personaTone', 'default');
  const verbosityKey = prefString(prefs, 'persona.verbosity', 'personaVerbosity', 'medium');
  const instructions = prefString(prefs, 'persona.instructions', 'personaInstructions').trim();
  const tone = TONE_LABELS[toneKey] || null;
  const verbosity = VERBOSITY_LABELS[verbosityKey] || null;

  const sections = [];

  if (personaEnabled) {
    const lines = [];
    if (nickname) lines.push(`- 称呼用户为「${nickname}」。`);
    if (role) lines.push(`- 用户的职业 / 角色：${role}。请结合该背景作答。`);
    if (tone) lines.push(`- ${tone}`);
    if (verbosity) lines.push(`- ${verbosity}`);
    if (lines.length) sections.push(`### 用户偏好\n${lines.join('\n')}`);
    if (instructions) sections.push(`### 自定义指令\n${instructions.slice(0, 4000)}`);
  }

  const gitSection = buildGitSection(prefs);
  if (gitSection) sections.push(gitSection);

  const computerSection = buildComputerSection(prefs);
  if (computerSection) sections.push(computerSection);

  if (!sections.length) return '';

  return `# 用户个性化设置\n\n以下是用户在桌面端配置的偏好，请在本次会话中遵循：\n\n${sections.join('\n\n')}\n`;
}

/** Git preferences always inject when non-default or guides are set, even if
 *  the personalize toggle is off — they govern agent git/PR behavior. */
function buildGitSection(prefs) {
  const branchPrefix = prefString(prefs, 'gitBranchPrefix', 'gitBranchPrefix', 'codex/').trim() || 'codex/';
  const mergeMethodRaw = prefString(prefs, 'gitMergeMethod', 'gitMergeMethod', 'merge').trim() || 'merge';
  const mergeMethod = MERGE_LABELS[mergeMethodRaw] ? mergeMethodRaw : 'merge';
  const forcePush = prefBoolean(prefs, 'gitForcePush', 'gitForcePush', false);
  const draftPr = prefBoolean(prefs, 'gitDraftPr', 'gitDraftPr', true);
  const reviewModeRaw = prefString(prefs, 'gitReviewMode', 'gitReviewMode', 'inline').trim() || 'inline';
  const reviewMode = REVIEW_LABELS[reviewModeRaw] ? reviewModeRaw : 'inline';
  const commitGuide = prefString(prefs, 'gitCommitGuide', 'gitCommitGuide').trim();
  const prGuide = prefString(prefs, 'gitPrGuide', 'gitPrGuide').trim();

  const lines = [
    `- 创建新分支时使用前缀 \`${branchPrefix}\`（例如 \`${branchPrefix}feature-name\`）。`,
    `- 合并拉取请求时使用：${MERGE_LABELS[mergeMethod]}。`,
    forcePush
      ? '- 推送时使用 `--force-with-lease`（用户已开启「始终强制推送」）。'
      : '- 不要 force push，除非用户明确要求。',
    draftPr
      ? '- 创建 PR 时默认使用草稿拉取请求（draft）。'
      : '- 创建 PR 时默认创建正式（非草稿）拉取请求。',
    `- 代码审查：${REVIEW_LABELS[reviewMode]}。`,
  ];

  const parts = [`### Git 工作流偏好\n${lines.join('\n')}`];
  if (commitGuide) {
    parts.push(`### 提交说明指引\n生成 commit message 时遵循：\n${commitGuide.slice(0, 2000)}`);
  }
  if (prGuide) {
    parts.push(`### 拉取请求指引\n生成 PR 标题/描述时遵循：\n${prGuide.slice(0, 2000)}`);
  }
  return parts.join('\n\n');
}

/** Computer control preferences injected so the agent respects the user's
 *  shell/application permission settings. */
function buildComputerSection(prefs) {
  const anyApp = prefs.computerAnyApp !== false; // default true
  const excel  = prefs.computerExcel === true;
  const allowed = Array.isArray(prefs.computerAllowedApps)
    ? prefs.computerAllowedApps.filter((v) => typeof v === 'string' && v.trim())
    : [];

  const lines = [];

  if (anyApp) {
    lines.push('- 用户已允许「任意应用」：可以在 auto 模式下执行任意 shell 命令，无需额外确认。');
  } else {
    lines.push('- 用户已关闭「任意应用」：执行 shell 命令时需谨慎，优先询问用户确认再运行非只读命令。');
    if (allowed.length > 0) {
      lines.push(`- 以下应用/命令无需确认（始终允许）：${allowed.map((a) => `\`${a}\``).join('、')}。`);
    }
  }

  if (excel) {
    lines.push('- 用户已启用 Microsoft Excel 加载项支持，可以调用 Excel 相关命令。');
  }

  if (!anyApp || allowed.length > 0 || excel) {
    return `### 电脑操控权限\n${lines.join('\n')}`;
  }
  // anyApp=true (default) and nothing special — skip section to keep persona.md compact
  return '';
}

/** Write or remove .aicode/persona.md under the workspace to match the prefs.
 *  No-op-safe: never throws into the caller (agent start must not fail on this). */
async function syncPersonaFile(workspaceRoot, preferences) {
  if (!workspaceRoot) return { written: false };
  const target = path.join(workspaceRoot, '.aicode', 'persona.md');
  try {
    const markdown = buildPersonaMarkdown(preferences);
    if (!markdown) {
      await fs.rm(target, { force: true });
      return { written: false };
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, markdown, 'utf8');
    return { written: true };
  } catch {
    // Persona is best-effort; a filesystem hiccup must not block the agent.
    return { written: false };
  }
}

module.exports = { buildPersonaMarkdown, syncPersonaFile, buildGitSection, buildComputerSection };
