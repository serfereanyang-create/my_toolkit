import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AppConfig, CliArgs, FileConfig, FileProfileConfig } from './types.js';
import type { ApprovalMode, ProviderName, ReasoningEffort } from '../providers/types.js';
import type { ToolScope } from '../tools/scope.js';
import { VENDOR_PROFILES, firstEnv, isVendorId } from '../providers/vendors.js';

const defaultModels: Record<ProviderName, string> = {
  mock: 'mock-code-agent-v1',
  openai: 'gpt-5.5',
  'openai-responses': 'gpt-5.5',
  anthropic: 'claude-3-5-sonnet-latest',
  gemini: 'gemini-2.5-flash',
  grok: VENDOR_PROFILES.grok.defaultModel,
  glm: VENDOR_PROFILES.glm.defaultModel,
  kimi: VENDOR_PROFILES.kimi.defaultModel,
  deepseek: VENDOR_PROFILES.deepseek.defaultModel,
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
  const model = args.model
    ?? env[`${provider.toUpperCase()}_MODEL`]
    ?? vendorModelFromEnv(provider, env)
    ?? modelFromEnv(provider, env)
    ?? mergedFileConfig.model
    ?? defaultModels[provider];
  const sessionDir = resolve(workspaceRoot, args.sessionDir ?? env.AICODE_SESSION_DIR ?? mergedFileConfig.sessionDir ?? '.aicode/sessions');

  return {
    provider,
    model,
    baseUrl: args.baseUrl ?? baseUrlFromEnv(provider, env) ?? mergedFileConfig.baseUrl,
    customProvider: args.customProvider ?? false,
    computerAnyApp: args.computerAnyApp ?? false,
    excelAutomation: args.excelAutomation ?? false,
    allowedApps: args.allowedApps,
    apiKey: apiKeyFromEnv(provider, env) ?? mergedFileConfig.apiKey,
    approval: args.approval ?? approvalFromEnv(env) ?? mergedFileConfig.approval ?? 'ask',
    workspaceRoot,
    sessionDir,
    resumeSessionId: args.resumeSessionId,
    prompt: args.prompt,
    maxSteps: args.maxSteps ?? maxStepsFromEnv(env) ?? mergedFileConfig.maxSteps,
    maxTokens: args.maxTokens ?? maxTokensFromEnv(env) ?? mergedFileConfig.maxTokens,
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
    invokeTool: args.invokeTool,
    toolInput: args.toolInput,
    completionShell: args.completionShell,
    confirmPlan: args.confirmPlan ?? false,
    desktopBridge: args.desktopBridge ?? false,
    usageLog: args.usageLog ?? env.AICODE_USAGE_LOG,
    reasoningEffort: args.reasoningEffort ?? reasoningEffortFromEnv(env) ?? mergedFileConfig.reasoningEffort,
    toolScope: args.toolScope ?? toolScopeFromEnv(env) ?? mergedFileConfig.toolScope,
    network: resolveNetworkConfig(env, mergedFileConfig),
  };
}

// A conservative default allowlist of read-only reference sources. Users extend
// this via .aicode/config.json `network.allowlist` or AICODE_NETWORK_ALLOWLIST.
const DEFAULT_NETWORK_ALLOWLIST = [
  'wikipedia.org',
  'developer.mozilla.org',
  'api.github.com',
  'raw.githubusercontent.com',
  'pypi.org',
  'registry.npmjs.org',
  // Search endpoint used by the web_search tool (DuckDuckGo HTML, no API key).
  'duckduckgo.com',
];

function resolveNetworkConfig(
  env: NodeJS.ProcessEnv,
  fileConfig: FileProfileConfig,
): { enabled: boolean; allowlist: string[] } {
  const envFlag = env.AICODE_NETWORK;
  const disabledByEnv = envFlag === '0' || envFlag === 'false' || envFlag === 'off';
  const enabled = disabledByEnv ? false : fileConfig.network?.enabled ?? true;
  const envList = env.AICODE_NETWORK_ALLOWLIST
    ? env.AICODE_NETWORK_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  const fileList = fileConfig.network?.allowlist;
  const allowlist = envList ?? (fileList && fileList.length ? fileList : DEFAULT_NETWORK_ALLOWLIST);
  return { enabled, allowlist };
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
    maxTokens: config.maxTokens,
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
  const variable = isVendorId(config.provider)
    ? VENDOR_PROFILES[config.provider].apiKeyEnvVars[0]
    : config.provider === 'openai' || config.provider === 'openai-responses'
      ? 'OPENAI_API_KEY'
      : config.provider === 'anthropic'
        ? 'ANTHROPIC_API_KEY'
        : 'GEMINI_API_KEY';
  throw new Error(`${variable} is required for provider ${config.provider}. Set it in the environment or .aicode/config.json.`);
}

function providerFromEnv(env: NodeJS.ProcessEnv): ProviderName | undefined {
  const value = env.AICODE_PROVIDER;
  if (value && isVendorId(value)) return value;
  if (value === 'mock' || value === 'openai' || value === 'openai-responses' || value === 'anthropic' || value === 'gemini') return value;
  return undefined;
}

