# Global User Identity Portrait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `profile-memory` so every ZCode startup or resumed session automatically receives an evolving global user identity portrait built from deterministic evidence captured on every user prompt.

**Architecture:** Add a version-two global portrait store with locked atomic updates and version-one migration. A `UserPromptSubmit` hook captures and consolidates explicit identity signals; `SessionStart` renders the same global portrait for `startup|resume`. MCP tools and slash commands expose review, evidence, correction, forgetting, and export while retaining existing memory APIs.

**Tech Stack:** Node.js ESM, built-in `node:test`, ZCode hooks, stdio MCP JSON-RPC, versioned JSON storage.

---

## File Map

### Create

- `plugins/profile-memory/mcp/portrait-schema.mjs`: v2 constants, normalization, validation, and ids.
- `plugins/profile-memory/mcp/portrait-storage.mjs`: locking, atomic writes, recovery, and v1 migration.
- `plugins/profile-memory/mcp/evidence-extractor.mjs`: credential filtering, sensitive classification, and local signal rules.
- `plugins/profile-memory/mcp/portrait-consolidator.mjs`: deterministic deduplication, confidence, conflict, correction, and forgetting.
- `plugins/profile-memory/mcp/portrait-context.mjs`: bounded global and per-turn rendering.
- `plugins/profile-memory/hooks/user-prompt-submit`: stdin hook entry point.
- `plugins/profile-memory/mcp/user-prompt-cli.mjs`: testable prompt capture CLI.
- `plugins/profile-memory/tests/portrait-storage.test.mjs`
- `plugins/profile-memory/tests/evidence-extractor.test.mjs`
- `plugins/profile-memory/tests/portrait-consolidator.test.mjs`
- `plugins/profile-memory/tests/portrait-context.test.mjs`
- `plugins/profile-memory/tests/hooks.test.mjs`
- `plugins/profile-memory/tests/portrait-tools.test.mjs`

### Modify

- `plugins/profile-memory/mcp/storage.mjs`: delegate compatibility reads/writes to v2 storage.
- `plugins/profile-memory/mcp/memory-tools.mjs`: retain old tools and add portrait management.
- `plugins/profile-memory/mcp/server.mjs`: publish new MCP schemas.
- `plugins/profile-memory/mcp/context.mjs`: render v2 portrait with v1 fallback.
- `plugins/profile-memory/mcp/context-cli.mjs`: use v2 global renderer.
- `plugins/profile-memory/hooks/hooks.json`: register UserPromptSubmit and use `startup|resume`.
- `plugins/profile-memory/hooks/session-start`: preserve non-blocking behavior.
- `plugins/profile-memory/commands/memory.md`
- `plugins/profile-memory/commands/remember.md`
- `plugins/profile-memory/commands/forget.md`
- `plugins/profile-memory/skills/profile-memory/SKILL.md`
- `plugins/profile-memory/.zcode-plugin/plugin.json`: version `0.2.0` and portrait options.
- `plugins/profile-memory/package.json`: version `0.2.0`.
- `plugins/marketplace.json`: version `0.2.0`.
- `plugins/profile-memory/scripts/check-package.mjs`
- `plugins/profile-memory/scripts/seed-profile.mjs`
- `plugins/profile-memory/README.md`
- `plugins/profile-memory/CHANGELOG.md`
- `plugins/profile-memory/docs/INSTALL.md`

## Task 1: Version-Two Portrait Schema and Migration

**Files:**
- Create: `mcp/portrait-schema.mjs`
- Create: `mcp/portrait-storage.mjs`
- Create: `tests/portrait-storage.test.mjs`
- Modify: `mcp/storage.mjs`

- [ ] **Step 1: Write failing schema and migration tests**

Cover:

```js
const empty = createEmptyPortraitStore();
assert.equal(empty.version, 2);
assert.deepEqual(Object.keys(empty.portrait), [
  "identity", "preferences", "workingStyle", "interestsGoals", "lifeContext"
]);

const migrated = migrateV1Store({ version: 1, memories: [legacyMemory] });
assert.equal(migrated.evidence.length, 1);
assert.equal(allPortraitStatements(migrated).length, 1);
assert.equal(migrated.portrait.interestsGoals[0].status, "active");
```

