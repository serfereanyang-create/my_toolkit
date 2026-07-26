# aicode CLI Native Tool Calling Design

**Date:** 2026-07-21  
**Status:** Approved for implementation

## Goal

Use native provider tool APIs for OpenAI-compatible and Anthropic providers, with text JSON tool-call parsing as fallback.

## Approach

1. Map `ProviderToolSpec` → provider-native tool schemas.
2. OpenAI: send `tools` + parse `message.tool_calls`.
3. Anthropic: send `tools` + parse `tool_use` content blocks.
4. If native tools absent, fall back to existing `parseToolActions(content)`.
5. Keep mock provider and text protocol for offline tests.

## Non-goals

- Full streaming UI in this change
- Perfect JSON Schema from freeform inputHint
- Multi-tool parallel execution policy changes