function approvalFromEnv(env: NodeJS.ProcessEnv): ApprovalMode | undefined {
  const value = env.AICODE_APPROVAL;
  if (value === 'ask' || value === 'auto' || value === 'deny') return value;
  return undefined;
}

function reasoningEffortFromEnv(env: NodeJS.ProcessEnv): ReasoningEffort | undefined {
  const value = env.AICODE_REASONING_EFFORT;
  if (value === 'auto' || value === 'off' || value === 'low' || value === 'medium' || value === 'high' || value === 'max') return value;
  return undefined;
}

function toolScopeFromEnv(env: NodeJS.ProcessEnv): ToolScope | undefined {
  const value = env.AICODE_TOOL_SCOPE;
  if (value === 'auto' || value === 'compact' || value === 'standard' || value === 'full') return value;
  return undefined;
}

function modelFromEnv(provider: ProviderName, env: NodeJS.ProcessEnv) {
  if (provider === 'openai-responses') return env.OPENAI_RESPONSES_MODEL ?? env.OPENAI_MODEL;
  if (provider === 'openai') return env.OPENAI_MODEL;
  if (provider === 'anthropic') return env.ANTHROPIC_MODEL;
  return env.MOCK_MODEL;
}

/** 厂商档案的多名环境变量（XAI/GROK、ZHIPU/GLM、MOONSHOT/KIMI 等）。 */
function vendorModelFromEnv(provider: ProviderName, env: NodeJS.ProcessEnv) {
  if (!isVendorId(provider)) return undefined;
  return firstEnv(VENDOR_PROFILES[provider].modelEnvVars, env);
}

function baseUrlFromEnv(provider: ProviderName, env: NodeJS.ProcessEnv) {
  if (isVendorId(provider)) {
    const vendor = VENDOR_PROFILES[provider];
    return env[`${provider.toUpperCase()}_BASE_URL`] ?? vendor.defaultBaseUrl;
  }
  if (provider === 'openai-responses') return env.OPENAI_RESPONSES_BASE_URL ?? env.AICODE_OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  if (provider === 'openai') return env.AICODE_OPENAI_BASE_URL ?? 'https://ai.furry.edu.gr/v1';
  if (provider === 'anthropic') return env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1';
  return undefined;
}

function apiKeyFromEnv(provider: ProviderName, env: NodeJS.ProcessEnv) {
  if (isVendorId(provider)) return firstEnv(VENDOR_PROFILES[provider].apiKeyEnvVars, env);
  if (provider === 'openai' || provider === 'openai-responses') return env.OPENAI_API_KEY;
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY;
  return env.MOCK_API_KEY;
}

function maxStepsFromEnv(env: NodeJS.ProcessEnv) {
  if (!env.AICODE_MAX_STEPS) return undefined;
  const value = Number(env.AICODE_MAX_STEPS);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function maxTokensFromEnv(env: NodeJS.ProcessEnv) {
  if (!env.AICODE_MAX_TOKENS) return undefined;
  const value = Number(env.AICODE_MAX_TOKENS);
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

function reasoningEffortValue(value: unknown): ReasoningEffort | undefined {
  return value === 'auto' || value === 'off' || value === 'low' || value === 'medium' || value === 'high' || value === 'max' ? value : undefined;
}

function normalizeProfile(input: Record<string, unknown>): FileProfileConfig {
  return {
    provider: providerValue(input.provider),
    model: typeof input.model === 'string' ? input.model : undefined,
    baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl : undefined,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey : undefined,
    approval: approvalValue(input.approval),
    reasoningEffort: reasoningEffortValue(input.reasoningEffort),
    sessionDir: typeof input.sessionDir === 'string' ? input.sessionDir : undefined,
    maxSteps: typeof input.maxSteps === 'number' && Number.isInteger(input.maxSteps) && input.maxSteps > 0 ? input.maxSteps : undefined,
    maxTokens: typeof input.maxTokens === 'number' && Number.isInteger(input.maxTokens) && input.maxTokens > 0 ? input.maxTokens : undefined,
    toolScope: toolScopeValue(input.toolScope),
    network: normalizeNetwork(input.network),
  };
}

function toolScopeValue(value: unknown): ToolScope | undefined {
  return value === 'auto' || value === 'compact' || value === 'standard' || value === 'full' ? value : undefined;
}

function normalizeNetwork(value: unknown): { enabled?: boolean; allowlist?: string[] } | undefined {
  if (!isRecord(value)) return undefined;
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : undefined;
  const allowlist = Array.isArray(value.allowlist)
    ? value.allowlist.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  if (enabled === undefined && allowlist === undefined) return undefined;
  return { enabled, allowlist };
}

function withoutProfiles(config: FileConfig): FileProfileConfig {
  const { defaultProfile: _defaultProfile, profiles: _profiles, ...profile } = config;
  return profile;
}

function providerValue(value: unknown): ProviderName | undefined {
  return typeof value === 'string' && (value === 'mock' || value === 'openai' || value === 'openai-responses' || value === 'anthropic' || value === 'gemini' || isVendorId(value)) ? value as ProviderName : undefined;
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
