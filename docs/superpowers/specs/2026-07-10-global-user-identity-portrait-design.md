# Global User Identity Portrait Design

**Date:** 2026-07-10
**Status:** Approved design
**Plugin:** `profile-memory`

## Problem

The current plugin persists individual memories and can inject selected summaries at SessionStart, but it does not provide the experience the user requires: every ZCode session should begin with a useful, evolving understanding of the user's basic identity.

The target is not keyword recall. The target is a global portrait that accumulates evidence across sessions and projects, consolidates stable identity signals, and naturally influences responses and decisions without being recited to the user.

## Goals

1. Give every new or resumed ZCode session the same compact global user portrait.
2. Capture identity evidence from every user prompt without relying on model tool-call compliance.
3. Automatically promote repeated or explicit stable signals into the portrait.
4. Preserve evidence, confidence, conflicts, and update history for every portrait statement.
5. Let the user review, correct, deactivate, forget, and export all portrait data.
6. Use the portrait naturally in normal responses instead of mechanically listing stored keywords.
7. Keep the first implementation local and deterministic, with a replaceable semantic-consolidation interface for a future model-backed phase.

## Non-Goals

1. The first version will not reliably infer deep personality from implicit behavior.
2. It will not call an external language model for portrait consolidation.
3. It will not store passwords, API keys, private keys, session tokens, authentication cookies, or other credentials.
4. It will not make portrait capture failure block the user's normal ZCode turn.
5. It will not inject raw evidence transcripts into every session.

## User Decisions

- Update mode: automatic accumulation with reversible conclusions.
- Allowed portrait domains: identity facts, work preferences, long-term interests and goals, and personal-life context.
- Sensitive portrait domains: allowed for automatic consolidation, with explicit `sensitive` marking and review controls.
- Credential rule: credentials remain permanently excluded because they are secrets, not identity.
- Semantic strategy: deterministic local rules in phase one; model-backed consolidation remains an extension point.
- Scope: the base portrait is global across sessions, projects, workspaces, and tasks.

## Architecture

```text
UserPromptSubmit hook
  -> receive every prompt before the model call
  -> redact or reject credentials
  -> extract explicit identity evidence locally
  -> append evidence to the global ledger
  -> consolidate affected portrait dimensions
  -> return relevant portrait context for the current turn

SessionStart hook: startup | resume
  -> read global portrait
  -> select high-confidence active statements
  -> render compact identity context
  -> inject before the first model call

MCP tools and slash commands
  -> inspect portrait and evidence
  -> explain why a conclusion exists
  -> correct, deactivate, forget, or export data
```

Hooks provide deterministic lifecycle execution. MCP remains the user-facing management interface. Neither automatic capture nor SessionStart injection depends on the main model choosing to call a tool.

## Storage Model

The global plugin data directory remains the source of truth:

```text
${ZCODE_PLUGIN_DATA}/
  portrait-store.json
  portrait-store.lock
```

Phase one uses a versioned JSON store and an exclusive lock around read-modify-write operations. The storage API owns locking and atomic replacement so UserPromptSubmit hooks and MCP calls cannot silently overwrite each other.

```json
{
  "version": 2,
  "evidence": [],
  "portrait": {
    "identity": [],
    "preferences": [],
    "workingStyle": [],
    "interestsGoals": [],
    "lifeContext": []
  },
  "pendingConsolidation": [],
  "metadata": {
    "updatedAt": "2026-07-10T00:00:00.000Z"
  }
}
```

Existing version-one memories are migrated into evidence plus portrait statements. Migration is idempotent and keeps the old file as a backup until the new store is written successfully.

## Evidence

An evidence record captures a bounded summary of an identity signal rather than a complete prompt transcript:

