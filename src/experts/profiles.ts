import type { ExpertProfile } from './types.js';
import { isReadOnlyTool } from '../tools/scope.js';
import { REVIEW_RUBRIC, REVIEW_TASK_PREAMBLE } from '../review/rubric.js';

/**
 * 代码编辑专家 - 专注代码修改/重构/实现
 */
export const codeEditExpert: ExpertProfile = {
  id: 'code_edit',
  name: '代码编辑专家',
  description: '专注代码实现、重构、修复，优先使用 find_symbol/apply_patch/write_file',
  intent: 'code_edit',
  toolFilter: (tool) => {
    // 允许：代码搜索/读取/写入/patch，文件操作，项目索引
    const allowed = [
      'read_file', 'write_file', 'append_file', 'edit_lines', 'apply_patch',
      'find_symbol', 'find_references', 'project_index', 'search_text',
      'list_files', 'file_info', 'rename_file', 'copy_file', 'make_dir',
      'diff_files', 'read_lines', 'read_many_files', 'list_tree', 'find_files',
      'project_status', 'recent_activity', 'environment_info',
      'filename_search', 'glob_files', 'count_files', 'directory_summary',
    ];
    if (allowed.includes(tool.name)) return true;
    // 禁止：git/shell/docx/数据转换等
    if (tool.name.startsWith('git_')) return false;
    if (tool.name.startsWith('create_docx') || tool.name.startsWith('create_pptx') || tool.name.startsWith('create_xlsx')) return false;
    if (tool.name === 'run_command') return false;
    // 保守策略：只允许 read 风险的其他工具
    return tool.risk === 'read';
  },
  systemPrompt: `You are the **Code Edit Expert**. Your role is to implement, refactor, and fix code efficiently.

Work focus:
- Use find_symbol/find_references to locate code before editing
- Prefer apply_patch for surgical edits; use write_file for new files or full rewrites
- Read surrounding context (imports, types, usage) before making changes
- Keep edits minimal and focused on the task acceptance criteria
- Avoid running tests or git operations - other experts handle those

When done, reply with: TASK_DONE: <summary of changes>`,
  toolScopeOverride: 'standard',
};

/**
 * 代码调研专家 - 专注代码搜索/理解/分析
 */
export const codeSearchExpert: ExpertProfile = {
  id: 'code_search',
  name: '代码调研专家',
  description: '专注代码搜索、理解、架构分析，只读不写',
  intent: 'code_search',
  toolFilter: (tool) => {
    // 只允许只读工具。isReadOnlyTool 而非 risk==='read'：spawn_subagent 的风险
    // 是 read，却能起一个可写的子智能体 —— 调研专家不该有这条路。
    return isReadOnlyTool(tool);
  },
  systemPrompt: `You are the **Code Search Expert**. Your role is to locate, read, and analyze code without modifying it.

Work focus:
- Use search_text + find_symbol + find_references to locate relevant code
- Use project_index to understand project structure
- Read files and cross-reference imports/usage to build a mental model
- Summarize findings clearly: where the code lives, what it does, how it's used
- Do NOT write, edit, or execute anything - you are read-only

When done, reply with: TASK_DONE: <summary of findings>`,
  toolScopeOverride: 'compact',
};

/**
 * Git 操作专家 - 专注 git 工作流
 */
export const gitOpsExpert: ExpertProfile = {
  id: 'git_ops',
  name: 'Git 操作专家',
  description: '专注 git 操作（add/commit/branch/stash/merge），可读取文件但不编辑代码',
  intent: 'git_ops',
  toolFilter: (tool) => {
    // git 工具 + 只读文件工具
    if (tool.name.startsWith('git_')) return true;
    // 允许只读文件工具辅助检查状态
    return tool.risk === 'read';
  },
  systemPrompt: `You are the **Git Operations Expert**. Your role is to manage git workflow: staging, committing, branching, stashing, fetch/pull/merge.

Work focus:
- Use git_status/git_diff to inspect current state
- Use git_add + git_commit for staging/committing changes
- Use git_branch/git_checkout for branch management
- Use git_fetch/git_pull for remote sync (never force-push)
- Use git_merge/git_cherry_pick/git_tag when integrating history
- Use git_log/git_show/git_blame for history inspection
- Keep commit messages clear and descriptive
- Do NOT edit code - assume changes are already made by another expert

When done, reply with: TASK_DONE: <git operation summary>`,
};

/**
 * 测试验证专家 - 专注测试编写和执行
 */
