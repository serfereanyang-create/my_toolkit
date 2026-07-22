import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDefaultToolRegistry } from '../tools/index.js';
import { isAutoAllowedCommand, isBlockedCommand, isInsideWorkspace } from '../safety/policy.js';
import { createMockProvider } from '../providers/mock.js';

export type AuditResult = {
  total: number;
  passed: number;
  failures: string[];
};

type AuditOptions = {
  print?: boolean;
};

type Check = {
  name: string;
  run: () => boolean | Promise<boolean>;
};

export async function runAuditChecks(root = process.cwd(), options: AuditOptions = { print: true }): Promise<AuditResult> {
  const checks = buildChecks(root);
  const failures: string[] = [];
  for (const check of checks) {
    try {
      const ok = await check.run();
      if (!ok) failures.push(check.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${check.name}: ${message}`);
    }
  }
  const result = { total: checks.length, passed: checks.length - failures.length, failures };
  if (options.print !== false) {
    process.stdout.write(`audit checks: ${result.passed}/${result.total} passed\n`);
    if (failures.length > 0) {
      process.stdout.write(failures.map((failure) => `FAIL ${failure}`).join('\n') + '\n');
    }
  }
  return result;
}

function buildChecks(root: string): Check[] {
  const checks: Check[] = [];
  const file = (path: string) => join(root, path);
  const exists = async (path: string) => access(file(path)).then(() => true, () => false);
  const text = async (path: string) => readFile(file(path), 'utf8');
  const contains = async (path: string, needle: string) => (await text(path)).includes(needle);

  const requiredFiles = [
    'package.json',
    'tsconfig.json',
    'README.md',
    'docs/capability-matrix.md',
    'src/index.ts',
    'src/cli/args.ts',
    'src/cli/completion.ts',
    'src/cli/doctor.ts',
    'src/cli/commands.ts',
    'src/cli/repl.ts',
    'src/ui/terminal.ts',
    'src/agent/agent.ts',
    'src/agent/context.ts',
    'src/agent/contextBudget.ts',
    'src/agent/fallback.ts',
    'src/agent/toolStrategy.ts',
    'src/agent/commandExtract/types.ts',
    'src/agent/commandExtract/extract.ts',
    'src/agent/commandExtract/plan.ts',
    'src/agent/commandExtract/format.ts',
    'src/agent/commandExtract/execute.ts',
    'src/agent/commandExtract/index.ts',
    'src/providers/types.ts',
    'src/providers/mock.ts',
    'src/providers/openai.ts',
    'src/providers/anthropic.ts',
    'src/providers/protocol.ts',
    'src/providers/index.ts',
    'src/tools/types.ts',
    'src/tools/activity.ts',
    'src/tools/registry.ts',
    'src/tools/files.ts',
    'src/tools/git.ts',
    'src/tools/growth.ts',
    'src/tools/search.ts',
    'src/tools/shell.ts',
    'src/tools/docx.ts',
    'src/tools/disk.ts',
    'src/tools/environment.ts',
    'src/tools/rename.ts',
    'src/tools/patch.ts',
    'src/tools/process.ts',
    'src/tools/projectIndex.ts',
    'src/tools/index.ts',
    'src/guard/types.ts',
    'src/guard/lazyDevGuard.ts',
    'src/guard/rules.ts',
    'src/guard/domainRegistry.ts',
    'src/session/checkpoint.ts',
    'src/session/store.ts',
    'src/tasks/types.ts',
    'src/tasks/store.ts',
    'src/tasks/planner.ts',
    'src/tasks/runtime.ts',
    'src/tasks/completion.ts',
    'src/tasks/verify.ts',
    'src/nav/types.ts',
    'src/nav/ignore.ts',
    'src/nav/extract.ts',
    'src/nav/store.ts',
    'src/nav/query.ts',
    'src/tools/nav.ts',
    'src/memory/types.ts',
    'src/memory/store.ts',
    'src/memory/extract.ts',
    'src/memory/select.ts',
    'src/memory/format.ts',
    'src/memory/record.ts',
    'src/git-safety/types.ts',
    'src/git-safety/git.ts',
    'src/git-safety/audit.ts',
    'src/git-safety/repository.ts',
    'src/git-safety/snapshot.ts',
    'src/git-safety/diff.ts',
    'src/git-safety/service.ts',
    'src/git-safety/rollback.ts',
    'src/git-safety/publisher.ts',
    'src/git-safety/format.ts',
    'src/git-safety/workflow.ts',
    'src/config/config.ts',
    'src/config/types.ts',
    'src/hooks/hooks.ts',
    'src/plugins/manifest.ts',
    'src/plugins/loader.ts',
    'src/safety/policy.ts',
    'src/audit/checks.ts',
    'tests/cli-process.test.ts',
    'tests/activity.test.ts',
    'tests/config.test.ts',
    'tests/context.test.ts',
    'tests/context-budget.test.ts',
    'tests/plugins.test.ts',
    'tests/process.test.ts',
    'tests/smoke.test.ts',
    'tests/terminal-ui.test.ts',
    'tests/approval.test.ts',
    'tests/autonomy.test.ts',
    'tests/tool-strategy.test.ts',
    'tests/session.test.ts',
    'tests/docx.test.ts',
    'tests/disk.test.ts',
    'tests/environment.test.ts',
    'tests/growth.test.ts',
    'tests/rename.test.ts',
    'tests/checkpoint.test.ts',
    'tests/task-board.test.ts',
    'tests/task-verify.test.ts',
    'tests/nav.test.ts',
    'tests/project-memory.test.ts',
    'tests/git-safety.test.ts',
    'tests/git-rollback.test.ts',
    'tests/git-publisher.test.ts',
    'tests/git-workflow.test.ts',
    'tests/provider-tools.test.ts',
    'tests/provider-stream.test.ts',
    'tests/command-extract.test.ts',
    'tests/audit.test.ts',
  ];
  requiredFiles.forEach((path) => checks.push({ name: `file exists: ${path}`, run: () => exists(path) }));

  const packageScripts = ['"build"', '"typecheck"', '"test"', '"smoke"', '"audit:100"'];
  packageScripts.forEach((script) => checks.push({ name: `package script ${script}`, run: () => contains('package.json', script) }));

  const tsconfigNeedles = ['"strict": true', '"module": "NodeNext"', '"outDir": "dist"', '"types": ["node"]'];
  tsconfigNeedles.forEach((needle) => checks.push({ name: `tsconfig contains ${needle}`, run: () => contains('tsconfig.json', needle) }));

  const providerNeedles: Array<[string, string]> = [
    ['src/providers/types.ts', 'ProviderRequest'],
    ['src/providers/types.ts', 'ProviderResponse'],
    ['src/providers/types.ts', 'AgentAction'],
    ['src/providers/mock.ts', 'createMockProvider'],
    ['src/providers/mock.ts', 'AICODE_SMOKE_MULTI_TOOL'],
    ['src/providers/mock.ts', 'planNaturalLanguage'],
    ['src/providers/mock.ts', 'AICODE_NL_DRIVE'],
    ['src/providers/protocol.ts', 'buildToolSystemPrompt'],
    ['src/providers/protocol.ts', 'parseToolActions'],
    ['src/providers/protocol.ts', 'toOpenAITools'],
    ['src/providers/protocol.ts', 'parseOpenAIToolCalls'],
    ['src/providers/protocol.ts', 'toAnthropicTools'],
    ['src/providers/protocol.ts', 'parseAnthropicContentBlocks'],
    ['src/providers/protocol.ts', 'iterateSseDataLines'],
    ['src/providers/protocol.ts', 'fetchWithRetry'],
    ['src/providers/protocol.ts', 'create_docx'],
    ['src/providers/protocol.ts', 'Word document'],
    ['src/providers/protocol.ts', 'natural language'],
    ['src/providers/openai.ts', 'OPENAI_API_KEY'],
    ['src/providers/openai.ts', '/chat/completions'],
    ['src/providers/openai.ts', 'buildToolSystemPrompt'],
    ['src/providers/openai.ts', 'parseOpenAIToolCalls'],
    ['src/providers/openai.ts', 'tool_choice'],
    ['src/providers/openai.ts', 'stream'],
    ['src/providers/anthropic.ts', 'ANTHROPIC_API_KEY'],
    ['src/providers/anthropic.ts', '/messages'],
    ['src/providers/anthropic.ts', 'buildToolSystemPrompt'],
    ['src/providers/anthropic.ts', 'parseAnthropicContentBlocks'],
    ['src/providers/anthropic.ts', 'stream'],
    ['src/ui/terminal.ts', 'assistantDelta'],
    ['src/agent/agent.ts', 'onTextDelta'],
    ['src/providers/index.ts', 'createProvider'],
  ];
  providerNeedles.forEach(([path, needle]) => checks.push({ name: `provider ${path} contains ${needle}`, run: () => contains(path, needle) }));

  const registry = createDefaultToolRegistry();
  const expectedTools = ['project_status', 'recent_activity', 'environment_info', 'project_index', 'find_symbol', 'find_references', 'git_status', 'git_diff', 'git_log', 'list_files', 'read_file', 'write_file', 'search_text', 'process_memory', 'disk_info', 'disk_growth', 'run_command', 'create_docx', 'rename_file', 'apply_patch'];
  expectedTools.forEach((tool) => checks.push({ name: `tool registered: ${tool}`, run: () => registry.get(tool) !== undefined }));
  checks.push({ name: 'tool specs match tool count', run: () => registry.specs().length === expectedTools.length });
  checks.push({ name: 'tool names are unique', run: () => new Set(registry.list().map((tool) => tool.name)).size === registry.list().length });
  checks.push({ name: 'read tools exist', run: () => registry.list().filter((tool) => tool.risk === 'read').length >= 4 });
  checks.push({ name: 'write tools exist', run: () => registry.list().filter((tool) => tool.risk === 'write').length >= 2 });
  checks.push({ name: 'shell tool exists', run: () => registry.list().some((tool) => tool.risk === 'shell') });

  const toolNeedles: Array<[string, string]> = [
    ['src/tools/activity.ts', 'recentActivityTool'],
    ['src/tools/activity.ts', 'git: not a git repository'],
    ['src/tools/nav.ts', 'findSymbolTool'],
    ['src/tools/nav.ts', 'findReferencesTool'],
    ['src/nav/store.ts', 'NavIndexStore'],
    ['src/nav/extract.ts', 'extractSymbolsFromSource'],
    ['src/tools/files.ts', 'resolveWorkspacePath'],
    ['src/tools/files.ts', 'writeFileTool'],
    ['src/tools/files.ts', 'readFileTool'],
    ['src/tools/files.ts', 'listFilesTool'],
    ['src/tools/git.ts', 'gitStatusTool'],
    ['src/tools/git.ts', 'gitDiffTool'],
    ['src/tools/git.ts', 'gitLogTool'],
    ['src/tools/growth.ts', 'diskGrowthTool'],
    ['src/tools/growth.ts', 'recent large files'],
    ['src/tools/search.ts', 'searchTextTool'],
    ['src/tools/shell.ts', 'runCommandTool'],
    ['src/tools/docx.ts', 'createDocxTool'],
    ['src/tools/docx.ts', 'buildDocx'],
    ['src/tools/docx.ts', 'crc32'],
    ['src/tools/disk.ts', 'diskInfoTool'],
    ['src/tools/disk.ts', 'statfs'],
    ['src/tools/environment.ts', 'environmentInfoTool'],
    ['src/tools/environment.ts', 'workspaceRoot'],
    ['src/tools/rename.ts', 'renameFileTool'],
    ['src/tools/rename.ts', 'resolveDesktopPath'],
    ['src/tools/patch.ts', 'applyPatchTool'],
    ['src/tools/process.ts', 'processMemoryTool'],
    ['src/tools/process.ts', 'powershell.exe'],
    ['src/tools/projectIndex.ts', 'projectIndexTool'],
    ['src/tools/registry.ts', 'decideApproval'],
    ['src/tools/registry.ts', 'diffPreview'],
    ['src/tools/registry.ts', 'beforeTool'],
    ['src/tools/registry.ts', 'afterTool'],
    ['src/tools/registry.ts', 'onError'],
    ['src/tools/registry.ts', 'Invalid input'],
    ['src/tools/index.ts', 'createDefaultToolRegistry'],
  ];
  toolNeedles.forEach(([path, needle]) => checks.push({ name: `tool source ${path} contains ${needle}`, run: () => contains(path, needle) }));

  const workspace = root;
  checks.push({ name: 'path policy allows workspace file', run: () => isInsideWorkspace(workspace, 'src/index.ts') });
  checks.push({ name: 'path policy blocks parent traversal', run: () => !isInsideWorkspace(workspace, '../outside.txt') });
  checks.push({ name: 'path policy blocks rm -rf', run: () => isBlockedCommand('rm -rf /') });
  checks.push({ name: 'path policy blocks git reset hard', run: () => isBlockedCommand('git reset --hard HEAD') });
  checks.push({ name: 'path policy blocks shutdown', run: () => isBlockedCommand('shutdown now') });
  checks.push({ name: 'auto policy allows node version', run: () => isAutoAllowedCommand('node --version') });
  checks.push({ name: 'auto policy allows npm test', run: () => isAutoAllowedCommand('npm test') });
  checks.push({ name: 'auto policy rejects arbitrary command', run: () => !isAutoAllowedCommand('curl https://example.com') });
  checks.push({ name: 'policy has deny mode handling', run: () => contains('src/safety/policy.ts', "mode === 'deny'") });
  checks.push({ name: 'policy has interactive approval prompt marker', run: () => contains('src/safety/policy.ts', 'needsPrompt') });
  checks.push({ name: 'policy exposes askForApproval', run: () => contains('src/safety/policy.ts', 'askForApproval') });
  checks.push({ name: 'policy has auto write allowlist', run: () => contains('src/safety/policy.ts', '.smoke/') });

  const configNeedles = ['loadConfig', 'safeConfig', 'requireProviderAuth', 'defaultProfile', 'profiles', 'redactSecret'];
  configNeedles.forEach((needle) => checks.push({ name: `config source contains ${needle}`, run: () => contains('src/config/config.ts', needle) }));

  const pluginNeedles = ['readPluginManifest', 'plugin_', 'loadPluginTools'];
  pluginNeedles.forEach((needle) => checks.push({ name: `plugin source contains ${needle}`, run: async () => (await contains('src/plugins/manifest.ts', needle)) || (await contains('src/plugins/loader.ts', needle)) }));

  const hookNeedles = ['createNoopHooks', 'beforeTool', 'afterTool', 'onError'];
  hookNeedles.forEach((needle) => checks.push({ name: `hook source contains ${needle}`, run: () => contains('src/hooks/hooks.ts', needle) }));

  const sessionNeedles = ['SessionStore', 'appendMessage', 'appendToolCall', 'appendFinalAnswer', 'sessions', 'toolCalls', 'finalAnswers'];
  sessionNeedles.forEach((needle) => checks.push({ name: `session source contains ${needle}`, run: () => contains('src/session/store.ts', needle) }));

  const checkpointNeedles = ['CheckpointStore', 'beforeWrite', 'beforeRename', 'undoLast'];
  checkpointNeedles.forEach((needle) => checks.push({ name: `checkpoint source contains ${needle}`, run: () => contains('src/session/checkpoint.ts', needle) }));

  const cliNeedles: Array<[string, string]> = [
    ['src/cli/args.ts', '--provider'],
    ['src/cli/args.ts', '--approval'],
    ['src/cli/args.ts', '--session-dir'],
    ['src/cli/args.ts', '--config'],
    ['src/cli/args.ts', '--profile'],
    ['src/cli/args.ts', '--resume'],
    ['src/cli/args.ts', '--prompt'],
    ['src/cli/args.ts', '--version'],
    ['src/cli/args.ts', '--json'],
    ['src/cli/args.ts', '--no-color'],
    ['src/cli/args.ts', '--quiet'],
    ['src/cli/args.ts', '--debug'],
    ['src/cli/args.ts', '--ci'],
    ['src/cli/args.ts', '--no-input'],
    ['src/cli/args.ts', '--doctor'],
    ['src/cli/args.ts', 'completion'],
    ['src/cli/completion.ts', 'completionScript'],
    ['src/cli/completion.ts', 'powershell'],
    ['src/cli/doctor.ts', 'runDoctor'],
    ['src/cli/doctor.ts', 'formatDoctor'],
    ['src/cli/commands.ts', '/help'],
    ['src/cli/commands.ts', '/status'],
    ['src/cli/commands.ts', '/provider'],
    ['src/cli/commands.ts', '/model'],
    ['src/cli/commands.ts', '/config'],
    ['src/cli/commands.ts', '/tools'],
    ['src/cli/commands.ts', '/summary'],
    ['src/cli/commands.ts', '/plan'],
    ['src/cli/commands.ts', '/export'],
    ['src/cli/commands.ts', '/sessions'],
    ['src/cli/commands.ts', '/undo'],
    ['src/cli/commands.ts', '/不准偷懒开发'],
    ['src/cli/commands.ts', '/exit'],
    ['src/cli/repl.ts', 'handleLazyDevInput'],
    ['src/cli/repl.ts', 'runPromptMode'],
    ['src/cli/repl.ts', 'runRepl'],
    ['src/cli/repl.ts', 'interactiveRuntime'],
    ['src/cli/repl.ts', 'confirm: async'],
    ['src/ui/terminal.ts', 'turnStart'],
    ['src/ui/terminal.ts', 'jsonEvent'],
    ['src/ui/terminal.ts', 'noColor'],
    ['src/ui/terminal.ts', 'final'],
    ['src/ui/terminal.ts', 'toolStart'],
    ['src/ui/terminal.ts', 'toolResult'],
    ['src/ui/terminal.ts', 'writeSectionTitle'],
    ['src/ui/terminal.ts', 'writeKeyValue'],
    ['src/ui/terminal.ts', 'wrapLines'],
    ['src/ui/terminal.ts', 'displayWidth'],
    ['src/ui/terminal.ts', 'colors'],
    ['src/index.ts', 'createDefaultToolRegistry'],
  ];
  cliNeedles.forEach(([path, needle]) => checks.push({ name: `cli ${path} contains ${needle}`, run: () => contains(path, needle) }));

  const agentNeedles = ['runAgentTurn', 'maxSteps', 'appendToolCall', 'appendFinalAnswer', 'provider.complete', 'projectContext', 'Model request failed', 'planLocalFallback', 'isTerminalToolFailure', 'tools.execute'];
  agentNeedles.forEach((needle) => checks.push({ name: `agent contains ${needle}`, run: () => contains('src/agent/agent.ts', needle) }));

  const contextNeedles = ['readProjectContext', 'formatProjectContext', 'cacheKey', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
  contextNeedles.forEach((needle) => checks.push({ name: `context contains ${needle}`, run: () => contains('src/agent/context.ts', needle) }));
  const contextBudgetNeedles = ['compactMessagesForModel', 'resolveContextBudgetChars', 'AICODE_CONTEXT_BUDGET_CHARS'];
  contextBudgetNeedles.forEach((needle) => checks.push({ name: `context budget contains ${needle}`, run: () => contains('src/agent/contextBudget.ts', needle) }));
  checks.push({ name: 'agent uses compactMessagesForModel', run: () => contains('src/agent/agent.ts', 'compactMessagesForModel') });

  const fallbackNeedles = ['planLocalFallback', 'rename_file', 'previousUserPrompt'];
  fallbackNeedles.forEach((needle) => checks.push({ name: `fallback contains ${needle}`, run: () => contains('src/agent/fallback.ts', needle) }));

  const toolStrategyNeedles = ['planToolStrategy', 'formatToolStrategy', 'recoveryHintForToolFailure', 'code_edit', 'disk_growth'];
  toolStrategyNeedles.forEach((needle) => checks.push({ name: `tool strategy contains ${needle}`, run: () => contains('src/agent/toolStrategy.ts', needle) }));

  const commandExtractNeedles: Array<[string, string]> = [
    ['src/agent/commandExtract/extract.ts', 'extractCommand'],
    ['src/agent/commandExtract/plan.ts', 'planCommand'],
    ['src/agent/commandExtract/execute.ts', 'executeCommandPlan'],
    ['src/agent/agent.ts', 'executeCommandPlan'],
    ['src/providers/mock.ts', 'extractCommand'],
  ];
  commandExtractNeedles.forEach(([path, needle]) => checks.push({ name: `command extract ${path} contains ${needle}`, run: () => contains(path, needle) }));
  const commandExtractTestNeedles = [
    'extracts high-confidence readonly intents and slots',
    'plans direct execution only for high-confidence readonly tools',
    'high-confidence readonly prompt executes tools without calling provider',
    'strategy-only edit prompt still calls provider with strategy text',
  ];
  commandExtractTestNeedles.forEach((needle) => checks.push({ name: `command extract test contains ${needle}`, run: () => contains('tests/command-extract.test.ts', needle) }));

  const cliProcessTestNeedles = ['CLI prints package version', 'CLI emits JSON events', 'CLI --no-input exits nonzero', 'CLI doctor reports local readiness', 'CLI prints bash completion script'];
  cliProcessTestNeedles.forEach((needle) => checks.push({ name: `cli process test contains ${needle}`, run: () => contains('tests/cli-process.test.ts', needle) }));

  const smokeNeedles = ['multi-tool smoke chain', 'natural-language tool chains', 'provider protocol parses', 'project_status', 'write_file', 'read_file', 'search_text', 'run_command', 'AICODE_SMOKE_MULTI_TOOL', 'AICODE_NL_MARKER', 'toolCalls'];
  smokeNeedles.forEach((needle) => checks.push({ name: `smoke test contains ${needle}`, run: () => contains('tests/smoke.test.ts', needle) }));

  const terminalUiTestNeedles = ['TerminalUI lays out task assistant and tool output', 'omits empty tool output blocks', 'wraps long lines'];
  terminalUiTestNeedles.forEach((needle) => checks.push({ name: `terminal ui test contains ${needle}`, run: () => contains('tests/terminal-ui.test.ts', needle) }));

  const approvalNeedles = ['ask approval blocks write tools', 'after confirmation', 'cancelled by user'];
  approvalNeedles.forEach((needle) => checks.push({ name: `approval test contains ${needle}`, run: () => contains('tests/approval.test.ts', needle) }));

  const autonomyTestNeedles = ['project context cache keeps stable cache key', 'agent continues after recoverable tool failure'];
  autonomyTestNeedles.forEach((needle) => checks.push({ name: `autonomy test contains ${needle}`, run: () => contains('tests/autonomy.test.ts', needle) }));

  const toolStrategyTestNeedles = [
    'tool strategy classifies disk growth',
    'tool strategy classifies code edit',
    'tool system prompt places project context before strategy',
    'recovery hints explain path and edit failures',
  ];
  toolStrategyTestNeedles.forEach((needle) => checks.push({ name: `tool strategy test contains ${needle}`, run: () => contains('tests/tool-strategy.test.ts', needle) }));

  const configTestNeedles = ['loadConfig applies config profiles', 'safeConfig redacts API keys', 'requireProviderAuth rejects missing hosted provider key', '/config slash command'];
  configTestNeedles.forEach((needle) => checks.push({ name: `config test contains ${needle}`, run: () => contains('tests/config.test.ts', needle) }));

  const activityTestNeedles = ['recent_activity summarizes sessions and files without git', 'mock provider uses recent_activity', 'tool system prompt tells models to use recent_activity'];
  activityTestNeedles.forEach((needle) => checks.push({ name: `activity test contains ${needle}`, run: () => contains('tests/activity.test.ts', needle) }));

  const contextTestNeedles = ['git tools are registered', 'project context reads instruction files', 'slash commands summarize plan'];
  contextTestNeedles.forEach((needle) => checks.push({ name: `context test contains ${needle}`, run: () => contains('tests/context.test.ts', needle) }));

  const pluginTestNeedles = ['plugin manifest loads', 'plugin tools execute through the registry', 'hook lifecycle receives'];
  pluginTestNeedles.forEach((needle) => checks.push({ name: `plugin test contains ${needle}`, run: () => contains('tests/plugins.test.ts', needle) }));

  const processTestNeedles = ['process_memory tool reports', 'mock provider uses process_memory', 'tool system prompt tells models'];
  processTestNeedles.forEach((needle) => checks.push({ name: `process test contains ${needle}`, run: () => contains('tests/process.test.ts', needle) }));

  const environmentTestNeedles = ['environment_info tool reports runtime facts', 'mock provider uses environment_info', 'tool system prompt tells models to use environment_info'];
  environmentTestNeedles.forEach((needle) => checks.push({ name: `environment test contains ${needle}`, run: () => contains('tests/environment.test.ts', needle) }));

  const diskTestNeedles = ['disk_info reports disk capacity', 'mock provider uses disk_info', 'tool system prompt tells models to use disk_info'];
  diskTestNeedles.forEach((needle) => checks.push({ name: `disk test contains ${needle}`, run: () => contains('tests/disk.test.ts', needle) }));

  const growthTestNeedles = ['disk_growth reports recent large files', 'mock provider uses disk_growth', 'tool system prompt tells models to use disk_growth'];
  growthTestNeedles.forEach((needle) => checks.push({ name: `growth test contains ${needle}`, run: () => contains('tests/growth.test.ts', needle) }));

  const sessionTestNeedles = ['parseArgs supports --resume', 'SessionStore loads a saved session for resume', 'second turn'];
  sessionTestNeedles.forEach((needle) => checks.push({ name: `session test contains ${needle}`, run: () => contains('tests/session.test.ts', needle) }));

  const docxTestNeedles = ['create_docx creates a Word document on the Desktop', 'PK'];
  docxTestNeedles.forEach((needle) => checks.push({ name: `docx test contains ${needle}`, run: () => contains('tests/docx.test.ts', needle) }));

  const renameTestNeedles = ['rename_file renames a Desktop docx file', 'local fallback plans rename'];
  renameTestNeedles.forEach((needle) => checks.push({ name: `rename test contains ${needle}`, run: () => contains('tests/rename.test.ts', needle) }));

  const checkpointTestNeedles = ['checkpoints undo the last write_file change', 'project_index reports key files'];
  checkpointTestNeedles.forEach((needle) => checks.push({ name: `checkpoint test contains ${needle}`, run: () => contains('tests/checkpoint.test.ts', needle) }));

  const taskBoardFileNeedles: Array<[string, string]> = [
    ['src/tasks/store.ts', 'TaskBoardStore'],
    ['src/tasks/planner.ts', 'planBoardFromGoal'],
    ['src/tasks/planner.ts', 'shouldUseTaskBoard'],
    ['src/tasks/runtime.ts', 'runTaskBoardLoop'],
    ['src/tasks/completion.ts', 'detectTaskCompletion'],
    ['src/cli/commands.ts', '/plan confirm'],
    ['src/cli/repl.ts', 'continueTaskBoard'],
  ];
  taskBoardFileNeedles.forEach(([path, needle]) => checks.push({ name: `task board ${path} contains ${needle}`, run: () => contains(path, needle) }));

  const taskBoardTestNeedles = [
    'TaskBoardStore saves loads and lists boards',
    'shouldUseTaskBoard accepts large multi-step goals',
    'runtime selects dependency-aware next task',
    'large goal drafts a board and confirmPlan auto-runs tasks',
  ];
  taskBoardTestNeedles.forEach((needle) => checks.push({ name: `task board test contains ${needle}`, run: () => contains('tests/task-board.test.ts', needle) }));

  const verifyNeedles: Array<[string, string]> = [
    ['src/tasks/verify.ts', 'runVerifySuite'],
    ['src/tasks/verify.ts', 'discoverVerifyCommands'],
    ['src/tasks/verify.ts', 'buildRepairPrompt'],
    ['src/tasks/runtime.ts', 'completeWithVerification'],
  ];
  verifyNeedles.forEach(([path, needle]) => checks.push({ name: `verify loop ${path} contains ${needle}`, run: () => contains(path, needle) }));
  const verifyTestNeedles = [
    'discoverVerifyCommands finds typecheck test build scripts',
    'runVerifySuite fails on first nonzero command and truncates output',
    'task board requires verification before done and repairs once',
  ];
  verifyTestNeedles.forEach((needle) => checks.push({ name: `verify test contains ${needle}`, run: () => contains('tests/task-verify.test.ts', needle) }));

  const projectMemoryFileNeedles: Array<[string, string]> = [
    ['src/memory/store.ts', 'ProjectMemoryStore'],
    ['src/memory/extract.ts', 'extractMemoryCandidates'],
    ['src/memory/select.ts', 'selectRelevantMemories'],
    ['src/memory/record.ts', 'maybeRecordTaskMemory'],
    ['src/tasks/runtime.ts', 'maybeRecordTaskMemory'],
    ['src/cli/commands.ts', '/memory add'],
    ['src/cli/repl.ts', 'formatMemories'],
  ];
  projectMemoryFileNeedles.forEach(([path, needle]) => checks.push({ name: `project memory ${path} contains ${needle}`, run: () => contains(path, needle) }));

  const projectMemoryTestNeedles = [
    'ProjectMemoryStore adds lists and soft-forgets entries',
    'extractMemoryCandidates records decisions and pitfalls',
    'runTaskBoardLoop records memory and injects it into later task prompts',
    '/memory supports add list and forget',
  ];
  projectMemoryTestNeedles.forEach((needle) => checks.push({ name: `project memory test contains ${needle}`, run: () => contains('tests/project-memory.test.ts', needle) }));

  const gitSafetyFileNeedles: Array<[string, string]> = [
    ['src/git-safety/service.ts', 'GitSafetyService'],
    ['src/git-safety/rollback.ts', 'GitRollbackService'],
    ['src/git-safety/publisher.ts', 'GitRemotePublisher'],
    ['src/git-safety/snapshot.ts', 'refs/aicode/checkpoints/'],
    ['src/git-safety/snapshot.ts', 'GIT_INDEX_FILE'],
    ['src/cli/commands.ts', '/git publish'],
    ['src/cli/commands.ts', '/rollback show|preview|apply'],
    ['src/agent/agent.ts', 'gitSafetyUnit'],
    ['src/tasks/runtime.ts', 'gitSafety'],
  ];
  gitSafetyFileNeedles.forEach(([path, needle]) => checks.push({ name: `git safety ${path} contains ${needle}`, run: () => contains(path, needle) }));

  const gitSafetyTestNeedles = [
    'GitSnapshotStore creates readable baseline and result refs',
    'snapshot creation preserves HEAD branch worktree and real index',
    'GitSafetyService creates one baseline and one result per unit',
    'selective rollback restores only paths changed by the selected unit',
    'post-result worktree edit conflicts and causes zero rollback writes',
    'publisher asks independently for every push',
  ];
  gitSafetyTestNeedles.forEach((needle) => {
    checks.push({
      name: `git safety test contains ${needle}`,
      run: async () => {
        for (const path of ['tests/git-safety.test.ts', 'tests/git-rollback.test.ts', 'tests/git-publisher.test.ts']) {
          if (await contains(path, needle)) return true;
        }
        return false;
      },
    });
  });

  checks.push({
    name: 'shell auto allowlist no longer includes generic git branch mutation pattern',
    run: async () => !(await contains('src/safety/policy.ts', '(status|diff|log|branch)')),
  });
  checks.push({
    name: 'git safety modules avoid reset --hard and checkout -f',
    run: async () => {
      for (const path of ['src/git-safety/snapshot.ts', 'src/git-safety/rollback.ts', 'src/git-safety/service.ts', 'src/git-safety/publisher.ts']) {
        const body = await text(path);
        if (body.includes('reset --hard') || body.includes('checkout -f') || body.includes('run_command')) return false;
      }
      return true;
    },
  });

  const readmeNeedles = ['aicode CLI MVP', 'OpenAI-compatible', 'Anthropic provider', 'Sessions', '--resume', 'Slash Commands', '不准偷懒开发', 'Verification', 'npm run smoke', 'npm run audit:100', 'Task boards', 'Project memory', 'Git safety', '/rollback', '/git publish', 'Natural-language command extraction', 'Task verify loop', 'Codebase navigation', 'Context budget', 'Git workflow', 'Native tool calling', 'stream'];
  readmeNeedles.forEach((needle) => checks.push({ name: `README contains ${needle}`, run: () => contains('README.md', needle) }));

  const matrixNeedles = ['Capability Matrix', 'Command UX/help/version', 'Plugins/hooks', 'MCP', 'OS sandbox', 'Final Verification Checklist', 'Long-task planning / task board', 'Project memory', 'Git safety / rollback log', 'Natural-language command extraction', 'Task verify loop', 'Codebase navigation', 'Context budget / compaction', 'aicode/board-', 'native tools/tool_calls', 'SSE text streaming'];
  matrixNeedles.forEach((needle) => checks.push({ name: `capability matrix contains ${needle}`, run: () => contains('docs/capability-matrix.md', needle) }));

  const gitWorkflowNeedles = ['ensureBoardBranch', 'commitBoardChanges', 'previewBoardCommit', 'boardBranchName'];
  gitWorkflowNeedles.forEach((needle) => checks.push({ name: `git workflow contains ${needle}`, run: () => contains('src/git-safety/workflow.ts', needle) }));

  checks.push({ name: 'mock provider returns provider name', run: () => createMockProvider().name === 'mock' });
  checks.push({ name: 'mock provider returns configured model', run: () => createMockProvider('x').model === 'x' });
  checks.push({
    name: 'mock provider emits action for smoke prompt',
    run: async () => {
      const response = await createMockProvider().complete({
        messages: [{ role: 'user', content: 'smoke multi-tool task', createdAt: new Date().toISOString() }],
        tools: registry.specs(),
        workspaceRoot: root,
      });
      return response.actions.length === 1 && response.actions[0]?.type === 'tool';
    },
  });

  checks.push({
    name: 'mock provider emits action for natural-language prompt',
    run: async () => {
      const response = await createMockProvider().complete({
        messages: [{ role: 'user', content: '请帮我写 .smoke/nl.md，读取它，搜索 AICODE_NL_MARKER，然后运行 node --version', createdAt: new Date().toISOString() }],
        tools: registry.specs(),
        workspaceRoot: root,
      });
      return response.actions.length === 1 && response.actions[0]?.type === 'tool';
    },
  });

  checks.push({ name: 'audit has at least 100 checks', run: () => checks.length >= 100 });
  return checks;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('checks.js')) {
  const result = await runAuditChecks(process.cwd());
  if (result.failures.length > 0 || result.total < 100) {
    process.exitCode = 1;
  }
}
