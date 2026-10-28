import { extractCommand } from '../dist/src/agent/commandExtract/extract.js';
import { planCommand } from '../dist/src/agent/commandExtract/plan.js';

// The real prompts of this session, in order.
const prompts = [
  '和codex最新版比较下',
  '你为啥每次都压缩失败',
  '你自动压缩一下',
  '你现在和codex比较呢',
  '有上下文记忆缓存吗，我感觉缓存命中上不去',
  '？、',
  '而且我感觉你没有那种强联系的上下文，老是莫名其妙就不做思考一下子回复或者失败',
];

for (const p of prompts) {
  const ex = extractCommand(p);
  const plan = planCommand(ex);
  console.log(JSON.stringify({
    prompt: p,
    intent: ex.intent,
    confidence: ex.confidence,
    mode: plan.mode,
    directTools: plan.steps.map((s) => s.tool),
    reasons: ex.reasons,
  }));
}
