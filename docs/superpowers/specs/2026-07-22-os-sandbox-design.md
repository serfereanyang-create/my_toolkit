# OS Sandbox Design (process MVP)

Date: 2026-07-22  
Status: Implementation

## Goal

Harden shell/plugin command execution so child processes are less able to inherit secrets, escape the workspace cwd, or outlive timeouts as orphan trees.

## Non-goals

- Full container / bubblewrap / Windows AppContainer isolation
- Network firewalling
- Syscall filtering
- Sandboxing MCP server processes in this slice (MCP already has workspace cwd; secret scrub can reuse the same env builder later)

## Approach

**Process sandbox layer** used by `run_command` and plugin tools:

1. Force `cwd` to workspace root
2. Build child env via `buildSandboxEnv` (strip known secret keys; keep PATH/HOME/SystemRoot essentials)
3. Spawn shell with `windowsHide`, bounded `maxBuffer`
4. On timeout, kill the whole process tree (Windows `taskkill /T`, POSIX process group)
5. Reject empty/null-byte commands and cap command length

Disable / relax:

- `AICODE_SANDBOX=0` → still enforce cwd + timeout kill, but do not scrub secrets (compat)
- Default: scrub on

## Honesty in matrix

Label as **Implemented MVP (process sandbox)** — not container isolation.

## Tests

- Env scrub removes API keys
- Command runs with cwd workspace
- Timeout kills hang command
- Shell tool still returns node --version under auto approval
