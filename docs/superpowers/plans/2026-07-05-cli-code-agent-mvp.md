# CLI Code Agent MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable Claude-Code-like local CLI coding agent MVP with dual provider support, safe tools, sessions, smoke tests, and a 100-check audit.

**Architecture:** Create an isolated `cli/` TypeScript package inside the existing workspace. Keep the runtime modular: CLI parsing and REPL, terminal UI, provider adapters, agent loop, tool registry, safety policy, and session storage. The MVP uses Node 24/npm for immediate local execution while keeping provider/tool boundaries compatible with future Bun/OpenTUI evolution.

**Tech Stack:** TypeScript, Node.js built-in modules, npm scripts, Node test runner, fetch API, readline/promises, child_process.

---

## Files

- Create `cli/package.json`: package scripts and CLI metadata.
- Create `cli/tsconfig.json`: strict Node-flavored TypeScript config.
- Create `cli/src/index.ts`: CLI entrypoint.
- Create `cli/src/cli/args.ts`: argument parsing.
- Create `cli/src/cli/commands.ts`: slash-command handling.
- Create `cli/src/cli/repl.ts`: interactive and prompt mode orchestration.
- Create `cli/src/ui/terminal.ts`: line-based terminal rendering.
- Create `cli/src/agent/agent.ts`: agent turn loop.
- Create `cli/src/providers/types.ts`: shared provider and action types.
- Create `cli/src/providers/mock.ts`: deterministic provider for tests and demos.
- Create `cli/src/providers/openai.ts`: OpenAI-compatible adapter.
- Create `cli/src/providers/anthropic.ts`: Anthropic adapter.
- Create `cli/src/providers/index.ts`: provider factory.
- Create `cli/src/tools/types.ts`: tool interfaces.
- Create `cli/src/tools/registry.ts`: registry and execution wrapper.
- Create `cli/src/tools/files.ts`: file tools.
- Create `cli/src/tools/search.ts`: search tool.
- Create `cli/src/tools/shell.ts`: shell tool.
- Create `cli/src/tools/patch.ts`: patch tool.
- Create `cli/src/tools/index.ts`: default registry.
- Create `cli/src/session/store.ts`: session persistence.
- Create `cli/src/config/config.ts`: config loading and defaults.
- Create `cli/src/safety/policy.ts`: approval, command, and path policy.
- Create `cli/src/audit/checks.ts`: 100-check audit.
- Create `cli/tests/smoke.test.ts`: multi-tool smoke test.
- Create `cli/tests/audit.test.ts`: audit test wrapper.
- Create `cli/README.md`: usage and provider config.

## Task 1: Package and shared types

- [ ] Create `cli/package.json` with scripts: `build`, `typecheck`, `test`, `smoke`, `audit:100`, `dev`.
- [ ] Create `cli/tsconfig.json` with strict TypeScript, ES2022 target, NodeNext module resolution, `rootDir: src`, `outDir: dist`.
- [ ] Create shared provider, tool, config, and session types.
- [ ] Run `cd cli && npm install` to generate package lock and install local dev dependency `typescript` plus `@types/node`.
- [ ] Run `cd cli && npm run typecheck`; expected failures only if later files are not yet created.

## Task 2: Config, safety, and sessions

- [ ] Implement config loading from CLI args and environment: provider, model, base URL, approval mode, workspace, session dir.
- [ ] Implement path safety with workspace containment checks.
- [ ] Implement command policy with blocked destructive patterns and an allowed set for auto mode.
- [ ] Implement session creation, loading, append, list, and JSON persistence under `.aicode/sessions`.
- [ ] Add targeted Node tests through the smoke test file for path rejection and session persistence.

## Task 3: Tools

- [ ] Implement tool registry with risk levels, validator functions, and policy enforcement.
- [ ] Implement `project_status`, `list_files`, `read_file`, `write_file`, `search_text`, `run_command`, and `apply_patch`.
- [ ] Ensure all tools return structured text summaries and machine-readable data.
- [ ] Ensure write and shell tools are blocked by deny policy and constrained in auto mode.
- [ ] Add tests covering at least read, write, shell, search, patch, and path traversal rejection.

## Task 4: Providers

- [ ] Implement deterministic mock provider that emits a multi-tool action sequence for smoke prompts.
- [ ] Implement OpenAI-compatible adapter using `fetch` and normalized actions.
- [ ] Implement Anthropic adapter using `fetch` and normalized actions.
- [ ] Implement provider factory and clear missing-key errors.
- [ ] Add usage docs for `MOCK`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`.

## Task 5: Agent loop and CLI UI

- [ ] Implement agent loop: user message, provider action, tool execution, tool results, final answer, session persistence.
- [ ] Implement line-based terminal UI with banner, status, assistant output, and tool call logs.
- [ ] Implement interactive REPL and non-interactive `--prompt` mode.
- [ ] Implement slash commands: `/help`, `/status`, `/provider`, `/model`, `/tools`, `/sessions`, `/exit`.
- [ ] Ensure `node dist/index.js --provider mock --approval auto --prompt "..."` can finish without input.

## Task 6: Smoke and 100-check audit

- [ ] Implement `cli/tests/smoke.test.ts` to run the CLI in prompt mode with mock provider and auto approval.
- [ ] Assert at least three distinct tool calls occurred.
- [ ] Assert a file was written, read back, and recorded in the session.
- [ ] Assert an allowed shell command ran.
- [ ] Implement `cli/src/audit/checks.ts` with at least 100 concrete checks across layout, scripts, providers, tools, safety, sessions, CLI commands, and docs.
- [ ] Implement `cli/tests/audit.test.ts` to execute the audit and fail if any check fails.

## Task 7: Verification and repair loop

- [ ] Run `cd cli && npm run typecheck`.
- [ ] Run `cd cli && npm test`.
- [ ] Run `cd cli && npm run smoke`.
- [ ] Run `cd cli && npm run audit:100`.
- [ ] Fix every failure and rerun the relevant command until green.
- [ ] Perform completion audit mapping the user's requirements to evidence.

## Notes

- The current workspace is not a git repository, so commit steps are intentionally omitted.
- The user requested at least 100 self-reviews. This is implemented as `audit:100`, a repeatable automated audit with at least 100 explicit checks, not as meaningless manual churn.
- Do not modify the existing Vite app except root-level npm files if unavoidable. The CLI should be isolated under `cli/`.
