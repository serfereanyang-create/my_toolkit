import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvider } from '../providers/index.js';
import type { AppConfig } from '../config/types.js';
import { createDefaultToolRegistry } from '../tools/index.js';
import { runAgentTurn } from '../agent/agent.js';
import { SessionStore } from '../session/store.js';
import { TerminalUI } from '../ui/terminal.js';
import type { ProviderName } from '../providers/types.js';

export type LiveSmokeResult = {
  status: 'skipped' | 'passed' | 'failed';
  detail: string;
  provider?: ProviderName;
  model?: string;
};

export function resolveLiveSmokePlan(env: NodeJS.ProcessEnv = process.env): {
  mode: 'skip' | 'run';
  provider: ProviderName;
  reason: string;
} {
  const forced = (env.AICODE_LIVE_SMOKE ?? '').trim().toLowerCase();
  if (forced === '0' || forced === 'false' || forced === 'off' || forced === 'skip') {
    return { mode: 'skip', provider: 'mock', reason: 'AICODE_LIVE_SMOKE disabled live smoke.' };
  }

  const preferred = (env.AICODE_PROVIDER ?? '').trim().toLowerCase();
  if (preferred === 'anthropic' || env.ANTHROPIC_API_KEY) {
    if (!env.ANTHROPIC_API_KEY) {
      if (forced === '1' || forced === 'true' || forced === 'on') {
        return { mode: 'run', provider: 'anthropic', reason: 'ANTHROPIC_API_KEY required but missing.' };
      }
      return { mode: 'skip', provider: 'anthropic', reason: 'ANTHROPIC_API_KEY not set; skipping live smoke.' };
    }
    return { mode: 'run', provider: 'anthropic', reason: 'Using Anthropic credentials.' };
  }

  if (preferred === 'openai' || env.OPENAI_API_KEY || !preferred) {
    if (!env.OPENAI_API_KEY) {
      if (forced === '1' || forced === 'true' || forced === 'on') {
        return { mode: 'run', provider: 'openai', reason: 'OPENAI_API_KEY required but missing.' };
      }
      return { mode: 'skip', provider: 'openai', reason: 'OPENAI_API_KEY not set; skipping live smoke.' };
    }
    return { mode: 'run', provider: 'openai', reason: 'Using OpenAI-compatible credentials.' };
  }

  return { mode: 'skip', provider: 'mock', reason: 'No hosted provider credentials found; skipping live smoke.' };
}

export async function runLiveSmoke(env: NodeJS.ProcessEnv = process.env): Promise<LiveSmokeResult> {
  const plan = resolveLiveSmokePlan(env);
  if (plan.mode === 'skip') {
    return { status: 'skipped', detail: plan.reason, provider: plan.provider };
  }

  if ((plan.provider === 'openai' && !env.OPENAI_API_KEY) || (plan.provider === 'anthropic' && !env.ANTHROPIC_API_KEY)) {
    return { status: 'failed', detail: plan.reason, provider: plan.provider };
  }

  const workspace = await mkdtemp(join(tmpdir(), 'aicode-live-smoke-'));
  const sessionDir = join(workspace, '.aicode', 'sessions');
  try {
    await writeFile(join(workspace, 'package.json'), `${JSON.stringify({ name: 'aicode-live-smoke', private: true }, null, 2)}\n`, 'utf8');
    await writeFile(join(workspace, 'LIVE_SMOKE.md'), '# live smoke fixture\nmarker: AICODE_LIVE_SMOKE_OK\n', 'utf8');

    const config: AppConfig = {
      provider: plan.provider,
      model: plan.provider === 'openai'
        ? (env.OPENAI_MODEL ?? 'gpt-5.5')
        : (env.ANTHROPIC_MODEL ?? 'claude-3-5-sonnet-latest'),
      baseUrl: plan.provider === 'openai'
        ? (env.AICODE_OPENAI_BASE_URL ?? 'https://ai.furry.edu.gr/v1')
        : (env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1'),
      apiKey: plan.provider === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY,
      approval: 'auto',
      workspaceRoot: workspace,
      sessionDir,
      maxSteps: 8,
      noBanner: true,
      quiet: true,
      noColor: true,
      json: false,
      confirmPlan: false,
    };

    const provider = createProvider(config);
    const tools = createDefaultToolRegistry();
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({
      provider: provider.name,
      model: provider.model,
      workspaceRoot: workspace,
    });
    const ui = new TerminalUI({ quiet: true, noColor: true });

    // 1) Direct provider probe: native tools / stream path should yield a tool action or readable text.
    const probe = await provider.complete({
      messages: [{
        role: 'user',
        content: 'Use the read_file tool to read LIVE_SMOKE.md. Return only a tool call.',
        createdAt: new Date().toISOString(),
      }],
      tools: tools.specs().filter((tool) => tool.name === 'read_file' || tool.name === 'list_files'),
      workspaceRoot: workspace,
      toolStrategy: 'Tool strategy:\nintent=file_read\nrecommended=read_file',
    });

    const hasTool = probe.actions.some((action) => action.type === 'tool' && action.tool === 'read_file');
    if (!hasTool) {
      return {
        status: 'failed',
        detail: `Provider ${provider.name}/${provider.model} did not return a read_file tool call. actions=${JSON.stringify(probe.actions).slice(0, 400)}`,
        provider: provider.name,
        model: provider.model,
      };
    }

    // 2) Full agent turn on a tiny natural-language read request.
    const turn = await runAgentTurn({
      config,
      provider,
      tools,
      sessions,
      session,
      ui,
    }, '请读取 LIVE_SMOKE.md 并告诉我 marker 是什么');

    const toolCalls = session.toolCalls.map((call) => call.tool);
    const readOk = session.toolCalls.some((call) => call.tool === 'read_file' && call.ok);
    if (!turn.ok && !readOk) {
      return {
        status: 'failed',
        detail: `Agent turn failed without a successful read_file: ${turn.reason ?? 'unknown'} tools=${toolCalls.join(',')}`,
        provider: provider.name,
        model: provider.model,
      };
    }

    // Best-effort content check if the file was read.
    if (readOk) {
      const content = await readFile(join(workspace, 'LIVE_SMOKE.md'), 'utf8');
      if (!content.includes('AICODE_LIVE_SMOKE_OK')) {
        return {
          status: 'failed',
          detail: 'Fixture marker missing from LIVE_SMOKE.md after live smoke.',
          provider: provider.name,
          model: provider.model,
        };
      }
    }

    return {
      status: 'passed',
      detail: `Live smoke passed via ${provider.name}/${provider.model}; tools=${toolCalls.join(',') || 'provider-only'}; agentOk=${turn.ok}`,
      provider: provider.name,
      model: provider.model,
    };
  } catch (error) {
    return {
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
      provider: plan.provider,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}
