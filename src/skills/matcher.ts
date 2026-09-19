/**
 * matcher.ts — 按任务 prompt 匹配应激活的技能。
 *
 * 打分：触发词命中（权重 5）> 名称命中（4）> 描述词命中（1）。
 * 返回得分最高的前 N 个（默认 3），0 分不返回。
 */

import type { SkillDefinition } from './types.js';

export interface SkillMatch {
  skill: SkillDefinition;
  score: number;
}

export function matchSkills(prompt: string, skills: SkillDefinition[], maxMatches = 3): SkillMatch[] {
  const lower = prompt.toLowerCase();
  const scored: SkillMatch[] = [];

  for (const skill of skills) {
    let score = 0;
    for (const trigger of skill.triggers) {
      if (trigger && lower.includes(trigger)) score += 5;
    }
    if (skill.name && lower.includes(skill.name.toLowerCase())) score += 4;
    // 描述词命中：描述中长度 >=2 的词出现在 prompt 里，每个 +1（上限 3）
    const descWords = skill.description.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((w) => w.length >= 2);
    let descHits = 0;
    for (const word of descWords) {
      if (lower.includes(word)) {
        descHits += 1;
        if (descHits >= 3) break;
      }
    }
    score += descHits;
    if (score > 0) scored.push({ skill, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, maxMatches);
}

/** 生成注入 prompt 的技能指令块（XML 风格，与记忆块一致的使用方式）。 */
export function buildSkillBlock(matches: SkillMatch[]): string {
  if (matches.length === 0) return '';
  const parts = matches.map(({ skill }) =>
    `<skill name="${skill.name}">\n${skill.instructions}\n</skill>`,
  );
  return [
    '<relevant-skills>',
    '以下技能与当前任务相关。请按照技能内的指令执行：',
    ...parts,
    '</relevant-skills>',
  ].join('\n');
}
