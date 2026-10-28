import type { ReasoningEffort } from '../providers/types.js';
import { analyzeTaskComplexity } from '../tasks/complexity.js';
import type { ToolRegistry } from './registry.js';
import type { ToolDefinition } from './types.js';

export type ToolScope = 'auto' | 'compact' | 'standard' | 'full';
export type ResolvedToolScope = 'compact' | 'standard' | 'full';

/** Widening order. Used to compare scopes, never to index a tool list. */
export const SCOPE_RANK: Record<ResolvedToolScope, number> = { compact: 0, standard: 1, full: 2 };

/** The wider of two scopes. */
export function widestScope(a: ResolvedToolScope, b: ResolvedToolScope): ResolvedToolScope {
  return SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b;
}

const RESOLVED_TOOL_SCOPES: ReadonlySet<string> = new Set(['compact', 'standard', 'full']);

/**
 * Plain boolean membership test. Kept separate from the type predicate below
 * so a guard on a `ToolScope` does not narrow 'auto' out of the remaining
 * branch — the guards here need "is this a *resolved* scope", not "is this
 * exactly the resolved union".
 */
function isScopeMember(value: unknown): boolean {
  return typeof value === 'string' && RESOLVED_TOOL_SCOPES.has(value);
}

/** Whether a runtime value is one of the three resolved scopes. */
export function isResolvedToolScope(value: unknown): value is ResolvedToolScope {
  return isScopeMember(value);
}

/**
 * Raw scope values already reported. A bogus value is re-normalised every turn
 * (the scope is resolved per prompt), so without this the warning would print
 * once per turn. Keyed by the raw value, so two different mistakes both speak.
 */
const warnedScopeValues = new Set<string>();

function warnUnknownScope(value: unknown): void {
  const key = JSON.stringify(value) ?? String(value);
  if (warnedScopeValues.has(key)) return;
  warnedScopeValues.add(key);
  // console.error, not a logger: this module is imported by pure callers
  // (audit/contextLedger, subagent/tool-ceiling) that have no UI to hand. The
  // existing convention for a pure module reporting a problem is stderr.
  console.error(
    `[ToolScope] Unknown tool scope ${key}; falling back to "compact". Expected one of: compact, standard, full, auto.`,
  );
}

/**
 * Fail closed on an unrecognised scope.
 *
 * `ResolvedToolScope` is a union at the type level, but runtime values reach
 * `selectScopedTools` through casts (runtime/createRuntime.ts:97
 * `(config.toolScope ?? 'auto') as ToolScope`) and hand-written config files.
 * Measured on this registry, an unknown value used to take the allowlist-union
 * branch and select 236 tools — COMPACT_ALLOW ∪ STANDARD_EXTRA_ALLOW, i.e.
 * compact plus every write/shell tool — because every `scope === 'standard'`
 * gate was false. That is wider than compact, so the fallback used to fail
 * OPEN. Anything not in the union now degrades to the narrowest defined scope
 * and says so on stderr; a silent narrowing would be just as hard to diagnose.
 */
export function normalizeToolScope(value: unknown): ResolvedToolScope {
  if (isResolvedToolScope(value)) return value;
  warnUnknownScope(value);
  return 'compact';
}

/**
 * Tools that can start another agent, and therefore can cause a write **without
 * themselves being a write-risk tool**.
 *
 * `risk` answers "does calling this touch the world?", which is the wrong
 * question for delegation: `spawn_subagent` has risk `read` because the call
 * itself writes nothing, but with `readonly: false` (its default) it starts a
 * sub-agent that can write, run commands, and commit. `review_loop` is the same
 * shape — a review-and-revise loop whose executor edits files.
 *
 * So a filter that means "this agent must not change anything" cannot be
 * expressed with `risk === 'read'` alone. Anything claiming read-only-ness has
 * to consult this list, and the reviewers that rely on that claim are tested
 * against it (tests/review-readonly.test.ts).
 *
 * Membership here answers "is this read-only?", NOT "does the default scope
 * expose it?" — the second question is DELEGATION_TOOLS.
 */
export const AGENT_SPAWNING_TOOLS: ReadonlySet<string> = new Set([
  'spawn_subagent',
  'review_loop',
  'workflow_execute',
  'workflow_resume',
]);

