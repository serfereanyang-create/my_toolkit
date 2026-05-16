# Bazi / Four Pillars Foundations

## Open-Source Starting Points

- `6tail/lunar-javascript`: JavaScript calendar library covering solar/lunar conversion, 干支, 节气, 八字, 五行, 十神, 纳音, 神煞, daily almanac data. Strong JS source.
- `6tail/lunar-python`: Python version of the same ecosystem; useful for local scripts and verification.
- `waterbeside/lunisolar`: TypeScript lunar calendar library with 四柱, 五行纳音, 神煞宜忌, and plugin architecture.
- `cantian-ai/bazi-mcp`: MCP server for Bazi information; useful when integrating Bazi with agent tooling.
- `wangsquirrel/divicast`: LLM-friendly 六爻/八字 charting library; useful for structured outputs.

Verify current APIs, timezone behavior, 节气 handling, and license before using any library.

## Required Inputs

- Birth date and time.
- Calendar type: Gregorian/solar or lunar.
- Birthplace/time zone.
- Sex/gender if calculating 大运 direction by traditional rules.
- Whether to use 真太阳时.
- Whether month pillar should follow 节气. Most Bazi systems use solar terms, not lunar month boundaries.

Do not silently convert time zones, lunar dates, or true solar time.

## Core Objects

- 年柱: ancestral/social background, early environment, broad era.
- 月柱: season, 月令, family/work environment, strongest context for 日主.
- 日柱: 日主 and spouse/self seat.
- 时柱: later life, output, children, long-range direction.
- 日主: the heavenly stem of the day pillar; the anchor for 十神.
- 藏干: hidden stems inside earthly branches.
- 通根: whether a heavenly stem has root in branches.
- 透干: whether a hidden or relevant element appears in heavenly stems.
- 大运: decade-level timing.
- 流年: year-level timing.

## Five-Element Analysis

Read season before counting elements mechanically:

1. Identify 月令 and seasonal climate.
2. Judge 日主 strength by season, roots, support, and pressure.
3. Consider 寒暖燥湿 and 调候, especially for extreme cold/heat/dry/damp charts.
4. Look for balance, flow, blockages, and excessive conflict.
5. Only then discuss 用神/喜忌.

Avoid simplistic "more of missing element is always good" claims.

## Ten Gods

Relative to 日主:

- 比肩: same polarity same element; self, peers, independence.
- 劫财: same element opposite polarity; competition, sharing, boldness.
- 食神: output with gentler expression; talent, ease, nourishment.
- 伤官: output with sharper expression; critique, rebellion, performance.
- 偏财: indirect wealth; opportunity, market, resource handling.
- 正财: direct wealth; stability, responsibility, tangible management.
- 七杀: pressure, challenge, urgency, discipline if transformed.
- 正官: order, role, responsibility, rules, status.
- 偏印: unconventional learning, protection, abstraction, isolation risk.
- 正印: support, education, care, legitimacy.

Interpret 十神 through location, strength, combinations, clashes, and useful/unhelpful role in the chart.

## Common Relationships

- 生/克: generation/control among 五行.
- 合: combination; may transform only under conditions.
- 冲: clash; movement, conflict, change.
- 刑: punishment/tension; hidden friction.
- 害: harm; subtle obstruction.
- 破: breakage; disruption.
- 三合/三会: group tendencies; require context.

Do not claim a combination transforms unless seasonal and structural conditions support it.

## Timing Workflow

1. Establish base chart and 日主.
2. Determine 大运 direction and starting age with a trusted library or clear rule.
3. Read the current 大运 as the main background.
4. Read 流年 as activation of stems/branches, ten gods, and chart relationships.
5. For specific months, use 流月 only after 大运/流年 are understood.
6. Cross-check with Zi Wei 大限/流年 and Yijing for current questions.

## Integration With Other Layers

- Zi Wei Dou Shu: better for palace-specific life domains and star-event structure.
- Bazi: better for 五行气势, 十神 psychology, resource/pressure/output patterns, seasonal climate.
- Yijing: better for a concrete current question and change dynamic.
- TCM: useful for symbolic 五行/寒热燥湿/体质 language, not diagnosis.
- Psychology communication: useful for turning readings into safe, practical conversation.

## Guardrails

- State school assumptions when discussing 用神, 格局, 神煞, or true solar time.
- Avoid deterministic marriage, wealth, illness, death, or disaster claims.
- Do not overuse 神煞; treat them as secondary unless the user asks for a school that centers them.
- Ask for exact birth time when hour pillar or 大运 timing matters.
