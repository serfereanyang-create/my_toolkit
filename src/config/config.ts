import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AppConfig, CliArgs, FileConfig, FileProfileConfig } from './types.js';
import type { ApprovalMode, ProviderName } from '../providers/types.js';

const defaultModels: Record<ProviderName, string> = {
  mock: 'mock-code-agent-v1',
  openai: 'gpt-5.5',
  anthropic: 'claude-3-5-sonnet-latest',
};

export async function loadConfig(args: CliArgs, env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  const workspaceRoot = resolve(args.workspace ?? process.cwd());
  const configPath = resolve(args.configPath ?? resolve(workspaceRoot, '.aicode/config.json'));
  const fileConfig = await readFileConfig(configPath);
  const profileName = args.profile ?? fileConfig.defaultProfile;
  const profileConfig = profileName ? fileConfig.profiles?.[profileName] : undefined;
  if (profileName && fileConfig.profiles && !profileConfig) throw new Error(`Profile not found in config: ${profileName}`);
  const mergedFileConfig = { ...withoutProfiles(fileConfig), ...profileConfig };

  const provider = args.provider ?? providerFromEnv(env) ?? mergedFileConfig.provider ?? 'openai';
  const model = args.model ?? env[`${provider.toUpperCase()}_MODEL`] ?? modelFromEnv(provider, env) ?? mergedFileConfig.model ?? defaultModels[provider];
  const sessionDir = resolve(workspaceRoot, args.sessionDir ?? env.AICODE_SESSION_DIR ?? mergedFileConfig.sessionDir ?? '.aicode/sessions');

  return {
    provider,
    model,
    baseUrl: args.baseUrl ?? baseUrlFromEnv(provider, env) ?? mergedFileConfig.baseUrl,
    apiKey: apiKeyFromEnv(provider, env) ?? mergedFileConfig.apiKey,
    approval: args.approval ?? approvalFromEnv(env) ?? mergedFileConfig.approval ?? 'ask',
    workspaceRoot,
    sessionDir,
    resumeSessionId: args.resumeSessionId,
    prompt: args.prompt,
    maxSteps: args.maxSteps ?? maxStepsFromEnv(env) ?? mergedFileConfig.maxSteps ?? 24,
    noBanner: args.noBanner ?? false,
    version: args.version ?? false,
    json: args.json ?? false,
    noColor: args.noColor ?? false,
    quiet: args.quiet ?? false,
    verbose: args.verbose ?? args.debug ?? false,
    debug: args.debug ?? false,
    ci: args.ci ?? false,
    noInput: args.noInput ?? false,
    configPath,
    profile: profileName,
    doctor: args.doctor ?? false,
    completionShell: args.completionShell,
    confirmPlan: args.confirmPlan ?? false,
    desktopBridge: args.desktopBridge ?? false,
  };
}

export function safeConfig(config: AppConfig) {
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: redactSecret(config.apiKey),
    approval: config.approval,
    workspaceRoot: config.workspaceRoot,
    sessionDir: config.sessionDir,
    configPath: config.configPath,
    profile: config.profile,
    maxSteps: config.maxSteps,
    json: config.json,
    noColor: config.noColor,
    quiet: config.quiet,
    verbose: config.verbose,
    debug: config.debug,
    ci: config.ci,
    noInput: config.noInput,
  };
}

export function requireProviderAuth(config: AppConfig) {
  if (config.provider === 'mock') return;
  if (config.apiKey) return;
  const variable = config.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  throw new Error(`${variable} is required for provider ${config.provider}. Set it in the environment or .aicode/config.json.`);
}

function providerFromEnv(env: NodeJS.ProcessEnv): ProviderName | undefined {
  const value = env.AICODE_PROVIDER;
  if (value === 'mock' || value === 'openai' || value === 'anthropic') return value;
  return undefined;
}

function approvalFromEnv(env: NodeJS.ProcessEnv): ApprovalMode | undefined {
  const value = env.AICODE_APPROVAL;
  if (value === 'ask' || value === 'auto' || value === 'deny') return value;
  return undefined;
}

function modelFromEnv(provider: ProviderName, env: NodeJS.ProcessEnv) {
  if (provider === 'openai') return env.OPENAI_MODEL;
  if (provider === 'anthropic') return env.ANTHROPIC_MODEL;
  return env.MOCK_MODEL;
}

function baseUrlFromEnv(provider: ProviderName, env: NodeJS.ProcessEnv) {
  if (provider === 'openai') return env.AICODE_OPENAI_BASE_URL ?? 'https://ai.furry.edu.gr/v1';
  if (provider === 'anthropic') return env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1';
  return undefined;
}

function apiKeyFromEnv(provider: ProviderName, env: NodeJS.ProcessEnv) {
  if (provider === 'openai') return env.OPENAI_API_KEY;
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY;
  return env.MOCK_API_KEY;
}

function maxStepsFromEnv(env: NodeJS.ProcessEnv) {
  if (!env.AICODE_MAX_STEPS) return undefined;
  const value = Number(env.AICODE_MAX_STEPS);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function readFileConfig(path: string): Promise<FileConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isRecord(parsed)) throw new Error('expected a JSON object');
    return normalizeFileConfig(parsed);
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw new Error(`Invalid config file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeFileConfig(input: Record<string, unknown>): FileConfig {
  const base = normalizeProfile(input);
  const defaultProfile = typeof input.defaultProfile === 'string' ? input.defaultProfile : undefined;
  const profiles = isRecord(input.profiles)
    ? Object.fromEntries(Object.entries(input.profiles).filter(([, value]) => isRecord(value)).map(([name, value]) => [name, normalizeProfile(value as Record<string, unknown>)]))
    : undefined;
  return { ...base, defaultProfile, profiles };
}

function normalizeProfile(input: Record<string, unknown>): FileProfileConfig {
  return {
    provider: providerValue(input.provider),
    model: typeof input.model === 'string' ? input.model : undefined,
    baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl : undefined,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey : undefined,
    approval: approvalValue(input.approval),
    sessionDir: typeof input.sessionDir === 'string' ? input.sessionDir : undefined,
    maxSteps: typeof input.maxSteps === 'number' && Number.isInteger(input.maxSteps) && input.maxSteps > 0 ? input.maxSteps : undefined,
  };
}

function withoutProfiles(config: FileConfig): FileProfileConfig {
  const { defaultProfile: _defaultProfile, profiles: _profiles, ...profile } = config;
  return profile;
}

function providerValue(value: unknown): ProviderName | undefined {
  return value === 'mock' || value === 'openai' || value === 'anthropic' ? value : undefined;
}

function approvalValue(value: unknown): ApprovalMode | undefined {
  return value === 'ask' || value === 'auto' || value === 'deny' ? value : undefined;
}

function redactSecret(value: string | undefined) {
  if (!value) return undefined;
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown) {
  return isRecord(error) && error.code === 'ENOENT';
}
