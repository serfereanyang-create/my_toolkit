# ZCode-lite source code

This directory contains TypeScript source for the lightweight agent CLI.

## File layout

- `agent/` — agent turn loop
- `cli/` — arg parsing + REPL
- `config/` — env / file config resolution
- `providers/` — multi-vendor adapters
- `safety/` — approval policy + path sandboxing
- `tools/` — tool registry + builtin tools (files, shell, http, powershell)
- `ui/` — terminal rendering

## Entry point

`src/index.ts` is the bin (`zcode-lite`)。它组装各模块，根据 `-p prompt` 决定是一次性任务还是交互式 REPL。