```json
{
  "id": "ev_...",
  "sessionId": "sess_...",
  "turnId": "turn_...",
  "dimension": "workingStyle",
  "signalType": "explicit_preference",
  "statement": "用户重视功能是否真正形成闭环。",
  "keywords": ["闭环验证", "真实效果"],
  "weight": 0.9,
  "sensitive": false,
  "sourceExcerpt": "...bounded excerpt...",
  "createdAt": "..."
}
```

Evidence is deduplicated by session, turn, normalized statement, and signal type. Source excerpts have a strict length cap. Credential-like material is redacted before any excerpt is stored.

## Portrait Statements

Each portrait conclusion is traceable and reversible:

```json
{
  "id": "portrait_...",
  "dimension": "workingStyle",
  "statement": "用户重视功能是否真正形成闭环，不接受表面完成。",
  "keywords": ["闭环验证", "真实效果", "工程质量"],
  "confidence": 0.93,
  "evidenceCount": 4,
  "supportingEvidenceIds": ["ev_..."],
  "conflictingEvidenceIds": [],
  "sensitive": false,
  "status": "active",
  "firstSeenAt": "...",
  "lastSeenAt": "...",
  "updatedAt": "..."
}
```

Statuses are `active`, `superseded`, `disputed`, and `forgotten`. Forgotten statements are removed from injection and their evidence is deleted unless the user explicitly chooses a tombstone for synchronization purposes.

## Local Extraction Rules

Phase one recognizes explicit language patterns in Chinese and English:

- Identity: `我是`, `我从事`, `我的职业`, `我使用`, `I am`, `I work as`, `I use`.
- Preferences: `我喜欢`, `我不喜欢`, `我偏好`, `我希望`, `不要`, `I prefer`, `I like`, `I dislike`.
- Goals: `我的目标`, `长期想`, `我计划`, `my goal`, `I plan to`.
- Corrections: `这不对`, `不是这样`, `改成`, `forget that`, `that's wrong`.
- Repeated interests: normalized domain keywords recurring across distinct sessions or turns.
- Explicit feedback: direct acceptance or rejection of an implementation or interaction pattern.

Rules produce evidence, not arbitrary personality claims. Explicit self-statements receive high weight. Repeated independent evidence raises confidence. One-off implicit behavior remains evidence-only or is ignored.

## Consolidation Rules

1. An explicit identity or preference statement may become active immediately at high confidence.
2. Inferred interests require evidence across at least two distinct turns; stronger traits require at least three independent evidence records.
3. Exact and semantic-normalized duplicates merge into one portrait statement.
4. Supporting evidence raises confidence with a capped function; evidence count remains visible.
5. Contradictory evidence changes the statement to `disputed` or supersedes it when the user explicitly corrects the record.
6. Explicit correction wins over older inferred evidence.
7. Time reduces ranking priority but does not delete identity facts automatically.
8. Sensitive statements use the same evidence rules but are marked `sensitive` and excluded from broad injection unless relevant or explicitly designated as core identity.
9. Credential patterns are rejected before evidence creation, regardless of user-selected sensitive-data policy.

## Session Context

The SessionStart matcher must use sources actually dispatched by the installed ZCode runtime:

```text
startup|resume
```

The renderer produces a bounded portrait:

```text
<global-user-portrait>
This is an evolving user portrait based on explicit statements and repeated evidence.
Use it naturally when choosing explanations, workflows, and defaults. Do not recite it
unless asked. Treat uncertain conclusions as preferences, not immutable facts.

Identity and background:
- ...

Working style:
- ...

Long-term interests and goals:
- ...
</global-user-portrait>
```

Selection priority is:

1. active global identity facts;
2. explicit user preferences;
3. high-confidence working style;
4. long-term goals and recurring interests;
5. relevant life context.

The renderer enforces item and character budgets. Raw evidence, ids, confidence numbers, and sensitive details are not included unless needed for the active task.

## Per-Turn Context

UserPromptSubmit can return additional context after updating evidence. It selects portrait statements relevant to the current prompt, so an established technical preference can influence a task even when it was omitted from the compact SessionStart portrait.

