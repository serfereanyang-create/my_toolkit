import type { ApprovalMode, ProviderName } from '../config/types.js';

export type CliArgs = {
  prompt?: string; provider?: ProviderName; model?: string; baseUrl?: string; apiKey?: string;
  approval?: ApprovalMode; workspace?: string; maxSteps?: number; json: boolean; help: boolean;
};
const providers = new Set<ProviderName>(['mock', 'openai', 'grok', 'glm', 'kimi', 'deepseek', 'anthropic']);
const approvals = new Set<ApprovalMode>(['ask', 'auto', 'deny']);

export function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = { json: false, help: false };
  const take = (i: number, flag: string): string => {
    const value = argv[i + 1]; if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`); return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-p' || arg === '--prompt') { result.prompt = take(i, arg); i++; }
    else if (arg === '--provider') { const v = take(i, arg) as ProviderName; if (!providers.has(v)) throw new Error(`Unsupported provider: ${v}`); result.provider = v; i++; }
    else if (arg === '--model') { result.model = take(i, arg); i++; }
    else if (arg === '--base-url') { result.baseUrl = take(i, arg); i++; }
    else if (arg === '--api-key') { result.apiKey = take(i, arg); i++; }
    else if (arg === '--approval') { const v = take(i, arg) as ApprovalMode; if (!approvals.has(v)) throw new Error(`Invalid approval mode: ${v}`); result.approval = v; i++; }
    else if (arg === '--workspace') { result.workspace = take(i, arg); i++; }
    else if (arg === '--max-steps') { const v = Number(take(i, arg)); if (!Number.isInteger(v) || v < 1 || v > 100) throw new Error('--max-steps must be an integer from 1 to 100'); result.maxSteps = v; i++; }
    else if (arg === '--json') result.json = true;
    else if (arg === '-h' || arg === '--help') result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

export const helpText = `zcode-lite [options]\n\nOptions:\n  -p, --prompt <text>       Run one prompt and exit\n  --provider <name>         mock, openai, grok, glm, kimi, deepseek, anthropic\n  --model <id>              Override provider model\n  --base-url <url>          Override API base URL\n  --api-key <key>           Override API key (never displayed)\n  --approval <ask|auto|deny> Tool approval policy\n  --workspace <path>        Workspace root (defaults to cwd)\n  --max-steps <n>           Tool-loop limit (1-100; default 24)\n  --json                    Emit JSON result in one-shot mode\n  -h, --help                Show this help`;
