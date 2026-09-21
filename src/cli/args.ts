import { resolve } from 'node:path';
import type { CliArgs } from '../config/types.js';
import type { ApprovalMode, ProviderName } from '../providers/types.js';
import type { ToolScope } from '../tools/scope.js';

const providerNames = new Set(['mock', 'openai', 'openai-responses', 'anthropic', 'gemini', 'grok', 'glm', 'kimi', 'deepseek']);
const approvalModes = new Set(['ask', 'auto', 'deny', 'plan']);
const toolScopes = new Set(['auto', 'compact', 'standard', 'full']);

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (index === 0 && arg === 'completion') {
      const shell = argv[index + 1];
      if (shell !== 'bash' && shell !== 'zsh' && shell !== 'fish' && shell !== 'powershell') throw new Error('completion requires one of: bash, zsh, fish, powershell');
      args.completionShell = shell;
      args.noBanner = true;
      index += 1;
      continue;
    }
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--provider': {
        const value = readValue();
        if (!providerNames.has(value)) throw new Error(`Unsupported provider: ${value}`);
        args.provider = value as ProviderName;
        break;
      }
      case '--model':
        args.model = readValue();
        break;
      case '--base-url':
        args.baseUrl = readValue();
        break;
      case '--custom-provider':
        args.customProvider = true;
        break;
      case '--computer-any-app':
        args.computerAnyApp = true;
        break;
      case '--excel':
        args.excelAutomation = true;
        break;
      case '--allowed-apps': {
        const value = readValue();
        args.allowedApps = value.split(',').map((item) => item.trim()).filter(Boolean);
        break;
      }
      case '--reasoning-effort': {
        const value = readValue();
        if (value !== 'auto' && value !== 'off' && value !== 'low' && value !== 'medium' && value !== 'high' && value !== 'max') {
          throw new Error(`--reasoning-effort must be one of: auto, off, low, medium, high, max`);
        }
        args.reasoningEffort = value;
        break;
      }
      case '--approval': {
        const value = readValue();
        if (!approvalModes.has(value)) throw new Error(`Unsupported approval mode: ${value}`);
        args.approval = value as ApprovalMode;
        break;
      }
      case '--tool-scope': {
        const value = readValue();
        if (!toolScopes.has(value)) throw new Error(`--tool-scope must be one of: auto, compact, standard, full`);
        args.toolScope = value as ToolScope;
        break;
      }
      case '--workspace':
        args.workspace = resolve(readValue());
        break;
      case '--session-dir':
        args.sessionDir = readValue();
        break;
      case '--config':
        args.configPath = resolve(readValue());
        break;
      case '--profile':
        args.profile = readValue();
        break;
      case '--resume':
        args.resumeSessionId = readValue();
        break;
      case '--prompt':
        args.prompt = readValue();
        break;
      case '--max-steps': {
        const value = Number(readValue());
        if (!Number.isInteger(value) || value < 1) throw new Error('--max-steps must be a positive integer');
        args.maxSteps = value;
        break;
      }
      case '--max-tokens': {
        const value = Number(readValue());
        if (!Number.isInteger(value) || value < 1) throw new Error('--max-tokens must be a positive integer');
        args.maxTokens = value;
        break;
      }
      case '--no-banner':
        args.noBanner = true;
        break;
      case '--version':
      case '-v':
        args.version = true;
        args.noBanner = true;
        break;
      case '--json':
        args.json = true;
        args.noBanner = true;
        break;
      case '--no-color':
        args.noColor = true;
        break;
      case '--quiet':
      case '-q':
        args.quiet = true;
        args.noBanner = true;
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '--debug':
        args.debug = true;
        // Debug implies expanded process traces.
        args.verbose = true;
        break;
      case '--ci':
        args.ci = true;
        args.noInput = true;
        args.noBanner = true;
        break;
      case '--no-input':
        args.noInput = true;
        break;
      case '--confirm-plan':
        args.confirmPlan = true;
        break;
      case '--desktop-bridge':
        args.desktopBridge = true;
        args.json = true;
        args.noBanner = true;
        args.noInput = true;
        break;
      case '--usage-log':
        args.usageLog = readValue();
        break;
      case '--doctor':
        args.doctor = true;
        args.noBanner = true;
        break;
      case '--invoke-tool': {
        // Headless single-tool mode for host integrations (e.g. the desktop
        // quality gateway). Only read-risk tools are allowed; see index.ts.
        const value = readValue();
        if (!value.trim()) throw new Error('--invoke-tool requires a tool name');
        args.invokeTool = value.trim();
        args.noBanner = true;
        break;
      }
      case '--tool-input':
        // Inline JSON, or '-' to read the JSON payload from stdin.
        args.toolInput = readValue();
        break;
      case '--help':
      case '-h':
        args.prompt = '/help';
        args.noBanner = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}