Capture and retrieval are independent: failure to write evidence returns no context error to the user and does not block the turn. Diagnostics go to a plugin-local log with no raw credentials.

## User Controls

Existing commands are extended:

- `/memory portrait`: show the current global portrait by dimension.
- `/memory evidence <portrait-id>`: explain supporting and conflicting evidence.
- `/memory review`: show low-confidence, disputed, sensitive, and recently changed statements.
- `/remember <text>`: add explicit high-confidence evidence and consolidate immediately.
- `/forget <id|query>`: preview and then remove statements and associated evidence.
- `/memory correct <id> <replacement>`: supersede a statement using explicit evidence.
- `/memory export`: export the portrait and evidence ledger.

MCP receives corresponding portrait, evidence, correction, and consolidation tools while retaining compatibility with existing memory CRUD tools.

## Sensitive Information

The user permits automatic portrait consolidation for health, financial, location, political, religious, and personal-life information. These statements must still be marked `sensitive`, surfaced in `/memory review`, and removable as a group.

The following are permanently excluded:

- passwords and passphrases;
- API keys and access tokens;
- private keys and seed phrases;
- authentication cookies and session credentials;
- complete payment-card or government-identifier values.

## Failure Handling

- Hook errors and timeouts never block normal conversation.
- Corrupt stores are moved to a timestamped recovery file before creating an empty store; no corrupt file is silently overwritten.
- Lock acquisition uses a bounded timeout. Failure skips the capture and writes a diagnostic.
- Unknown store versions fail closed for writes but remain exportable.
- Migration is atomic and idempotent.
- Portrait rendering tolerates missing optional fields.

## Testing Strategy

### Unit tests

- Chinese and English extraction patterns.
- Credential redaction and rejection.
- Sensitive classification.
- Evidence deduplication.
- Confidence accumulation.
- conflict, correction, supersession, and forgetting.
- version-one migration.
- bounded portrait rendering.

### Hook tests

- UserPromptSubmit reads stdin payload, writes evidence, and emits valid `additionalContext`.
- SessionStart injects on both `startup` and `resume`.
- hook failures exit successfully without blocking a turn.
- real `ZCODE_PLUGIN_DATA` and `CLAUDE_PLUGIN_DATA` fallback paths work.

### Concurrency tests

- simultaneous MCP and hook writes preserve both updates.
- stale locks expire safely.
- atomic writes never expose partial JSON.

### Integration tests

1. Install the plugin through ZCode's app-server protocol.
2. Submit explicit identity and preference prompts in separate sessions.
3. Confirm evidence and confidence accumulation in the global store.
4. Start a new session in another project.
5. Confirm the same compact portrait is injected.
6. Give a decision task and verify the assistant follows the portrait preference without reciting it.
7. Correct a portrait statement, start another session, and verify the corrected behavior.

## Acceptance Criteria

1. Every `startup` and `resume` session receives a valid global portrait when active statements exist.
2. The portrait is shared across project directories.
3. Explicit identity statements become available to later sessions without `/remember`.
4. Repeated signals increase evidence count and confidence without producing duplicates.
5. Conflicts and explicit corrections are visible and deterministic.
6. The assistant naturally applies portrait preferences in a new task and does not volunteer a keyword list.
7. The user can inspect, correct, forget, and export every conclusion and its evidence.
8. Credentials never appear in evidence, portrait statements, injected context, or logs.
9. Capture and storage failures do not block ZCode conversation.
10. Existing MCP memory operations and saved version-one data remain compatible after migration.

## Future Extension

A `PortraitConsolidator` interface separates evidence ingestion from semantic consolidation. Phase one implements `RuleBasedPortraitConsolidator`. A future `ModelPortraitConsolidator` can batch pending evidence through an independently configured model without changing hooks, storage, commands, or portrait rendering.
