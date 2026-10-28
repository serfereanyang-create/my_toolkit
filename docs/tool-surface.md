# Tool surface: scopes, read-only-ness, risk

Reference for what the agent can actually call, by scope. Every number and row
below was generated from the built registry (`dist/src/tools/index.js`) and the
scope filter itself (`src/tools/scope.ts`) — nothing here is estimated. See
`docs/capability-matrix.md` for the feature-level view.

## 1. How a turn's scope is decided

`resolveToolScope` (`src/tools/scope.ts:108`) is called once per turn from
`src/agent/agent.ts:716-729`:

| input | result |
| --- | --- |
| explicit `/scope compact\|standard\|full`, config `toolScope`, desktop picker | that scope, verbatim — **not** floored |
| task board active, or `analyzeTaskComplexity(prompt) === 'large'` | `full` |
| `reasoningEffort` `high` / `max` | `full` |
| complexity `small` | `compact` |
| otherwise | `standard` |

The session keeps a **widen-only floor** (`sessionToolScopeFloor`,
`src/agent/agent.ts:154` and `:725`): `resolveToolScope` returns
`widestScope(previous, resolved)`, so a session never narrows once it has
widened. The reason is cache shape, not taste — the tool array is serialized
*before* the system block, so any change to it invalidates the cached prompt
prefix from byte 0.

## 2. Counts per scope (static registry)

| Scope | Tools | read | write | shell | network |
| --- | --- | --- | --- | --- | --- |
| `compact` | 200 | 197 | 0 | 0 | 3 |
| `standard` | 332 | 295 | 29 | 5 | 3 |
| `full` | 363 | 295 | 57 | 7 | 4 |

`compact ⊂ standard ⊂ full` holds by construction (`standard` is
`COMPACT_ALLOW ∪ STANDARD_EXTRA_ALLOW` plus two open criteria), so the table
below only needs three scope labels.

`standard` deliberately omits 31 of 363:

- 28 write: `apply_unified_diff`, `build_semantic_index`, `codegen_express_route`,
  `codegen_generate`, `codegen_generate_batch`, `codegen_interface`,
  `codegen_react_component`, `delete_path`, `extract_method`, `generate_api_docs`,
  `generate_architecture_doc`, `generate_changelog`, `generate_coverage_badge`,
  `generate_eslint_config`, `generate_readme`, `generate_release_notes`,
  `generate_tests`, `git_init`, `health_clear_history`, `memory_digest`,
  `openapi_ts`, `reflection_forget`, `rename_symbol`, `scaffold_project`,
  `test_generate`, `workflow_execute`, `workflow_resume`, `workspace_run`
- 2 shell: `install_deps`, `run_script`
- 1 network: `http_post`

`compact` omits 163. It is an allowlist (`COMPACT_ALLOW`) of inspection tools
plus the three web reads (`fetch_url`, `web_search`, `download_file`) — no write
tool and no shell tool at all.

`standard` is a union of six rules, not one list (`src/tools/scope.ts:168-235`):

1. `COMPACT_ALLOW` ∪ `STANDARD_EXTRA_ALLOW` (the explicit names),
2. every tool where `isReadOnlyTool` is true — this is why the analysis surface
   (nav, audit, prreview, quality, health scans) shows up without being listed,
3. `DELEGATION_TOOLS` = `spawn_subagent`, `review_loop` — in on purpose, and the
   only members of `AGENT_SPAWNING_TOOLS` that are,
4. `HIGH_VALUE_EXTRA` = `typecheck`, `lint`, `run_tests`, `web_search`,
   `fetch_url`, `todo_report` (the three shell-risk verification tools are here;
   without them the agent shells out to run tests),
5. `plugin_*` tools, only when `risk === 'read'`,
6. `mcp_*` bridge tools, only when `risk === 'read'`.

`compact` never exposes `plugin_*` or `mcp_*`, whatever their risk.

## 3. Read-only is not `risk === 'read'`

