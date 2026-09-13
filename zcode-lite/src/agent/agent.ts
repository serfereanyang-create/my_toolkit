import type { AppConfig } from '../config/types.js';
import type { Provider, ChatMessage, ToolExecution } from '../providers/types.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
export type AgentResult = { text: string; steps: number; toolExecutions: ToolExecution[]; stoppedByLimit: boolean };
export class Agent {
  constructor(private readonly provider: Provider, private readonly tools: ToolRegistry, private readonly config: AppConfig, private readonly context: ToolContext) {}
  async run(prompt: string): Promise<AgentResult> {
    const messages: ChatMessage[] = [{ role: 'system', content: 'You are ZCode-lite. Use tools when needed. Keep answers concise.' }, { role: 'user', content: prompt }]; const executions: ToolExecution[] = [];
    for (let step = 0; step < this.config.maxSteps; step++) { const response = await this.provider.complete(messages, this.tools.definitions()); if (!response.toolCalls.length) return { text: response.text, steps: step + 1, toolExecutions: executions, stoppedByLimit: false }; messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls }); for (const call of response.toolCalls) { const result = await this.tools.execute(call, this.context, this.config.approval); executions.push({ call, result }); messages.push({ role: 'tool', toolCallId: call.id, content: result.output }); } }
    return { text: `Stopped after reaching maxSteps (${this.config.maxSteps}).`, steps: this.config.maxSteps, toolExecutions: executions, stoppedByLimit: true };
  }
}
