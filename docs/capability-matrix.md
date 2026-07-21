# aicode CLI Capability Matrix

This matrix tracks what the CLI can prove through implementation, tests, and audit checks.

| Area | Status | Evidence |
| --- | --- | --- |
| Command UX/help/version | Implemented | `--help`, `--version`, prompt mode, REPL, slash commands |
| Stdout/stderr/JSON | Implemented | Human output, `--json` JSONL events, stderr errors, `--no-color`, `--quiet` |
| Errors/exit codes/debug | Implemented | Nonzero prompt failures, `--debug`, concise default errors |
| Config/env/profile/auth | Implemented | `.aicode/config.json`, `--config`, `--profile`, env/flag precedence, redacted `/config` |
| Automation/CI | Implemented | `--prompt`, `--ci`, `--no-input`, stable JSON final event |
| Shell completion | Implemented | `completion bash|zsh|fish|powershell` |
| Doctor diagnostics | Implemented | `--doctor`, JSON doctor output |
| Safety approvals/path policy | Implemented MVP | approval modes, command allow/block lists, workspace path guard, checkpoint before writes |
| File tools | Implemented | list/read/write/search/patch/rename/docx |
| Shell execution | Implemented MVP | approved shell command execution with timeout and max buffer |
| Diff/patch/undo | Implemented MVP | diff preview for write approval, apply patch, checkpoints, `/undo` |
| Session resume/export | Implemented | session JSON store, `--resume`, `/sessions`, `/summary`, `/plan`, `/export` |
| Context budget / compaction | Implemented MVP | Outbound message packing with char budget (`AICODE_CONTEXT_BUDGET_CHARS`), tool output clipping, older-history summary; disk session keeps full history |
| Long-task planning / task board | Implemented MVP | Durable `.aicode/tasks` boards, `/plan` controls, confirm-then-auto-run, blocked resume |
| Task verify loop | Implemented MVP | After textual done, run package `typecheck`/`test`/`build` when present; one repair retry; fail blocks board |
| Project memory | Implemented MVP | Durable `.aicode/memory` entries, auto-record from tasks, `/memory` controls, task-prompt injection |
| Project understanding | Implemented MVP | `project_index`, instruction context from `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `README.md` |
| Codebase navigation | Implemented MVP | Heuristic TS/JS symbol index (`.aicode/nav`), `find_symbol` / `find_references`, strategy prefers symbols first |
| Natural-language command extraction | Implemented MVP | Shared extract/plan layer; high-confidence readonly tools execute directly; edit/shell remain strategy + model |
| Git workflow | Implemented MVP | Board branch on `/plan confirm` (`aicode/board-*`); confirmed board commit after completion; read-only git tools; hidden snapshots + `/rollback`; confirmed `/git publish` only; no auto-push |
| Git safety / rollback log | Implemented MVP | `.aicode/git-safety/audit.jsonl`, `refs/aicode/checkpoints/*`, dirty-tree protection, all-or-nothing conflict checks |
| Providers | Implemented MVP | mock, OpenAI-compatible, Anthropic adapters; native tools/tool_calls and tool_use with text JSON fallback |
| Tests/audit | Implemented | typecheck, node:test suite, structural audit above 100 checks |
| Plugins/hooks | Implemented MVP | `.aicode/plugins.json` command tools, approval policy, `beforeTool`, `afterTool`, `onError` hooks |
| MCP | Advanced / not complete | Plugin/hook groundwork exists; full MCP protocol is out of MVP scope |
| OS sandbox | Advanced / not complete | Policy gating exists; no container/OS-level sandbox is claimed |
| Native provider streaming/tool calls | Partial | Native tool calling implemented for OpenAI/Anthropic; streaming UI still future work |
| Signed distribution/update | Advanced / not complete | npm-style package metadata exists; signed release/update is future work |

## Final Verification Checklist

Run these from the repository root:

```bash
npm --prefix cli run typecheck
npm --prefix cli test
npm --prefix cli run audit:100
node cli/dist/src/index.js --version
node cli/dist/src/index.js --help
MSYS2_ARG_CONV_EXCL='*' node cli/dist/src/index.js --provider mock --approval auto --json --prompt "帮我看看项目索引"
node cli/dist/src/index.js --provider mock --workspace cli --doctor
node cli/dist/src/index.js completion bash
```