/**
 * The delegation tools `standard` exposes on purpose, even though they are in
 * AGENT_SPAWNING_TOOLS. Without `spawn_subagent` a large file set can only be
 * read one tool call at a time; without `review_loop` nothing ever looks at
 * this session's output from outside this session. Two schemas are a cheap
 * price for that at the default scope — the trade and its cost are argued at
 * the use site in `selectScopedTools`.
 *
 * A separate named set rather than inline name comparisons, because this is a
 * *subset* of AGENT_SPAWNING_TOOLS: `isReadOnlyTool` must keep subtracting all
 * four, since the read-only experts and reviewers depend on that
 * (src/experts/profiles.ts, tests/review-readonly.test.ts). Widening the
 * default scope must not widen what "read-only" means.
 */
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set([
  'spawn_subagent',
  'review_loop',
]);

/** Whether a tool could cause a write by starting another agent. */
export function canSpawnAgent(toolName: string): boolean {
  return AGENT_SPAWNING_TOOLS.has(toolName);
}

/**
 * Whether a tool is genuinely read-only: it touches nothing itself AND it
 * cannot delegate to something that does.
 */
export function isReadOnlyTool(tool: { name: string; risk: string }): boolean {
  return tool.risk === 'read' && !canSpawnAgent(tool.name);
}

const COMPACT_ALLOW = new Set([
  'project_status', 'recent_activity', 'environment_info', 'cache_probe',
  'git_status', 'git_diff', 'git_diff_staged', 'git_log', 'git_show', 'git_blame',
  'list_files', 'read_file', 'read_lines', 'read_many_files', 'search_text', 'find_files', 'count_files', 'file_info', 'list_tree', 'glob_files', 'filename_search', 'recent_files', 'largest_files', 'directory_summary', 'directory_depth_summary', 'list_dirs', 'empty_dirs', 'file_extensions_in_dir',
  'find_symbol', 'find_references', 'project_index', 'ts_hover', 'ts_goto_definition', 'ts_exact_references',
  'read_json', 'json_keys', 'json_type_summary', 'read_csv', 'csv_stats', 'csv_preview', 'yaml_parse', 'yaml_query', 'yaml_keys', 'html_to_text', 'html_links', 'html_metadata', 'html_headings', 'markdown_to_html', 'markdown_outline', 'markdown_links', 'markdown_code_blocks', 'xml_to_text', 'xml_summary', 'xml_query', 'ini_parse', 'properties_parse', 'toml_parse', 'rtf_to_text', 'pdf_to_text', 'docx_to_text', 'image_info', 'image_batch_info', 'image_aspect_ratio', 'image_dominant_colors', 'image_transparency', 'image_content_bounds', 'list_zip', 'zip_summary',
  'word_count', 'head_tail', 'sort_lines', 'replace_text', 'extract_matches', 'trim_text', 'strip_empty_lines', 'dedupe_lines', 'filter_lines', 'text_slice', 'extract_between', 'text_case', 'reverse_text', 'split_text', 'join_text', 'text_frequency', 'line_prefix', 'line_suffix', 'text_contains', 'text_starts_with', 'text_ends_with', 'text_repeat', 'text_truncate', 'text_index_of', 'char_at', 'common_prefix_text', 'common_suffix_text', 'line_numbers', 'line_lengths', 'longest_line', 'shortest_line', 'first_nonempty_line', 'last_nonempty_line', 'count_substring', 'text_equals', 'text_compare', 'text_pad', 'text_wrap', 'text_unwrap', 'text_remove_prefix', 'text_remove_suffix', 'nth_line', 'take_lines', 'drop_lines', 'line_contains', 'text_slugify', 'text_surround', 'text_repeat_lines', 'text_length', 'text_is_empty',
  'base64_encode', 'base64_decode', 'hash_text', 'url_encode', 'url_decode', 'uuid_generate', 'base_convert', 'parse_byte_size', 'byte_size_format', 'format_duration', 'duration_parse', 'current_datetime', 'date_diff', 'calculate', 'number_sum', 'number_average', 'number_median', 'number_min_max', 'number_stats', 'round_number', 'clamp_number', 'percentage_of', 'sequence_generate', 'ratio_simplify', 'number_abs', 'number_sign', 'number_compare', 'number_sort', 'number_unique', 'number_product', 'percentage_change', 'number_range_check', 'number_scale', 'number_modulo', 'number_histogram', 'number_cumsum', 'number_percentile', 'linear_interpolate',
  'path_exists', 'path_normalize', 'path_join', 'path_relative', 'path_dirname', 'path_basename', 'path_extname', 'path_parts', 'path_is_absolute', 'path_change_ext', 'path_ancestors', 'path_depth', 'path_common_prefix', 'path_matches_glob', 'path_compare', 'path_stem', 'path_parent', 'nearest_ancestor_with', 'hidden_files', 'duplicate_filenames', 'sibling_files',
  'list_count', 'list_unique', 'list_sort', 'list_reverse', 'list_slice', 'list_chunk', 'list_union', 'list_intersect', 'list_diff', 'list_contains', 'list_frequency', 'list_join', 'list_index_of', 'list_flatten', 'list_zip_pairs',
  'dependency_tree', 'outdated_deps', 'list_scripts', 'which_command', 'env_get',
  // Web reading is a *read* act in every way that matters to this scope: it
  // inspects something outside the repository and changes nothing locally. It
  // used to be excluded, so "打开 https://arxiv.org 找一篇论文" resolved to
  // compact and then had no fetch_url, no web_search and no download_file — the
  // agent could not carry out the request it had just been told was small. All
  // three still pass the network gate (evaluateNetworkTarget + decideApproval),
  // which is where the actual permission decision belongs.
  'fetch_url', 'web_search', 'download_file', 'html_links',
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
  /**
   * The scope already resolved earlier in this session, if any. Supplying it
   * makes the resolution monotonic: a session never narrows.
   *
   * WHY. The tool array is serialized into the request BEFORE the system block,
   * and providers evaluate the prompt prefix in order (tools → system →
   * messages). So the tool array sits inside the cached prefix, and any change
   * to it invalidates the cache from byte 0 — the carefully stabilised system
   * prompt cannot help, because the first difference appears before it.
   *
   * Resolution here is driven by the turn's PHRASE, so without a floor it flaps:
   * measured on this repo, "这个项目是干什么的" resolved standard (232 tools) and
   * the next turn's "读一下 package.json" resolved compact (196) — 36 tools
   * dropped, tool array rewritten, cache dead. A user rephrasing a question
   * silently changed the tool surface, which is also the reliability complaint:
   * what the agent could do last turn it might not do this turn.
   *
   * With the floor, the array only ever grows, so the cached prefix stays valid
   * for everything before the newly added tools. A session that needs the write
   * tools once keeps them; a session that never does stays small.
   */
  previousScope?: ResolvedToolScope;
}): ResolvedToolScope {
  // An explicit request is the user (or the desktop scope picker) speaking, so
  // it wins outright and is NOT floored — otherwise picking 紧凑 in the UI would
  // silently do nothing after any turn had widened the scope.
  //
  // Validated, because this is the single point every scope source funnels
  // through: the CLI parser, AICODE_TOOL_SCOPE, the config file, the desktop
  // bridge and expert routing. A hand-written config value (or a cast upstream)
  // that is not one of the three resolved scopes used to pass through verbatim
  // and widen the surface. 'auto' stays legal here (it is a ToolScope, and is
  // interpreted below); everything else unknown falls back to compact.
  // `isScopeMember` is consulted before the `!== 'auto'` test so that an empty
  // string, which is falsy, is reported rather than silently read as `auto`.
  if (options.requested !== undefined && options.requested !== 'auto' && !isScopeMember(options.requested)) {
    return normalizeToolScope(options.requested);
  }
  if (options.requested && options.requested !== 'auto') return options.requested;

  const resolved = resolveToolScopeForTurn(options);
  const previous = options.previousScope;
  if (previous === undefined) return resolved;
  if (!isScopeMember(previous)) return normalizeToolScope(previous);
  return widestScope(previous, resolved);
}

