# aicode CLI Provider Streaming Design

**Date:** 2026-07-21  
**Status:** Approved for implementation

## Goal

Stream assistant text deltas from OpenAI-compatible and Anthropic providers to the terminal for lower perceived latency, while still returning a complete `ProviderResponse` with tools.

## Approach

1. Optional `onTextDelta` on `ProviderRequest`.
2. OpenAI: `stream: true` SSE; accumulate `delta.content` and `delta.tool_calls`.
3. Anthropic: `stream: true` SSE; handle `content_block_delta` text and `tool_use` input_json deltas.
4. Terminal UI: stream-friendly assistant delta methods.
5. JSON mode emits `assistant_delta` events; quiet mode writes raw deltas.
6. Mock remains non-streaming.

## Non-goals

- Token-accurate usage accounting
- Partial tool execution mid-stream
- Cancelling mid-stream via Ctrl+C policy rewrite