Also test corrupt JSON recovery, unknown-version write rejection, and idempotent migration.

- [ ] **Step 2: Run the focused test**

```bash
node --test plugins/profile-memory/tests/portrait-storage.test.mjs
```

Expected: FAIL because portrait modules do not exist.

- [ ] **Step 3: Implement schema primitives**

Define dimensions `identity`, `preferences`, `workingStyle`, `interestsGoals`, `lifeContext`; statuses `active`, `superseded`, `disputed`, `forgotten`; `createEmptyPortraitStore`, `normalizeEvidence`, `normalizePortraitStatement`, `allPortraitStatements`, and stable random ids.

- [ ] **Step 4: Implement locked storage**

Expose:

```js
loadPortraitStore(dataDir)
updatePortraitStore(dataDir, updater, options)
savePortraitStore(dataDir, store)
migrateV1Store(v1Store)
```

Use `portrait-store.lock` with exclusive file creation, bounded retry, stale-lock removal after 30 seconds, temporary-file rename, and a timestamped recovery copy for corrupt JSON. If `portrait-store.json` is absent and `profile-memory.json` exists, migrate it and preserve `profile-memory.v1.backup.json`.

- [ ] **Step 5: Keep compatibility storage working**

Make existing `loadStore` expose active portrait statements as legacy memories and make `saveStore` use the v2 update path where practical. Existing tests must continue to pass.

- [ ] **Step 6: Run storage and legacy tests**

```bash
node --test plugins/profile-memory/tests/portrait-storage.test.mjs plugins/profile-memory/tests/storage.test.mjs plugins/profile-memory/tests/memory-tools.test.mjs
```

Expected: PASS.

## Task 2: Evidence Extraction and Secret Exclusion

**Files:**
- Create: `mcp/evidence-extractor.mjs`
- Create: `tests/evidence-extractor.test.mjs`

- [ ] **Step 1: Write failing extraction tests**

Test Chinese and English identity, preference, goal, life-context, correction, and repeated-interest inputs. Assert explicit examples:

```js
extractEvidence("我是软件开发者，我偏好先验证真实效果。", meta)
// identity + preferences evidence

extractEvidence("My goal is to build a cross-session memory plugin.", meta)
// interestsGoals evidence
```

Test that API keys, bearer tokens, private keys, passwords, seed phrases, complete payment cards, and government identifiers never appear in statements, excerpts, or keywords.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
node --test plugins/profile-memory/tests/evidence-extractor.test.mjs
```

- [ ] **Step 3: Implement credential redaction**

Expose `redactCredentials(text)` returning redacted text and matched categories. Reject evidence whose meaningful content is only a credential.

- [ ] **Step 4: Implement deterministic rules**

Expose:

```js
extractEvidence(prompt, { sessionId, turnId, createdAt })
classifySensitive(statement)
normalizeIdentityStatement(statement)
```

Cap excerpts at 240 characters. Mark health, finance, exact location, political, religious, and personal relationship signals as sensitive. Generate evidence only from explicit rules or stable domain terms.

- [ ] **Step 5: Run focused tests**

Expected: PASS.

## Task 3: Rule-Based Portrait Consolidation

**Files:**
- Create: `mcp/portrait-consolidator.mjs`
- Create: `tests/portrait-consolidator.test.mjs`

- [ ] **Step 1: Write failing consolidation tests**

Cover exact deduplication, turn-level deduplication, explicit immediate promotion, two-turn interest promotion, three-evidence working-style promotion, confidence accumulation, conflict marking, explicit correction, supersession, and deletion of evidence on forget.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
node --test plugins/profile-memory/tests/portrait-consolidator.test.mjs
```

- [ ] **Step 3: Implement `RuleBasedPortraitConsolidator`**

Expose:

```js
ingestEvidence(store, evidenceRecords)
correctPortraitStatement(store, id, replacement, metadata)
forgetPortraitStatements(store, ids)
reviewPortrait(store, filters)
```

