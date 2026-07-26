# aicode CLI Context Budget & Session Compaction Design

**Date:** 2026-07-21  
**Status:** Approved for implementation

## Goal

Prevent large-session context explosion by compacting the message window sent to providers, while keeping full session history on disk.

## Decisions

1. Compact only the outbound model window (not disk history).
2. Budget by approximate chars (default 80_000, env `AICODE_CONTEXT_BUDGET_CHARS`).
3. Truncate oversized tool/assistant payloads when packing.
4. Fold older messages into one deterministic summary message.
5. No tokenizer dependency in v1.

## Integration

`runAgentTurnCore` packs `runtime.session.messages` via `compactMessagesForModel` before each `provider.complete`.

## Acceptance

- Oversized histories still call provider with <= budget messages payload.
- Recent user/tool turns preserved preferentially.
- Disk session retains full tool outputs.
- Existing suites remain green.