/**
 * The per-turn mapping from phrase to scope, without the session floor.
 * Exported for tests and for callers that genuinely want the raw signal.
 */
export function resolveToolScopeForTurn(options: {
  requested?: ToolScope;
  reasoningEffort?: ReasoningEffort;
  prompt: string;
  shouldUseTaskBoard: boolean;
}): ResolvedToolScope {
  // Same validation as resolveToolScope: the raw signal may also arrive with a
  // value the type does not admit (both scope entries above call this).
  // 'auto' is legal — this function exists to interpret it.
  if (options.requested !== undefined && options.requested !== 'auto' && !isScopeMember(options.requested)) {
    return normalizeToolScope(options.requested);
  }
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
  // The second gate. The union is only a type; runtime values arrive through
  // casts and JSON config, so this entrance re-checks it even though
  // resolveToolScope already normalises. Measured before this guard: a bogus
  // value selected 236 tools (compact plus all 36 write/shell tools) — see
  // normalizeToolScope. Legacy 'auto' arrives here unwidened in a few callers;
  // it is not a resolved scope, so it takes the same documented fallback.
  scope = normalizeToolScope(scope);
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
    /*
     * standard is the default scope, so whatever it omits is what the agent
     * reaches for a shell command to do by hand — and hand-written shell is
     * where the observed failures came from. The allowlists above are an
     * enumeration, so every new analysis tool used to be invisible here until
     * someone remembered to add its name; measured on this registry, 127 of 363
     * tools were missing from standard, 92 of them read-only.
     *
     * Read-only is the safe axis to open by: the tool touches nothing, and
     * `isReadOnlyTool` subtracts the members of AGENT_SPAWNING_TOOLS, which
     * only *look* read — starting an agent can write whatever the caller's own
     * `risk` label says.
     *
     * Those delegation tools used to stay out for the reason above ("delegation
     * is a deliberate choice, not a default"). That call has been reversed for
     * the two in DELEGATION_TOOLS. Without `spawn_subagent` a large file set is
     * read one call at a time, which is the serial path the scope exists to
     * avoid; without `review_loop` nothing ever reviews this session's output
     * from outside it, and self-review does not catch what an independent pass
     * does. Two schemas for parallel reading plus an external review is the
     * better trade at the default scope.
     *
     * What it costs: the surface is no longer constant inside a session, and it
     * now varies in *capability*, not only in size — a turn resolving standard
     * and a turn resolving compact now differ by tools that can write through a
     * sub-agent. The tool array is serialized ahead of the system block, so
     * every such change invalidates the cached prefix from byte 0. That is why
     * the widen-only floor in `resolveToolScope` is load-bearing rather than
     * tidy: without it, one rephrased prompt could take writes away again
     * mid-session — cache dead, and the agent unable to finish what it started.
     *
     * The workflow tools stay out on purpose, despite the same risk shape. The
     * difference is what they are for: `spawn_subagent` and `review_loop` are
     * ways to do the current task faster or better, while `workflow_execute` /
     * `workflow_resume` replay a stored plan unattended — a mode switch rather
     * than a reading strategy. Nothing in the default scope's job needs one, so
     * paying two schemas for them would buy no behaviour, and role-scoped
     * callers that must not write would still have to subtract them.
     */
    if (scope === 'standard' && isReadOnlyTool(tool)) return true;
    // The one deliberate exception, and only for delegation — the schema trade
    // and what it costs the cache are argued in the comment above.
    if (scope === 'standard' && DELEGATION_TOOLS.has(tool.name)) return true;
    /*
     * HIGH_VALUE_EXTRA was declared for `limitProviderTools`' ranking and never
     * read here, so `run_tests`, `lint` and `typecheck` were absent from
     * standard despite being listed as tools "a coding agent reaches for
     * constantly". They are shell-risk, so the read-only rule above cannot
     * reach them, and without them the agent shells out to run tests — which is
     * strictly worse than a structured call. They do not widen what standard
     * can do: `run_command` is already in it.
     */
    if (scope === 'standard' && HIGH_VALUE_EXTRA.has(tool.name)) return true;
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
 *   3. other read-only built-ins (analysis, lint, suggestions — nothing lost
 *      from the *capability* surface if they go, but they are the safest block
 *      to keep: they cannot write, run, or spawn an agent)
 *   4. other mutating/execution built-ins
 *   5. plugin_/mcp_ bridge tools (largest, most replaceable block)
 *
 * Why read-only sorts ahead of the rest of rank 3-4. That block used to share
 * one bucket, ordered alphabetically, so the cap cut whichever names happened
 * to sort late — measured on this tree with every desktop switch on (computer
 * + background browser/app/native, 38 injected tools), `full` reaches 399 and
 * the cap drops 59; 49 of those were read-only analysis tools (repo_map,
 * semantic_search, review_code, ...) while only 10 were write/shell tools. The
 * dropped set was decided by letters, not by what the session loses. Splitting
 * the bucket keeps the read-only tools (the cheap, safe surface) and spends
 * the cap on the write/execution tools instead: on the same input, 28
 * read-only + 31 write/execution dropped, and the read-only remainder is
 * exactly the number left after every non-read-only built-in is spent.
 *
 * The delegation tools do not need a rank of their own: they are registered
 * post-scope (src/agent/agent.ts), so they always arrive as protected names and
 * land in rank 0.
 *
 * standard DOES reach the cap. The old note here said it scoped to 332 of 340;
 * that is only true with the desktop switches off. Measured on this tree:
 * standard alone is 332, but standard plus the post-scope block (33
 * computer / background_* / computer_* tools from the desktop switches, plus
 * spawn_subagent, review_loop, propose_plan, supervisor_status,
 * open_pull_request) is 368, so the trim drops 28 — all of them read-only
 * analysis tools. `full` is 363 scoped and 399 injected (rank 0/1/2/3/4 =
 * 38/36/204/90/31), so it drops 28 read-only plus the whole 31-tool rank 4.
 * `compact` is 200 scoped and 238 injected, and never reaches the cap.
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
    if (tool.name.startsWith('plugin_') || tool.name.startsWith('mcp_')) return 5;
    if (isReadOnlyTool(tool)) return 3;
    return 4;
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