Use confidence formula capped at `0.99`; explicit self-statements begin at at least `0.85`; repeated inferred signals promote only at their required thresholds. Explicit corrections supersede old statements.

- [ ] **Step 4: Run consolidation tests**

Expected: PASS.

## Task 4: Global and Turn-Relevant Portrait Rendering

**Files:**
- Create: `mcp/portrait-context.mjs`
- Create: `tests/portrait-context.test.mjs`
- Modify: `mcp/context.mjs`
- Modify: `mcp/context-cli.mjs`

- [ ] **Step 1: Write failing context tests**

Verify global rendering contains the natural-use instruction, dimensions, and active high-confidence statements; excludes forgotten/disputed/low-confidence statements and sensitive details by default; respects item and character budgets; and selects relevant statements for a prompt.

- [ ] **Step 2: Implement global renderer**

Expose:

```js
renderGlobalPortrait(store, options)
renderRelevantPortrait(store, prompt, options)
selectGlobalPortraitStatements(store, options)
```

Default maximum: 12 statements and 3,500 characters. Include sensitive statements only when designated core identity or relevant to the current prompt.

- [ ] **Step 3: Update compatibility context**

Make `loadProfileContext` load v2 portrait and render `<global-user-portrait>`. Keep v1 migration automatic.

- [ ] **Step 4: Run context tests**

Expected: PASS.

## Task 5: Deterministic UserPromptSubmit and SessionStart Hooks

**Files:**
- Create: `mcp/user-prompt-cli.mjs`
- Create: `hooks/user-prompt-submit`
- Create: `tests/hooks.test.mjs`
- Modify: `hooks/hooks.json`
- Modify: `hooks/session-start`

- [ ] **Step 1: Write hook process tests**

Spawn the hook scripts with temporary plugin data and JSON stdin. Assert:

- UserPromptSubmit writes evidence and returns valid `additionalContext`.
- duplicate invocation for the same session/turn does not duplicate evidence.
- SessionStart emits the global portrait for `startup` and `resume`.
- missing/corrupt/unwritable data does not return a blocking decision.
- `ZCODE_PLUGIN_DATA` and `CLAUDE_PLUGIN_DATA` fallbacks work.

- [ ] **Step 2: Implement user-prompt CLI**

Read one JSON object from stdin, validate `prompt`, `sessionId`, and `turnId`, call extractor plus locked consolidator update, render turn-relevant portrait, and print only valid hook JSON. On failure, append a redacted diagnostic and exit `0` without output.

- [ ] **Step 3: Implement hook wrapper**

`hooks/user-prompt-submit` resolves the data directory and runs the CLI. Extend `hooks/hooks.json`:

```json
"SessionStart": [{ "matcher": "startup|resume", ... }],
"UserPromptSubmit": [{ "matcher": ".*", ... }]
```

Do not declare the same conventional hook file twice in the manifest; remove the explicit manifest `hooks` path if ZCode auto-discovers `hooks/hooks.json`, eliminating the duplicate warning while preserving discovery.

- [ ] **Step 4: Run hook tests**

Expected: PASS.

## Task 6: Portrait MCP Tools and Commands

**Files:**
- Create: `tests/portrait-tools.test.mjs`
- Modify: `mcp/memory-tools.mjs`
- Modify: `mcp/server.mjs`
- Modify: `commands/memory.md`
- Modify: `commands/remember.md`
- Modify: `commands/forget.md`
- Modify: `skills/profile-memory/SKILL.md`

- [ ] **Step 1: Write failing tool tests**

Cover:

```text
profile_memory_get_portrait
profile_memory_get_evidence
profile_memory_review_portrait
profile_memory_correct_portrait
profile_memory_forget_portrait
profile_memory_ingest_explicit
```

Verify old seven tools still exist and operate through v2 compatibility.

- [ ] **Step 2: Implement portrait business functions**

Every mutating function uses locked `updatePortraitStore`. Forget defaults to dry-run. Correct creates explicit evidence, supersedes the old statement, and returns both records.

