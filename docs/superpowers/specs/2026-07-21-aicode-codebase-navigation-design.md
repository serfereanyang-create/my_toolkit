# aicode CLI P3 Codebase Navigation Design

**Date:** 2026-07-21  
**Status:** Approved for implementation

## Goal

Add heuristic TS/JS symbol indexing with durable cache so agents can locate definitions and approximate references quickly without LSP.

## Scope

- Heuristic extract for TS/JS
- Cache `.aicode/nav/index.json` with mtime incremental updates
- Tools: `find_symbol`, `find_references`, enhanced project map via `project_index` or `project_map`
- Strategy/commandExtract prefer symbol tools for locate/edit intents

## Non-goals

- Full TypeScript language service
- Perfect semantic references
- Multi-language deep parsers in v1

## Acceptance

- Find definition of known functions by name
- Incremental cache avoids full rescan when unchanged
- Ignored dirs excluded
- Existing suites remain green