export const testVerifyExpert: ExpertProfile = {
  id: 'test_verify',
  name: '测试验证专家',
  description: '专注测试编写、测试执行、验证脚本运行',
  intent: 'test_verify',
  toolFilter: (tool) => {
    // 文件读写 + shell 执行 + 项目索引
    const testRelevant = [
      'read_file', 'write_file', 'search_text', 'find_symbol', 'project_index',
      'run_command', 'list_files', 'file_info', 'project_status',
      'diff_files', 'apply_patch', 'edit_lines', 'append_file',
      'find_references', 'read_lines', 'read_many_files',
    ];
    return testRelevant.includes(tool.name) || tool.risk === 'read';
  },
  systemPrompt: `You are the **Test & Verify Expert**. Your role is to write tests and run verification commands.

Work focus:
- Read existing tests to understand the project's testing patterns
- Write new test files or add test cases to existing files
- Use run_command to execute test suites (npm test, pytest, etc.)
- Interpret test output and report failures clearly
- Fix tests if they fail due to incorrect assertions (not code bugs)
- May also run typecheck/lint/build commands as part of verification

When done, reply with: TASK_DONE: <test/verify summary with pass/fail counts>`,
  toolScopeOverride: 'full',
};

/**
 * 文档生成专家 - 专注文档创建（docx/pptx/xlsx/md）
 */
export const docGenerationExpert: ExpertProfile = {
  id: 'doc_generation',
  name: '文档生成专家',
  description: '专注文档创建（Word/PPT/Excel/Markdown/PDF），可读取代码生成文档',
  intent: 'doc_generation',
  toolFilter: (tool) => {
    // docx/pptx/xlsx/md/pdf 工具 + 只读代码工具
    if (tool.name.startsWith('create_docx') || tool.name.startsWith('create_pptx') || tool.name.startsWith('create_xlsx')) return true;
    if (tool.name.startsWith('convert_to_pdf') || tool.name.startsWith('markdown_') || tool.name.startsWith('insert_docx')) return true;
    if (tool.name === 'write_file' || tool.name === 'append_file') return true;
    return tool.risk === 'read';
  },
  systemPrompt: `You are the **Documentation Generation Expert**. Your role is to create high-quality documents in various formats.

Work focus:
- Use create_docx/create_pptx/create_xlsx for Office documents
- Use write_file for Markdown/plaintext docs
- Read code/project files to extract information for documentation
- Structure documents clearly with headings, lists, tables as appropriate
- Ensure generated documents are complete and well-formatted
- Do NOT edit code or run commands unrelated to document creation

When done, reply with: TASK_DONE: <document type and path>`,
};

/**
 * Shell/运行时专家 - 专注运行时操作
 */
export const shellRuntimeExpert: ExpertProfile = {
  id: 'shell_runtime',
  name: 'Shell 运行时专家',
  description: '专注 shell 命令执行、环境检查、磁盘/进程管理',
  intent: 'shell_runtime',
  toolFilter: (tool) => {
    const shellRelevant = [
      'run_command', 'environment_info', 'disk_info', 'disk_growth',
      'process_memory', 'which_command', 'env_get',
      'list_files', 'file_info', 'project_status', 'cache_probe',
    ];
    return shellRelevant.includes(tool.name) || tool.risk === 'read';
  },
  systemPrompt: `You are the **Shell & Runtime Expert**. Your role is to execute commands, check environment, and manage runtime operations.

Work focus:
- Use run_command for shell execution (builds, installs, scripts)
- Use environment_info/disk_info/process_memory for system inspection
- Interpret command output and report success/failure clearly
- Handle timeouts and errors gracefully
- Do NOT edit code - focus on runtime operations only

When done, reply with: TASK_DONE: <command execution summary>`,
  toolScopeOverride: 'full',
};

/**
 * 数据处理专家 - 专注数据文件转换/查询
 */
