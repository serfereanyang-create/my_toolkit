# Yijing / Zhouyi Foundations

## Open-Source Starting Points

- `kentang2017/ichingshifa`: Python package covering 周易筮法, 大衍之数, 六十四卦, 六爻, 京房易, 爻辞, date divination, and divination workflows. Treat it as the first Python source to inspect for Yijing casting mechanics.
- `wangsquirrel/divicast`: LLM-friendly Python charting library for 六爻 and 八字. Useful for structured outputs and modern agent integration patterns.
- `strobus/i-ching`: JavaScript/Node library and API for I Ching work. Lower activity than `ichingshifa`, but useful for JS-oriented workflows when current.
- `freizl/yijing`: Small JavaScript project containing 易经 64卦, 卦辞, 爻辞 data; inspect licensing and completeness before reuse.

Verify current APIs and licenses before importing code or text because Yijing repositories vary widely in maintenance and source quality.

## Required Intake

- Exact question. Yijing readings are question-centered; avoid answering without a clear object.
- Casting method: three coins, yarrow stalks/大衍筮法, date/time/number 起卦, manual hexagram, or screenshot.
- 本卦, 动爻, 变卦 if already known.
- Date/time and location only if the method needs them.
- Desired style: plain symbolic reading, classical text explanation, decision guidance, or 六爻 technical analysis.

## Hexagram Basics

- 八卦: 乾, 兑, 离, 震, 巽, 坎, 艮, 坤.
- 六十四卦: upper trigram plus lower trigram.
- 爻位 read from bottom to top: 初, 二, 三, 四, 五, 上.
- 老阳/老阴 are moving lines; 少阳/少阴 are stable lines.
- 本卦 describes the current structure.
- 动爻 identifies the change pressure or focal turning point.
- 变卦 describes the direction or transformed situation.
- 互卦, 错卦, 综卦 are optional secondary lenses; use only when the method calls for them.

## Reading Order

1. Restate the question in neutral language.
2. Record the casting method and raw result.
3. Identify 本卦, 动爻, 变卦.
4. Explain the core image of 本卦.
5. Interpret moving lines as the active advice or warning.
6. Read 变卦 as the tendency after change.
7. Give practical advice with uncertainty and conditions.

Avoid forcing a yes/no answer when the hexagram is more about timing, preparation, restraint, or relationship dynamics.

## Six-Yao / 六爻 Technical Workflow

Use 六爻 only when data is sufficient. If not, ask for the full hexagram with moving lines or the original cast.

- Establish 世爻 and 应爻.
- Choose 用神 based on the question:
  - 父母: documents, house, protection, parents, study.
  - 官鬼: career authority, pressure, disease symbolism, partner in some female relationship readings depending on school.
  - 兄弟: peers, competitors, expenditure.
  - 妻财: money, resources, partner in some male relationship readings depending on school.
  - 子孙: output, children, relief, creativity, medicine symbolism depending on context.
- Consider 六神 when shown: 青龙, 朱雀, 勾陈, 螣蛇, 白虎, 玄武.
- Judge 旺衰 using 月建 and 日辰 when supplied.
- Examine 动爻, 变爻, 合冲, 生克, 空亡, 伏神/飞神 only when chart data supports them.

Do not fabricate missing 六爻 attributes.

## Integration With Zi Wei

- Use Zi Wei Dou Shu for birth-chart structure, long-term temperament, life domains, and decade/year timing.
- Use Yijing for a concrete question, current decision, short-term dynamic, or "what is changing now".
- When combining both, keep layers distinct:
  - "命盘结构" = long-term pattern.
  - "卦象" = current question and change.
  - "现实建议" = actions that satisfy both readings.

## Guardrails

- Treat Yijing as traditional symbolic reasoning, not deterministic truth.
- Do not make irreversible decisions for the user.
- For health, money, legal, or safety topics, recommend professional judgment and use the reading only as reflection.
- Quote classical text only briefly unless the user provides the source or asks for public-domain passages.
