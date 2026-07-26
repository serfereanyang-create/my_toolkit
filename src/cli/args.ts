import { resolve } from 'node:path';
import type { CliArgs } from '../config/types.js';
import type { ApprovalMode, ProviderName } from '../providers/types.js';

const providerNames = new Set(['mock', 'openai', 'anthropic']);
const approvalModes = new Set(['ask', 'auto', 'deny']);

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
      case '--approval': {
        const value = readValue();
        if (!approvalModes.has(value)) throw new Error(`Unsupported approval mode: ${value}`);
        args.approval = value as ApprovalMode;
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
      case '--doctor':
        args.doctor = true;
        args.noBanner = true;
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