export const dataProcessingExpert: ExpertProfile = {
  id: 'data_processing',
  name: '数据处理专家',
  description: '专注 JSON/CSV/YAML/XML 等数据文件的读取/转换/查询',
  intent: 'data_processing',
  toolFilter: (tool) => {
    // 数据工具 + 文件读写
    const dataTools = [
      'read_json', 'write_json', 'format_json', 'json_merge', 'json_keys', 'json_type_summary', 'json_to_csv',
      'read_csv', 'write_csv', 'csv_stats', 'csv_preview', 'csv_to_json',
      'yaml_parse', 'yaml_query', 'yaml_keys',
      'xml_to_text', 'xml_summary', 'xml_query',
      'ini_parse', 'properties_parse', 'toml_parse',
      'read_file', 'write_file', 'list_files', 'file_info',
    ];
    return dataTools.includes(tool.name) || tool.risk === 'read';
  },
  systemPrompt: `You are the **Data Processing Expert**. Your role is to read, transform, and query structured data files.

Work focus:
- Use read_json/read_csv/yaml_parse to load data
- Use json_merge/csv_to_json/format_json for transformations
- Use json_keys/csv_stats for data inspection
- Write results using write_json/write_csv/write_file
- Handle data errors gracefully (malformed JSON, missing fields)
- Do NOT run commands or edit code - focus on data only

When done, reply with: TASK_DONE: <data operation summary>`,
};

export const CODE_REVIEW_EXPERT_ID = 'code_review';

/**
 * 代码审查专家 - 独立子会话里的只读审查者。
 *
 * `intent: 'code_search'` 是有意的复用：ExpertIntent 是路由器的封闭联合类型，
 * 加一个新成员要动分类器，而审查在路由意义上确实就是"调研代码、不改动"。
 *
 * **只读性完全由这里的 toolFilter 保证**：runSubAgent 把 confirm/toolConfirm
 * 硬编码为 `() => true`（子智能体一律自动批准），所以过滤器是唯一的边界 —— 放
 * 宽它等于放开写权限。`risk === 'read'` 同时也挡掉了 run_command（shell 风险）。
 *
 * rubric 就是它的 system prompt（codex 的做法：`rubric.md` 逐字当系统提示），
 * 所以判定标准与代码分开维护在 `review/rubric.ts`。
 */
export const codeReviewExpert: ExpertProfile = {
  id: CODE_REVIEW_EXPERT_ID,
  name: '代码审查专家',
  description: '独立只读审查代码改动，按 P0-P3 分级报出问题，不修改任何文件',
  intent: 'code_search',
  toolFilter: (tool) => {
    // Read-only, full stop. A reviewer that can write is a reviewer that can
    // "fix" what it was asked to judge, and its findings stop being evidence.
    //
    // `isReadOnlyTool`, not `risk === 'read'`: spawn_subagent carries risk
    // `read` while being able to start a write-capable sub-agent, so a plain
    // risk check would hand the reviewer a way around its own boundary — and
    // the reviewer cannot be prompted about it, because runSubAgent hardcodes
    // every approval to true.
    return isReadOnlyTool(tool);
  },
  systemPrompt: [
    'You are the **Code Review Expert**. You review a proposed code change and report defects. You are read-only.',
    '',
    REVIEW_TASK_PREAMBLE,
    '',
    REVIEW_RUBRIC,
  ].join('\n'),
  toolScopeOverride: 'compact',
};

/**
 * 通用专家 - 兜底，适用于混合/不明确任务
 */
export const generalExpert: ExpertProfile = {
  id: 'general',
  name: '通用专家',
  description: '通用/混合任务，使用完整工具集',
  intent: 'general',
  toolFilter: () => true, // 允许所有工具
  systemPrompt: `You are a **General Expert** handling a mixed or unclear task. Use all available tools as needed.

Work focus:
- Inspect the task carefully and decide which tools to use
- Combine code editing, file operations, git, tests, or runtime operations as required
- When unsure, start with inspection tools (read_file, project_index, search_text)
- Follow the task acceptance criteria strictly

When done, reply with: TASK_DONE: <task summary>`,
  toolScopeOverride: 'full',
};

/**
 * Resolve an expert by profile ID.
 *
 * Returns undefined for an unknown id rather than falling back to the general
 * expert. A silent fallback would hand a caller that asked for the read-only
 * reviewer the full write toolset — the filter is the security boundary, so
 * getting the wrong profile is a privilege change, not a degraded experience.
 */
export function expertById(id: string): ExpertProfile | undefined {
  return allExperts.find((expert) => expert.id === id);
}

/** 所有预定义专家（按专精程度排序：越专精的越靠前，通用兜底放最后） */
export const allExperts: ExpertProfile[] = [
  codeEditExpert,
  codeSearchExpert,
  // Shares code_search's intent, so it must come AFTER it: the router picks the
  // first profile matching an intent, and review must never be auto-routed to
  // for an ordinary search task. Nothing routes to it — /review selects it by id.
  codeReviewExpert,
  gitOpsExpert,
  testVerifyExpert,
  docGenerationExpert,
  shellRuntimeExpert,
  dataProcessingExpert,
  generalExpert, // 兜底放最后
];

