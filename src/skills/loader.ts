/**
 * loader.ts — 扫描工作区技能目录 `.aicode/skills/<name>/SKILL.md`。
 *
 * 纯文件读取与解析：坏技能记录为错误（诚实上报），不影响其他技能。
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillMarkdown, type SkillDefinition, type SkillScanResult } from './types.js';

export const SKILLS_DIRNAME = 'skills';

export async function scanSkills(workspaceRoot: string): Promise<SkillScanResult> {
  const result: SkillScanResult = { skills: [], errors: [] };
  const skillsDir = join(workspaceRoot, '.aicode', SKILLS_DIRNAME);
  if (!existsSync(skillsDir)) return result;

  let entries: string[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true }).then((list) => list.map((d) => d.name));
  } catch (err) {
    result.errors.push({ path: skillsDir, reason: `目录读取失败: ${err instanceof Error ? err.message : String(err)}` });
    return result;
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const skillDir = join(skillsDir, entry);
    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    try {
      const markdown = await readFile(skillFile, 'utf-8');
      const parsed = parseSkillMarkdown(markdown, entry, skillFile);
      if ('error' in parsed) {
        result.errors.push({ path: skillFile, reason: parsed.error });
        continue;
      }
      result.skills.push(parsed);
    } catch (err) {
      result.errors.push({ path: skillFile, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  result.skills.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/** 按技能名精确查找（供 skill_show 使用）。 */
export async function findSkillByName(workspaceRoot: string, name: string): Promise<SkillDefinition | null> {
  const { skills } = await scanSkills(workspaceRoot);
  const lower = name.trim().toLowerCase();
  return skills.find((s) => s.name.toLowerCase() === lower) ?? null;
}
