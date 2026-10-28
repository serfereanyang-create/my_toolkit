// 复现：哪些提问会被"直接执行"路径接管，从而根本不调模型。
import { extractCommand } from '../dist/src/agent/commandExtract/extract.js';
import { planCommand } from '../dist/src/agent/commandExtract/plan.js';

const prompts = [
  '有上下文记忆缓存吗，我感觉缓存命中上不去',
  '？、',
  '而且我感觉你没有那种强联系的上下文，老是莫名其妙就不做思考一下子回复或者失败',
  '你现在和codex比较呢',
  '为啥每次都压缩失败',
];

for (const prompt of prompts) {
  const extraction = extractCommand(prompt);
  const plan = planCommand(extraction);
  console.log(JSON.stringify({
    prompt,
    intent: extraction.intent,
    confidence: extraction.confidence,
    reasons: extraction.reasons,
    mode: plan.mode,
    steps: plan.steps.map((s) => `${s.tool}(${Object.keys(s.input).join(',')})`),
    modelIsSkipped: plan.mode === 'execute',
  }, null, 2));
}