- [ ] **Step 3: Register MCP schemas**

Add six tools to `tools/list` and `tools/call`; keep the previous tool names unchanged.

- [ ] **Step 4: Update commands and skill**

Document `/memory portrait`, `/memory evidence`, `/memory review`, `/memory correct`, automatic prompt capture, global scope, natural use, sensitive review, credential exclusion, and correction/forget workflows.

- [ ] **Step 5: Run tool and server tests**

Expected: PASS with 13 MCP tools.

## Task 7: Versioning, Seed Migration, Package Checks, and Documentation

**Files:**
- Modify: `.zcode-plugin/plugin.json`
- Modify: `package.json`
- Modify: `../marketplace.json`
- Modify: `scripts/check-package.mjs`
- Modify: `scripts/seed-profile.mjs`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/INSTALL.md`

- [ ] **Step 1: Bump all package versions to `0.2.0`**

Keep manifest, package, and marketplace versions synchronized. Add portrait configuration for context budgets and capture enablement. Do not expose credential storage configuration.

- [ ] **Step 2: Update seed script**

Seed through explicit v2 evidence ingestion and remain idempotent. Existing v1 data must migrate automatically.

- [ ] **Step 3: Update package checker**

Require all new modules/hooks/tests and validate exactly 13 MCP tools. Validate the SessionStart matcher contains both startup and resume and UserPromptSubmit exists.

- [ ] **Step 4: Update docs**

Explain automatic global portrait capture, natural-use behavior, evidence thresholds, review/correction/forget controls, sensitive classification, credential exclusion, migration, and cross-project scope.

- [ ] **Step 5: Run package check**

```bash
npm run check --prefix plugins/profile-memory
npm run mcp:tools --prefix plugins/profile-memory
```

Expected: all tests PASS and package check reports success.

## Task 8: Install Upgrade and Real ZCode Verification

**Files:**
- Runtime install cache under `~/.zcode/cli/plugins/cache/local-profile-memory-marketplace/profile-memory/0.2.0`
- Runtime data under `~/.zcode/cli/plugins/data/profile-memory@local-profile-memory-marketplace`

- [ ] **Step 1: Validate marketplace through ZCode app-server**

Call `plugins/validate`; require `ok: true` and no error diagnostics.

- [ ] **Step 2: Update marketplace and plugin through official protocol**

Use `plugins/marketplace/update`, then `plugins/install` or the supported update path, and `plugins/setEnabled`. Do not manufacture registry files manually.

- [ ] **Step 3: Verify discovery**

Run:

```bash
node 'D:/新建文件夹/ZCode/resources/glm/zcode.cjs' plugins list --json
```

Assert version `0.2.0`, enabled state, one UserPromptSubmit hook, one SessionStart hook with `startup|resume`, one skill, three commands, and the MCP server.

- [ ] **Step 4: Verify real-data migration**

Run the installed context and portrait tools against the real plugin data directory. Confirm existing memories survive as v2 portrait/evidence and backup exists.

- [ ] **Step 5: Execute installed hooks directly**

With real ZCode environment variables, send a synthetic UserPromptSubmit payload containing a benign explicit preference. Confirm evidence is written and SessionStart returns valid global portrait JSON. Remove the synthetic test evidence afterward through the portrait forget API.

- [ ] **Step 6: Run GUI acceptance test**

Start a completely new GUI session in a different project and a resumed session. Verify natural behavior with a decision task, not keyword recitation. Inspect `/memory portrait` and `/memory evidence` to confirm traceability.

The GUI/model acceptance step requires user observation because the headless CLI lacks model provider configuration. All lower layers must be verified automatically before requesting it.

## Final Verification

Run fresh:

```bash
npm run check --prefix plugins/profile-memory
npm run mcp:tools --prefix plugins/profile-memory
node 'D:/新建文件夹/ZCode/resources/glm/zcode.cjs' plugins list --json
```

Report exact test counts, ZCode-discovered version/hooks/tools, migration result, and whether the final GUI acceptance test was observed or remains pending.
