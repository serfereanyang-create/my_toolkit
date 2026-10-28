import { extractCommand } from '../dist/src/agent/commandExtract/extract.js';
import { planCommand } from '../dist/src/agent/commandExtract/plan.js';

const prompts = [
  '有上下文记忆缓存吗，我感觉缓存命中上不去',
  '？、',
  '你现在和codex比较呢',
  '而且我感觉你没有那种强联系的上下文，老是莫名其妙就不做思考一下子回复或者失败',
  '查看缓存',
  '解释一下缓存命中率',
];

for (const p of prompts) {
  try {
    const ex = extractCommand(p);
    const plan = planCommand(ex);
    console.log(JSON.stringify({
      prompt: p,
      intent: ex.intent,
      confidence: ex.confidence,
      reasons: ex.reasons,
      mode: plan.mode,
      steps: plan.steps.map((s) => s.tool),
    }));
  } catch (error) {
    console.log(JSON.stringify({ prompt: p, error: String(error) }));
  }
}
