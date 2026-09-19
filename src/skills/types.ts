/**
 * types.ts — 技能（Skill）定义。
 *
 * 参考 Claude Code 的 SKILL.md 模式：每个技能是一个目录下的 SKILL.md，
 * frontmatter 声明 name/description/triggers，正文是注入给模型的操作指令。
 */

export interface SkillDefinition {
  /** 技能名（目录名，kebab-case） */
  name: string;
  /** 一句话描述，用于触发匹配与列表展示 */
  description: string;
  /** 触发词/短语（小写），prompt 中出现即激活 */
  triggers: string[];
  /** 正文指令（注入给模型） */
  instructions: string;
  /** 来源文件的绝对路径 */
  sourcePath: string;
}

/** 解析失败的技能条目（诚实上报而非静默丢弃）。 */
export interface SkillLoadError {
  path: string;
  reason: string;
}

export interface SkillScanResult {
  skills: SkillDefinition[];
  errors: SkillLoadError[];
}

/**
 * 解析 SKILL.md：`---` 包裹的 frontmatter（name/description/triggers）+ 正文。
 * 无 frontmatter 时：name 取目录名，正文全部作为 instructions。
 */
export function parseSkillMarkdown(markdown: string, fallbackName: string, sourcePath: string): SkillDefinition | { error: string } {
  const text = markdown.replace(/\r\n/g, '\n');
  if (!text.trim()) return { error: 'SKILL.md 为空' };

  let frontmatterRaw = '';
  let body = text;
  const normalized = text.startsWith('---') ? text : text;
  if (normalized.startsWith('---')) {
    const closing = normalized.indexOf('\n---', 3);
    if (closing > 0) {
      frontmatterRaw = normalized.slice(4, closing).trim();
      body = normalized.slice(closing + 4).replace(/^\n+/, '');
    }
  }

  let name = fallbackName;
  let description = '';
  const triggers: string[] = [];
  for (const line of frontmatterRaw.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'name' && value) name = value;
    else if (key === 'description' && value) description = value;
    else if (key === 'triggers' && value) {
      for (const part of value.split(/[,，]/)) {
        const t = part.trim().toLowerCase();
        if (t) triggers.push(t);
      }
    }
  }

  if (!body.trim()) return { error: 'SKILL.md 正文为空（无指令内容）' };
  return { name, description, triggers, instructions: body.trim(), sourcePath };
}
