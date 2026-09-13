# ZCode-lite

A Windows-first, dependency-light Node.js + TypeScript agent CLI. It supports an interactive REPL and one-shot prompts, OpenAI-compatible vendors, Anthropic, a deterministic offline mock provider, tool loops, approvals, and a workspace sandbox.

## Build and run

```powershell
cd C:\Users\34516\ZCodeProject\zcode-lite
npm install
npm run build
node dist/src/index.js --provider mock --approval auto --prompt "list files"
```

The package bin is `zcode-lite` after installation/linking.

## Options

```text
-p, --prompt <text>       Run one prompt and exit
--provider <name>         mock, openai, grok, glm, kimi, deepseek, anthropic
--model <id>              Override provider model
--base-url <url>          Override API base URL
--api-key <key>           Override API key (never displayed)
--approval <ask|auto|deny>
--workspace <path>        File-tool workspace root (defaults to cwd)
--max-steps <n>           1-100, default 24
--json                    Machine-readable one-shot result
```

## Configuration

Configuration is merged in this order: flags, `ZCL_*` environment variables, `.zcode-lite/config.json` in the current directory, then defaults. Vendor credentials can also come from `OPENAI_API_KEY`, `GROK_API_KEY`/`XAI_API_KEY`, `ZHIPU_API_KEY`/`GLM_API_KEY`, `MOONSHOT_API_KEY`/`KIMI_API_KEY`, `DEEPSEEK_API_KEY`, or `ANTHROPIC_API_KEY`.

Example `.zcode-lite/config.json`:

```json
{
  "provider": "deepseek",
  "approval": "ask",
  "workspaceRoot": "C:/work/project",
  "networkAllowlist": ["api.example.com"],
  "providers": { "deepseek": { "model": "deepseek-chat" } }
}
```

API keys are used only in HTTP request headers and are never included in CLI output.

## Tools and safety

- `list_files`, `read_file`, `search_files`: read-only, sandboxed to the workspace.
- `write_file`: creates parent directories and requires approval in `ask` mode.
- `run_shell`: runs PowerShell with `-NoProfile` on Windows; requires approval in `ask` mode.
- `http_request`: requires approval in `ask` mode and only permits exact hosts listed in `networkAllowlist`.

`deny` blocks write, shell, and network calls; `auto` allows them. In a REPL, `ask` prompts per action and supports session-wide approval. One-shot `ask` has no interactive confirmation and therefore blocks risky calls.