`ToolDefinition` has no `readonly` flag. Read-only means `isReadOnlyTool`
(`src/tools/scope.ts:70`): `risk === 'read'` **and** not in
`AGENT_SPAWNING_TOOLS` (`spawn_subagent`, `review_loop`, `workflow_execute`,
`workflow_resume`). Those four call themselves `read`/low-risk but can start an
agent that writes, and a child's approvals are auto-accepted (see §5), so a
plain risk check would hand any "read-only" caller a write path.

294 of 363 tools are read-only by that definition (295 have `risk: 'read'`; the
difference is `spawn_subagent`).

## 4. Injected after scope selection — present at every scope

`src/agent/agent.ts:731-804` registers these *after* `selectScopedTools`, so
they are not part of the 200/332/363 above and exist even in `compact`:

| Tool | Condition |
| --- | --- |
| `spawn_subagent` | always |
| `review_loop` | root agent only (`subAgentDepth === 0`) |
| `propose_plan` | root agent only |
| `supervisor_status`, `open_pull_request` | root agent only |
| `computer_*` | `computerUseActive` |
| `background_*` | host tool bridge active |

So a root turn that resolved `compact` sends 205 tools, not 200. Note the shape:
`compact` is "no write/shell tool **in the registry set**", not "read-only" — it
does expose a delegation tool and a review loop. They do not widen capability,
because a child's ceiling is the parent's own set (§5), so a compact child has
no write tool either; what compact gains is concurrency, not reach.

## 5. Delegated children never exceed the parent

