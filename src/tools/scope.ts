import type { ReasoningEffort } from '../providers/types.js';
import { analyzeTaskComplexity } from '../tasks/complexity.js';
import type { ToolRegistry } from './registry.js';
import type { ToolDefinition } from './types.js';

export type ToolScope = 'auto' | 'compact' | 'standard' | 'full';
export type ResolvedToolScope = 'compact' | 'standard' | 'full';

const COMPACT_ALLOW = new Set([
  'project_status', 'recent_activity', 'environment_info', 'cache_probe',
  'git_status', 'git_diff', 'git_diff_staged', 'git_log', 'git_show', 'git_blame',
  'list_files', 'read_file', 'read_lines', 'read_many_files', 'search_text', 'find_files', 'count_files', 'file_info', 'list_tree', 'glob_files', 'filename_search', 'recent_files', 'largest_files', 'directory_summary', 'directory_depth_summary', 'list_dirs', 'empty_dirs', 'file_extensions_in_dir',
  'find_symbol', 'find_references', 'project_index', 'ts_hover', 'ts_goto_definition', 'ts_exact_references',
  'read_json', 'json_keys', 'json_type_summary', 'read_csv', 'csv_stats', 'csv_preview', 'yaml_parse', 'yaml_query', 'yaml_keys', 'html_to_text', 'html_links', 'html_metadata', 'html_headings', 'markdown_to_html', 'markdown_outline', 'markdown_links', 'markdown_code_blocks', 'xml_to_text', 'xml_summary', 'xml_query', 'ini_parse', 'properties_parse', 'toml_parse', 'rtf_to_text', 'pdf_to_text', 'image_info', 'image_batch_info', 'image_aspect_ratio', 'image_dominant_colors', 'image_transparency', 'image_content_bounds', 'list_zip', 'zip_summary',
  'word_count', 'head_tail', 'sort_lines', 'replace_text', 'extract_matches', 'trim_text', 'strip_empty_lines', 'dedupe_lines', 'filter_lines', 'text_slice', 'extract_between', 'text_case', 'reverse_text', 'split_text', 'join_text', 'text_frequency', 'line_prefix', 'line_suffix', 'text_contains', 'text_starts_with', 'text_ends_with', 'text_repeat', 'text_truncate', 'text_index_of', 'char_at', 'common_prefix_text', 'common_suffix_text', 'line_numbers', 'line_lengths', 'longest_line', 'shortest_line', 'first_nonempty_line', 'last_nonempty_line', 'count_substring', 'text_equals', 'text_compare', 'text_pad', 'text_wrap', 'text_unwrap', 'text_remove_prefix', 'text_remove_suffix', 'nth_line', 'take_lines', 'drop_lines', 'line_contains', 'text_slugify', 'text_surround', 'text_repeat_lines', 'text_length', 'text_is_empty',
  'base64_encode', 'base64_decode', 'hash_text', 'url_encode', 'url_decode', 'uuid_generate', 'base_convert', 'parse_byte_size', 'byte_size_format', 'format_duration', 'duration_parse', 'current_datetime', 'date_diff', 'calculate', 'number_sum', 'number_average', 'number_median', 'number_min_max', 'number_stats', 'round_number', 'clamp_number', 'percentage_of', 'sequence_generate', 'ratio_simplify', 'number_abs', 'number_sign', 'number_compare', 'number_sort', 'number_unique', 'number_product', 'percentage_change', 'number_range_check', 'number_scale', 'number_modulo', 'number_histogram', 'number_cumsum', 'number_percentile', 'linear_interpolate',
  'path_exists', 'path_normalize', 'path_join', 'path_relative', 'path_dirname', 'path_basename', 'path_extname', 'path_parts', 'path_is_absolute', 'path_change_ext', 'path_ancestors', 'path_depth', 'path_common_prefix', 'path_matches_glob', 'path_compare', 'path_stem', 'path_parent', 'nearest_ancestor_with', 'hidden_files', 'duplicate_filenames', 'sibling_files',
  'list_count', 'list_unique', 'list_sort', 'list_reverse', 'list_slice', 'list_chunk', 'list_union', 'list_intersect', 'list_diff', 'list_contains', 'list_frequency', 'list_join', 'list_index_of', 'list_flatten', 'list_zip_pairs',
  'dependency_tree', 'outdated_deps', 'list_scripts', 'which_command', 'env_get',
]);

