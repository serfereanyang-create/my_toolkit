# MCP Client Design (stdio MVP)

Date: 2026-07-22  
Status: Approved for implementation (continues reserved “MCP” backlog under aicode safety defaults)

## Goal

Let aicode load external tools from local MCP servers declared in the workspace, register them into the existing tool registry, and execute them under the same approval/hook policy as built-in tools.

## Non-goals (this slice)

- HTTP/SSE/WebSocket remote MCP transports
- MCP resources / prompts / sampling / roots beyond optional ignore
- Auto-installing MCP servers or fetching packages
- OS sandboxing of MCP child processes
- Dynamic tool list refresh mid-turn (reload is explicit)

## Approach

**Recommended: stdio JSON-RPC client + bridge into `ToolRegistry`.**

| Approach | Pros | Cons |
| --- | --- | --- |
| A. Minimal stdio client (chosen) | No new deps; matches plugins pattern; testable with fake server | Manual protocol subset |
| B. Vendor full MCP SDK | Spec complete | Dependency weight, version churn for MVP |
| C. Plugin-only shell wrappers | Already exists | Not real MCP; no schema tools |

## Config

Path: `.aicode/mcp.json` (workspace-relative)

```json
{
  "servers": {
    "demo": {
      "command": "node",
      "args": ["scripts/mcp-echo-server.js"],
      "env": { "FOO": "bar" },
      "cwd": ".",
      "enabled": true
    }
  }
}
```

Rules:

- Missing file → no MCP servers (not an error)
- Invalid JSON / schema → hard error at load (same as plugins)
- Server names: `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`
- Only `command` + optional `args` / `env` / `cwd` / `enabled`
- `enabled: false` skips spawn
- `cwd` defaults to workspace root; must stay inside workspace
- Env is merged over process.env; `AICODE_*` / API key vars are not auto-injected beyond process.env

## Protocol subset

Transport: stdio with **Content-Length** framing (LSP-style).

Client lifecycle per server:

1. Spawn child (`stdio: pipe`, `windowsHide: true`)
2. `initialize` request (protocolVersion `2024-11-05`, clientInfo `aicode`)
3. `notifications/initialized`
4. `tools/list` (optional cursor paging until exhausted)
5. On tool call: `tools/call` with `name` + `arguments`
6. On shutdown: send `close` if supported, then kill process; always dispose stdio

Timeouts:

- Initialize: 15s
- tools/list: 15s
- tools/call: 60s default, clamp 1–120s

Failures:

- One server failing to start/init **does not** abort the CLI; surface in `/mcp` and doctor as fail detail; other servers still load
- Unknown/malformed server messages are ignored or mark connection unhealthy without crashing the agent loop

## Tool bridge

Registered name: `mcp_<server>_<tool>` after sanitizing tool name to `[a-zA-Z0-9_]+` (other chars → `_`).

- Description: `[mcp:<server>] <description>`
- inputHint: JSON schema summary or `'{...}'` from inputSchema
- Risk:
  - `annotations.readOnlyHint === true` → `read`
  - else `annotations.destructiveHint === true` → `write`
  - else → `shell` (conservative; needs approval in `ask` mode)
- validate: accept object input; pass through as `arguments`
- execute: `tools/call`; map text content blocks to `output`; `isError` → `ok: false`
- Still goes through registry approval + hooks

Name collisions with built-in tools: skip MCP tool and record warning.

## UX

- Startup: connect enabled servers before REPL/prompt (after plugins)
- `/mcp` → list servers (status, tool count, last error)
- `/mcp reload` → reconnect all
- `/tools` already lists bridged tools
- Doctor: check config parse + report connected count / errors
- Env: `AICODE_MCP=0` disables all MCP loading

## Safety alignment

- No network transport in this slice
- No auto-push / no remote secrets from MCP config
- MCP tools default to non-read risk so `ask` mode prompts
- Child cwd confined to workspace
- Do not log full tool arguments if they look secret-shaped (reuse existing redaction patterns where applicable)

## Testing

- Framing encode/decode unit tests
- Config normalize / reject invalid
- Fake stdio server process (node script fixture) for initialize + list + call
- Bridge name/risk mapping
- Registry execute with approval deny
- Disabled via `AICODE_MCP=0`

## Acceptance

- typecheck + full test suite green
- audit includes MCP files/needles
- capability matrix: MCP → Implemented MVP (stdio)
- mock smoke still works with no mcp.json
