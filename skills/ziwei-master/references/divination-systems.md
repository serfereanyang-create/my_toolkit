# Current-Question Divination Systems

## Purpose

Use this reference for event-focused divination: 易经占卜, 六爻, 梅花易数, 小六壬, 大六壬, and cross-method synthesis. These methods answer "what is happening with this question now?" rather than replacing natal systems such as Zi Wei or Bazi.

## Open-Source Starting Points

- `kentang2017/ichingshifa`: Python 周易筮法, 大衍之数, 六十四卦, 六爻, 京房易, 爻辞, date divination. Strong source for Yijing-style casting mechanics.
- `muyen/meihua-yishu`: Meihua Yishu skill/project designed for LLM use. Useful for AI-friendly 梅花易数 workflow and prompt structure.
- `kentang2017/kinliuren`: Python 大六壬 package for divination; simple and does not include all年月日時干支 evolution, so verify missing inputs.
- `hhszzzz/taibu`: Broad TypeScript AI metaphysics tool covering 八字, 紫微, 六爻, 梅花易数, 奇门, 大六壬, 小六壬, and Skills/MCP patterns.
- `ChesterRa/mingpan`: Traditional Chinese metaphysics MCP service with charting and divination capabilities; useful for agent integration patterns.
- `wangsquirrel/divicast`: LLM-friendly 六爻/八字 charting; useful for structured divination output.

Verify current APIs, licenses, and method coverage before using code. Many metaphysics repos encode one school only.

## Method Selection

- Use Zi Wei/Bazi for long-term life structure, temperament, and major cycles.
- Use Yijing/六爻 for a concrete question with a cast hexagram and moving lines.
- Use 梅花易数 when the user gives time, number, sound, object, direction, event omen, or wants quick image-number divination.
- Use 小六壬 for near-term, simple, pragmatic questions where fast directional judgment is enough.
- Use 大六壬 for formal event judgment when exact time, date, and method data are available.

Always state the selected method and why.

## Intake Checklist

Collect:

- Exact question, phrased as concretely as possible.
- Asking/casting time, time zone, and location if relevant.
- Method: three coins, yarrow, number/time-based, Meihua, Xiao Liuren, Da Liuren, screenshot, or already-generated chart.
- Raw result: 本卦, 变卦, 动爻; or Meihua 上卦/下卦/动爻; or Xiao Liuren palace; or Da Liuren 四课三传.
- Time horizon: today, this week, this month, this year, or open-ended.

If the question is vague, first refine the question.

## Meihua Yishu Workflow

Common Meihua methods use number/time/image to form trigrams:

1. Record the trigger: time, number, word count, object, sound, direction, or observed event.
2. Establish 上卦 and 下卦 using the chosen counting rule.
3. Determine 动爻.
4. Derive 本卦, 互卦, 变卦; optionally 错卦 and 综卦.
5. Identify 体卦 and 用卦.
6. Judge 生克:
   - 用生体: support comes to the querent.
   - 体生用: querent expends effort/resources.
   - 体克用: querent can control the matter.
   - 用克体: pressure/opposition acts on querent.
   - 体用比和: smoother, same kind, easier resonance.
7. Use 五行旺衰, season, image, and moving line for timing and detail.

Keep Meihua concrete and image-based. Do not turn it into a natal reading.

## Xiao Liuren Workflow

Small Liuren is a quick six-palace method. The six common states:

- 大安: stable, slow, generally favorable for waiting, safety, continuity.
- 留连: delay, entanglement, repeated back-and-forth, hard to finish quickly.
- 速喜: quick good news, pleasant movement, fast response.
- 赤口: argument, friction, words, injury, dispute, caution with speech.
- 小吉: small gain, helpful people, moderate favorable movement.
- 空亡: emptiness, loss, no result, false signal, delay, avoid forcing.

Workflow:

1. Confirm the counting rule used by the user/tool; Xiao Liuren schools differ.
2. Record the resulting palace.
3. Interpret by question type: lost item, message, relationship, money, travel, meeting, exam, negotiation.
4. Give short-range timing only, usually near-term.
5. If stakes are high, ask for a stronger method or real-world verification.

Do not overcomplicate Xiao Liuren. It is fast texture, not complete destiny.

## Da Liuren Workflow

Da Liuren is technical and school-dependent. Use only when enough chart data exists.

Core objects:

- 月将 and 占时.
- 天盘/地盘.
- 四课.
- 三传: 初传, 中传, 末传.
- 贵人 and twelve generals.
- 神将, 六亲, 旺相休囚, 刑冲破害, 空亡.

Workflow:

1. Verify time, date, and charting method.
2. Extract 四课三传 before interpretation.
3. Identify 用神 according to question.
4. Read 初传 as beginning/trigger, 中传 as process, 末传 as outcome tendency.
5. Judge help/obstruction through 神将, 生克, 空亡, 刑冲合害.
6. Give event-level guidance and timing ranges.

If only the question is provided and no Da Liuren chart can be calculated, do not fake 四课三传. Ask for chart data or use a simpler method with clear caveat.

## Cross-Method Synthesis

When multiple methods are used:

- Zi Wei/Bazi: long-term structure and personal pattern.
- Yijing/Meihua/Liuren: current moment and event direction.
- TCM symbolism: body-season-emotion image, not diagnosis.
- Psychology communication: how to act, speak, and regulate.

Resolve conflicts this way:

1. Prioritize the method designed for the question type.
2. Check whether time horizons differ.
3. Treat repeated themes across methods as higher confidence.
4. Treat isolated alarming signs as caution, not verdict.
5. Ask what real-world evidence already exists.

## Timing and Prediction Guardrails

- Use ranges: "within days/weeks", "before the next seasonal turn", "around the next visible checkpoint".
- Give conditional timing: "if you initiate", "if the other side responds", "if paperwork is complete".
- Never promise certainty.
- For medical, legal, financial, safety, or crisis topics, use divination only as reflection and point to appropriate professional action.

## Output Pattern

```text
问题确认
所用方法与原始起课数据
卦/课/宫位事实
核心判断
应期与条件
风险点
现实行动建议
娱乐研究提醒
```
