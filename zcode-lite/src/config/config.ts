import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { CliArgs } from '../cli/args.js';
import type { AppConfig, FileConfig, ProviderName } from './types.js';

const vendorDefaults: Record<ProviderName, { model: string; baseUrl: string; keys: string[] }> = {
  mock: { model: 'mock-1', baseUrl: 'mock://local', keys: [] }, openai: { model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', keys: ['OPENAI_API_KEY'] },
  grok: { model: 'grok-2-latest', baseUrl: 'https://api.x.ai/v1', keys: ['GROK_API_KEY', 'XAI_API_KEY'] }, glm: { model: 'glm-4-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keys: ['ZHIPU_API_KEY', 'GLM_API_KEY', 'ZAI_API_KEY'] },
  kimi: { model: 'moonshot-v1-8k', baseUrl: 'https://api.moonshot.cn/v1', keys: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'] }, deepseek: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', keys: ['DEEPSEEK_API_KEY'] },
  anthropic: { model: 'claude-3-5-haiku-latest', baseUrl: 'https://api.anthropic.com', keys: ['ANTHROPIC_API_KEY'] },
};
export function defaultConfigPath(): string { return path.join(process.cwd(), '.zcode-lite', 'config.json'); }
export async function loadFileConfig(file = defaultConfigPath()): Promise<FileConfig> {
  try { const raw: unknown = JSON.parse(await readFile(file, 'utf8')); if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config must be an object'); return raw as FileConfig; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error(`Cannot read config: ${error instanceof Error ? error.message : String(error)}`); }
}
export async function saveFileConfig(config: FileConfig, file = defaultConfigPath()): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8'); }
export async function resolveConfig(args: CliArgs, env = process.env): Promise<AppConfig> {
  const file = await loadFileConfig(); const provider = (args.provider ?? env.ZCL_PROVIDER ?? file.provider ?? 'mock') as ProviderName;
  if (!(provider in vendorDefaults)) throw new Error(`Unsupported provider: ${provider}`);
  const vendor = vendorDefaults[provider]; const saved = file.providers?.[provider] ?? {}; const apiKey = args.apiKey ?? env.ZCL_API_KEY ?? saved.apiKey ?? file.apiKey ?? vendor.keys.map(k => env[k]).find(Boolean);
  const maxSteps = args.maxSteps ?? numberEnv(env.ZCL_MAX_STEPS) ?? file.maxSteps ?? 24; if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new Error('maxSteps must be an integer from 1 to 100');
  const approval = args.approval ?? (env.ZCL_APPROVAL as AppConfig['approval'] | undefined) ?? file.approval ?? 'ask'; if (!['ask', 'auto', 'deny'].includes(approval)) throw new Error('approval must be ask, auto, or deny');
  return { provider, model: args.model ?? env.ZCL_MODEL ?? saved.model ?? file.model ?? vendor.model, baseUrl: args.baseUrl ?? env.ZCL_BASE_URL ?? saved.baseUrl ?? file.baseUrl ?? vendor.baseUrl, apiKey, approval, workspaceRoot: path.resolve(args.workspace ?? env.ZCL_WORKSPACE ?? file.workspaceRoot ?? process.cwd()), maxSteps, networkAllowlist: file.networkAllowlist ?? splitEnv(env.ZCL_NETWORK_ALLOWLIST) };
}
function numberEnv(value: string | undefined): number | undefined { return value === undefined ? undefined : Number(value); }
function splitEnv(value: string | undefined): string[] { return value ? value.split(',').map(x => x.trim()).filter(Boolean) : []; }
export { vendorDefaults };