const STANDARD_EXTRA_ALLOW = new Set([
  'write_file', 'append_file', 'write_json', 'format_json', 'json_merge', 'json_to_csv', 'csv_to_json', 'write_csv',
  'edit_lines', 'diff_files', 'rename_file', 'copy_file', 'make_dir',
  'create_docx', 'create_docx_table', 'insert_docx_image', 'create_pptx', 'create_xlsx', 'convert_to_pdf',
  'create_zip', 'extract_zip',
  'git_add', 'git_commit', 'git_branch', 'git_checkout', 'git_stash',
  'git_fetch', 'git_pull', 'git_merge', 'git_cherry_pick', 'git_tag',
  'git_reset', 'git_restore',
  'run_command',
  'poll_command',
  'apply_patch',
]);

export function resolveToolScope(options: {
  requested?: ToolScope;
  reasoningEffort?: ReasoningEffort;
  prompt: string;
  shouldUseTaskBoard: boolean;
}): ResolvedToolScope {
  if (options.requested && options.requested !== 'auto') return options.requested;

  const complexity = analyzeTaskComplexity(options.prompt).complexity;
  if (options.shouldUseTaskBoard || complexity === 'large') return 'full';

  // Preserve the existing explicit high/max expansion, including for a small
  // prompt whose caller deliberately requested stronger reasoning.
  if (options.reasoningEffort === 'high' || options.reasoningEffort === 'max') return 'full';
  if (complexity === 'small') return 'compact';
  return 'standard';
}

export function selectScopedTools(registry: ToolRegistry, scope: ResolvedToolScope): ToolDefinition[] {
  const all = registry.list();
  if (scope === 'full') return all;
  const allow = scope === 'compact'
    ? COMPACT_ALLOW
    : new Set([...COMPACT_ALLOW, ...STANDARD_EXTRA_ALLOW]);
  return all.filter((tool) => {
    if (allow.has(tool.name)) return true;
    if (scope === 'compact' && tool.name.startsWith('plugin_')) return false;
    if (scope === 'compact' && tool.name.startsWith('mcp_')) return false;
    if (scope === 'standard' && tool.name.startsWith('plugin_')) return tool.risk === 'read';
    if (scope === 'standard' && tool.name.startsWith('mcp_')) return tool.risk === 'read';
    return false;
  });
}

/**
 * Hard ceiling on the number of tools sent in one request. Anthropic and
 * several Anthropic-compatible relays reject an oversized tool array outright
 * ("400 Maximum tools limit reached ... the maximum is 350"), which fails EVERY
 * turn instead of degrading. Stay a margin under the common 350 ceiling.
 */
export const MAX_PROVIDER_TOOLS = 340;

/**
 * Built-ins a coding agent reaches for constantly that are not part of the
 * read/write allowlists (they are gates and lookups rather than file access).
 * Promoted so the cap never trades them away for rarely used utilities.
 */
const HIGH_VALUE_EXTRA = new Set([
  'typecheck', 'lint', 'run_tests', 'web_search', 'fetch_url', 'todo_report',
]);

/**
 * Trim a tool list to the provider ceiling without dropping what an agent
 * actually needs. Plain alphabetical truncation would cut `write_file` and
 * `search_text` (late letters) while keeping dozens of numeric utilities, so
 * rank by usefulness first:
 *   0. protected tools (injected after scope selection; never trimmed)
 *   1. mutating/execution core (write, edit, run, git) — without these the agent cannot work
 *   2. read/inspection allowlist + high-value gates
 *   3. other built-in tools
 *   4. plugin_/mcp_ bridge tools (largest, most replaceable block)
 */
export function limitProviderTools(
  tools: ToolDefinition[],
  options: { max?: number; protectedNames?: ReadonlySet<string> } = {},
): { tools: ToolDefinition[]; dropped: string[] } {
  const max = options.max ?? MAX_PROVIDER_TOOLS;
  const protectedNames = options.protectedNames ?? new Set<string>();
  if (tools.length <= max) return { tools, dropped: [] };
  const rank = (tool: ToolDefinition): number => {
    if (protectedNames.has(tool.name)) return 0;
    if (STANDARD_EXTRA_ALLOW.has(tool.name)) return 1;
    if (COMPACT_ALLOW.has(tool.name) || HIGH_VALUE_EXTRA.has(tool.name)) return 2;
    if (tool.name.startsWith('plugin_') || tool.name.startsWith('mcp_')) return 4;
    return 3;
  };
  const ranked = [...tools].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    return byRank !== 0 ? byRank : a.name.localeCompare(b.name);
  });
  const kept = ranked.slice(0, max);
  const dropped = ranked.slice(max).map((tool) => tool.name);
  // Restore deterministic alphabetical order for the provider payload.
  kept.sort((a, b) => a.name.localeCompare(b.name));
  return { tools: kept, dropped };
}