`subAgentToolCeiling` (`src/subagent/runner.ts:36`) sources a child's registry
from `parentRuntime.tools` (the parent's resolved set, injections included) and
only falls back to `allTools` when the parent has no resolved scope (tests,
embedding callers). The expert profile then narrows it further. Approvals inside
the child are hardcoded to `true` (`src/subagent/runner.ts:285-286`), so `ask`
and `plan` confirmations do not reach a delegated write; `deny` still blocks,
because `decideApproval` runs before `confirm` (`src/tools/registry.ts:63-91`).
Depth is capped at 3 (`MAX_SUBAGENT_DEPTH`, `src/subagent/tool.ts:30`).

## 6. Provider ceiling

`MAX_PROVIDER_TOOLS = 340` (`src/tools/scope.ts:243`), applied last, after the
injections, by `limitProviderTools` — protected names (the injected ones) are
never trimmed, then mutating core, then the read/gate allowlists, then plugins
and MCP bridges. Contiguous 350-tool endpoints reject the whole request, which
would fail every turn, so the cap is 10 under. `standard` (332 + 5 injections =
337) stays under it; the cap only bites in `full` with plugin/MCP tools loaded.

## 7. Full table

Generated. `all` = compact, standard and full; `standard+full` = hidden from
compact; `full` = standard omits it too. Read-only = `isReadOnlyTool`.

The scope column is what the **filter** says. `spawn_subagent` and `review_loop`
read `standard+full` here and are still present in a compact turn, because they
are injected after scope selection (§4) — the column describes
`selectScopedTools`, not the final request.

| Tool | Scope | Read-only | Risk |
| --- | --- | --- | --- |
| `analyze_complexity` | standard+full | yes | read |
| `analyze_coverage` | standard+full | yes | read |
| `analyze_dependencies` | standard+full | yes | read |
| `analyze_performance` | standard+full | yes | read |
| `append_file` | standard+full | no | write |
| `apply_patch` | standard+full | no | write |
| `apply_unified_diff` | full | no | write |
| `audit_code_quality` | standard+full | yes | read |
| `audit_dependencies` | standard+full | yes | read |
| `base_convert` | all | yes | read |
| `base64_decode` | all | yes | read |
| `base64_encode` | all | yes | read |
| `benchmark_file_function` | standard+full | yes | read |
| `build_code_graph` | standard+full | yes | read |
| `build_semantic_index` | full | no | write |
| `byte_size_format` | all | yes | read |
| `cache_health` | standard+full | yes | read |
| `cache_probe` | all | yes | read |
| `calculate` | all | yes | read |
| `char_at` | all | yes | read |
| `clamp_number` | all | yes | read |
| `class_metrics` | standard+full | yes | read |
| `codebase_search` | standard+full | yes | read |
| `codegen_express_route` | full | no | write |
| `codegen_generate` | full | no | write |
| `codegen_generate_batch` | full | no | write |
| `codegen_interface` | full | no | write |
| `codegen_list_templates` | standard+full | yes | read |
| `codegen_react_component` | full | no | write |
| `comment_density` | standard+full | yes | read |
| `commit_lint` | standard+full | yes | read |
| `common_prefix_text` | all | yes | read |
| `common_suffix_text` | all | yes | read |
| `complexity_hotspots` | standard+full | yes | read |
| `convert_to_pdf` | standard+full | no | write |
| `copy_file` | standard+full | no | write |
| `count_files` | all | yes | read |
| `count_substring` | all | yes | read |
| `coverage_gate` | standard+full | yes | read |
| `create_docx` | standard+full | no | write |
| `create_docx_table` | standard+full | no | write |
| `create_pptx` | standard+full | no | write |
| `create_xlsx` | standard+full | no | write |
| `create_zip` | standard+full | no | write |
| `csv_preview` | all | yes | read |
| `csv_stats` | all | yes | read |
| `csv_to_json` | standard+full | yes | read |
| `current_datetime` | all | yes | read |
| `date_diff` | all | yes | read |
| `dedupe_lines` | all | yes | read |
| `delete_path` | full | no | write |
| `dependency_tree` | all | yes | read |
| `detect_code_clones` | standard+full | yes | read |
| `detect_code_smells` | standard+full | yes | read |
| `detect_duplicate_deps` | standard+full | yes | read |
| `detect_import_cycles` | standard+full | yes | read |
| `detect_regression_from_history` | standard+full | yes | read |
| `diff_files` | standard+full | yes | read |
| `directory_depth_summary` | all | yes | read |
| `directory_summary` | all | yes | read |
| `disk_growth` | standard+full | yes | read |
| `disk_info` | standard+full | yes | read |
| `docx_to_text` | all | yes | read |
| `download_file` | all | no | network |
| `drop_lines` | all | yes | read |
| `duplicate_filenames` | all | yes | read |
| `duration_parse` | all | yes | read |
| `edit_lines` | standard+full | no | write |
| `empty_dirs` | all | yes | read |
| `env_contract` | standard+full | yes | read |
| `env_get` | all | yes | read |
| `environment_info` | all | yes | read |
| `explain_code` | standard+full | yes | read |
| `extract_between` | all | yes | read |
| `extract_matches` | all | yes | read |
| `extract_method` | full | no | write |
| `extract_page_links` | standard+full | yes | read |
| `extract_zip` | standard+full | no | write |
| `fetch_url` | all | no | network |
| `file_coverage` | standard+full | yes | read |
| `file_extensions_in_dir` | all | yes | read |
| `file_info` | all | yes | read |
| `filename_search` | all | yes | read |
| `filter_lines` | all | yes | read |
| `find_files` | all | yes | read |
| `find_references` | all | yes | read |
| `find_similar_code` | standard+full | yes | read |
| `find_symbol` | all | yes | read |
| `find_unused_exports` | standard+full | yes | read |
| `find_unused_imports` | standard+full | yes | read |
| `first_nonempty_line` | all | yes | read |
| `format_duration` | all | yes | read |
| `format_json` | standard+full | yes | read |
| `function_signature_report` | standard+full | yes | read |
| `generate_api_docs` | full | no | write |
| `generate_architecture_doc` | full | no | write |
| `generate_changelog` | full | no | write |
| `generate_coverage_badge` | full | no | write |
| `generate_eslint_config` | full | no | write |
| `generate_function_test` | standard+full | yes | read |
| `generate_pr_description` | standard+full | yes | read |
| `generate_readme` | full | no | write |
| `generate_release_notes` | full | no | write |
| `generate_tests` | full | no | write |
| `git_add` | standard+full | no | write |
| `git_blame` | all | yes | read |
| `git_branch` | standard+full | no | write |
| `git_checkout` | standard+full | no | write |
| `git_cherry_pick` | standard+full | no | write |
| `git_commit` | standard+full | no | write |
| `git_diff` | all | yes | read |
| `git_diff_staged` | all | yes | read |
| `git_fetch` | standard+full | no | write |
| `git_hotspots` | standard+full | yes | read |
| `git_init` | full | no | write |
| `git_log` | all | yes | read |
| `git_merge` | standard+full | no | write |
| `git_pull` | standard+full | no | write |
| `git_quality` | standard+full | yes | read |
| `git_reset` | standard+full | no | write |
| `git_restore` | standard+full | no | write |
| `git_show` | all | yes | read |
| `git_stash` | standard+full | no | write |
| `git_status` | all | yes | read |
| `git_tag` | standard+full | no | write |
| `glob_files` | all | yes | read |
| `hash_text` | all | yes | read |
| `head_tail` | all | yes | read |
| `health_clear_history` | full | no | write |
| `health_report` | standard+full | yes | read |
| `health_snapshot` | standard+full | yes | read |
| `hidden_files` | all | yes | read |
| `html_headings` | all | yes | read |
| `html_links` | all | yes | read |
| `html_metadata` | all | yes | read |
| `html_to_text` | all | yes | read |
| `http_post` | full | no | network |
| `image_aspect_ratio` | all | yes | read |
| `image_batch_info` | all | yes | read |
| `image_content_bounds` | all | yes | read |
| `image_dominant_colors` | all | yes | read |
| `image_info` | all | yes | read |
| `image_transparency` | all | yes | read |
| `impact_analysis` | standard+full | yes | read |
| `incremental_coverage` | standard+full | yes | read |
| `ini_parse` | all | yes | read |
| `insert_docx_image` | standard+full | no | write |
| `install_deps` | full | no | shell |
| `join_text` | all | yes | read |
| `json_keys` | all | yes | read |
| `json_merge` | standard+full | yes | read |
| `json_to_csv` | standard+full | yes | read |
| `json_type_summary` | all | yes | read |
| `lang_histogram` | standard+full | yes | read |
| `largest_files` | all | yes | read |
| `last_nonempty_line` | all | yes | read |
| `line_contains` | all | yes | read |
| `line_lengths` | all | yes | read |
| `line_numbers` | all | yes | read |
| `line_prefix` | all | yes | read |
| `line_suffix` | all | yes | read |
| `linear_interpolate` | all | yes | read |
| `lint` | standard+full | no | shell |
| `list_chunk` | all | yes | read |
| `list_contains` | all | yes | read |
| `list_count` | all | yes | read |
| `list_diff` | all | yes | read |
| `list_dirs` | all | yes | read |
| `list_files` | all | yes | read |
| `list_flatten` | all | yes | read |
| `list_frequency` | all | yes | read |
| `list_index_of` | all | yes | read |
| `list_intersect` | all | yes | read |
| `list_join` | all | yes | read |
| `list_reverse` | all | yes | read |
| `list_scripts` | all | yes | read |
| `list_slice` | all | yes | read |
| `list_sort` | all | yes | read |
| `list_tree` | all | yes | read |
| `list_union` | all | yes | read |
| `list_unique` | all | yes | read |
| `list_zip` | all | yes | read |
| `list_zip_pairs` | all | yes | read |
| `lockfile_diff` | standard+full | yes | read |
| `longest_line` | all | yes | read |
| `make_dir` | standard+full | no | write |
| `markdown_code_blocks` | all | yes | read |
| `markdown_links` | all | yes | read |
| `markdown_outline` | all | yes | read |
| `markdown_to_html` | all | yes | read |
| `memory_digest` | full | no | write |
| `naming_check` | standard+full | yes | read |
| `nearest_ancestor_with` | all | yes | read |
| `nth_line` | all | yes | read |
| `number_abs` | all | yes | read |
| `number_average` | all | yes | read |
| `number_compare` | all | yes | read |
| `number_cumsum` | all | yes | read |
| `number_histogram` | all | yes | read |
| `number_median` | all | yes | read |
| `number_min_max` | all | yes | read |
| `number_modulo` | all | yes | read |
| `number_percentile` | all | yes | read |
| `number_product` | all | yes | read |
| `number_range_check` | all | yes | read |
| `number_scale` | all | yes | read |
| `number_sign` | all | yes | read |
| `number_sort` | all | yes | read |
| `number_stats` | all | yes | read |
| `number_sum` | all | yes | read |
| `number_unique` | all | yes | read |
| `openapi_ts` | full | no | write |
| `outdated_deps` | all | yes | read |
| `parse_byte_size` | all | yes | read |
| `parse_url` | standard+full | yes | read |
| `path_ancestors` | all | yes | read |
| `path_basename` | all | yes | read |
| `path_change_ext` | all | yes | read |
| `path_common_prefix` | all | yes | read |
| `path_compare` | all | yes | read |
| `path_depth` | all | yes | read |
| `path_dirname` | all | yes | read |
| `path_exists` | all | yes | read |
| `path_extname` | all | yes | read |
| `path_is_absolute` | all | yes | read |
| `path_join` | all | yes | read |
| `path_matches_glob` | all | yes | read |
| `path_normalize` | all | yes | read |
| `path_parent` | all | yes | read |
| `path_parts` | all | yes | read |
| `path_relative` | all | yes | read |
| `path_stem` | all | yes | read |
| `pdf_to_text` | all | yes | read |
| `percentage_change` | all | yes | read |
| `percentage_of` | all | yes | read |
| `performance_suggestions` | standard+full | yes | read |
| `poll_command` | standard+full | yes | read |
| `predict_merge_conflicts` | standard+full | yes | read |
| `process_memory` | standard+full | yes | read |
| `project_index` | all | yes | read |
| `project_status` | all | yes | read |
| `properties_parse` | all | yes | read |
| `quality_gate_check` | standard+full | yes | read |
| `quality_gate_list` | standard+full | yes | read |
| `quality_gate_run` | standard+full | yes | read |
| `quality_history` | standard+full | yes | read |
| `query_call_graph` | standard+full | yes | read |
| `query_type_relations` | standard+full | yes | read |
| `quick_security_check` | standard+full | yes | read |
| `ratio_simplify` | all | yes | read |
| `read_csv` | all | yes | read |
| `read_file` | all | yes | read |
| `read_json` | all | yes | read |
| `read_lines` | all | yes | read |
| `read_many_files` | all | yes | read |
| `recent_activity` | all | yes | read |
| `recent_files` | all | yes | read |
| `recommend_version` | standard+full | yes | read |
| `refactor_preview` | standard+full | yes | read |
| `reflection_forget` | full | no | write |
| `reflection_list` | standard+full | yes | read |
| `rename_file` | standard+full | no | write |
| `rename_symbol` | full | no | write |
| `replace_text` | all | yes | read |
| `repo_map` | standard+full | yes | read |
| `reverse_text` | all | yes | read |
| `review_checklist` | standard+full | yes | read |
| `review_code` | standard+full | yes | read |
| `review_loop` | standard+full | no | shell |
| `review_pr` | standard+full | yes | read |
| `round_number` | all | yes | read |
| `rtf_to_text` | all | yes | read |
| `run_command` | standard+full | no | shell |
| `run_script` | full | no | shell |
| `run_tests` | standard+full | no | shell |
| `scaffold_list` | standard+full | yes | read |
| `scaffold_project` | full | no | write |
| `scan_hardcoded_text` | standard+full | yes | read |
| `scan_licenses` | standard+full | yes | read |
| `scan_security` | standard+full | yes | read |
| `search_text` | all | yes | read |
| `semantic_index_stats` | standard+full | yes | read |
| `semantic_search` | standard+full | yes | read |
| `sequence_generate` | all | yes | read |
| `session_analytics` | standard+full | yes | read |
| `session_title_suggest` | standard+full | yes | read |
| `shortest_line` | all | yes | read |
| `sibling_files` | all | yes | read |
| `skill_list` | standard+full | yes | read |
| `skill_show` | standard+full | yes | read |
| `sort_lines` | all | yes | read |
| `spawn_subagent` | standard+full | no | read |
| `split_text` | all | yes | read |
| `strip_empty_lines` | all | yes | read |
| `structure_audit` | standard+full | yes | read |
| `suggest_improvements` | standard+full | yes | read |
| `suggest_quick_wins` | standard+full | yes | read |
| `suggest_reviewers` | standard+full | yes | read |
| `take_lines` | all | yes | read |
| `test_fix` | standard+full | yes | read |
| `test_generate` | full | no | write |
| `text_case` | all | yes | read |
| `text_compare` | all | yes | read |
| `text_contains` | all | yes | read |
| `text_ends_with` | all | yes | read |
| `text_equals` | all | yes | read |
| `text_frequency` | all | yes | read |
| `text_index_of` | all | yes | read |
| `text_is_empty` | all | yes | read |
| `text_length` | all | yes | read |
| `text_pad` | all | yes | read |
| `text_remove_prefix` | all | yes | read |
| `text_remove_suffix` | all | yes | read |
| `text_repeat` | all | yes | read |
| `text_repeat_lines` | all | yes | read |
| `text_slice` | all | yes | read |
| `text_slugify` | all | yes | read |
| `text_starts_with` | all | yes | read |
| `text_surround` | all | yes | read |
| `text_truncate` | all | yes | read |
| `text_unwrap` | all | yes | read |
| `text_wrap` | all | yes | read |
| `todo_report` | standard+full | yes | read |
| `toml_parse` | all | yes | read |
| `trim_text` | all | yes | read |
| `ts_exact_references` | all | yes | read |
| `ts_goto_definition` | all | yes | read |
| `ts_hover` | all | yes | read |
| `ts_migration_status` | standard+full | yes | read |
| `typecheck` | standard+full | no | shell |
| `url_decode` | all | yes | read |
| `url_encode` | all | yes | read |
| `uuid_generate` | all | yes | read |
| `version_bump` | standard+full | yes | read |
| `web_search` | all | no | network |
| `which_command` | all | yes | read |
| `word_count` | all | yes | read |
| `workflow_analyze_impact` | standard+full | yes | read |
| `workflow_create` | standard+full | yes | read |
| `workflow_execute` | full | no | write |
| `workflow_list` | standard+full | yes | read |
| `workflow_list_templates` | standard+full | yes | read |
| `workflow_performance_report` | standard+full | yes | read |
| `workflow_resume` | full | no | write |
| `workspace_affected` | standard+full | yes | read |
| `workspace_deps_check` | standard+full | yes | read |
| `workspace_filter` | standard+full | yes | read |
| `workspace_graph` | standard+full | yes | read |
| `workspace_list` | standard+full | yes | read |
| `workspace_run` | full | no | write |
| `workspace_run_diff` | standard+full | yes | read |
| `workspace_run_history` | standard+full | yes | read |
| `write_csv` | standard+full | no | write |
| `write_file` | standard+full | no | write |
| `write_json` | standard+full | no | write |
| `xml_query` | all | yes | read |
| `xml_summary` | all | yes | read |
| `xml_to_text` | all | yes | read |
| `yaml_keys` | all | yes | read |
| `yaml_parse` | all | yes | read |
| `yaml_query` | all | yes | read |
| `yaml_stringify` | standard+full | yes | read |
| `zip_summary` | all | yes | read |

## 8. Reproducing this page

```bash
npm --prefix cli run build
node -e "const {createDefaultToolRegistry}=require('./cli/dist/src/tools/index.js');const s=require('./cli/dist/src/tools/scope.js');const r=createDefaultToolRegistry();const c=new Set(s.selectScopedTools(r,'compact').map(t=>t.name));const st=new Set(s.selectScopedTools(r,'standard').map(t=>t.name));const rows=r.list().map(t=>[t.name,t.risk,s.isReadOnlyTool(t),c.has(t.name),st.has(t.name)]);console.table(rows.map(([n,r,ro,cc,ss])=>({tool:n,risk:r,readOnly:ro,compact:cc,standard:ss,full:true})));console.log(rows.length)"
```

If the numbers in §2 disagree with that output, this page is stale.
