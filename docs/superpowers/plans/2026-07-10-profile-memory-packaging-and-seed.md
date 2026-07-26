# Profile Memory Packaging and Cross-Session Seed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package `profile-memory` as a local ZCode marketplace plugin and add an explicit, idempotent seed command that persists confirmed profile keywords for SessionStart injection in new sessions.

**Architecture:** Keep the existing plugin runtime unchanged. Add a pure seed module and CLI wrapper that write through the existing memory storage API, add a local marketplace manifest and package integrity checker, and document the exact persistent-data flow. Tests use temporary directories only; installation and real profile writes remain explicit user actions.

**Tech Stack:** Node.js ESM, built-in `node:test`, JSON plugin manifests, ZCode commands/skills/hooks/MCP.

---

## File Map

- Create `plugins/marketplace.json`: local marketplace catalog pointing at `profile-memory`.
- Create `plugins/profile-memory/package.json`: package metadata and test/check/seed scripts.
- Create `plugins/profile-memory/scripts/seed-profile.mjs`: pure seed validation, deduplication, dry-run, and CLI entry point.
- Create `plugins/profile-memory/scripts/check-package.mjs`: plugin package and MCP tool integrity checks.
- Create `plugins/profile-memory/tests/seed-profile.test.mjs`: seed behavior and SessionStart context regression tests.
- Create `plugins/profile-memory/examples/seed-memory.json`: user-reviewed non-sensitive seed template.
- Create `plugins/profile-memory/CHANGELOG.md`: version history.
- Create `plugins/profile-memory/LICENSE`: MIT license matching the manifest.
- Create `plugins/profile-memory/docs/INSTALL.md`: local directory, marketplace, and cross-session seed installation guide.
- Create `plugins/profile-memory/docs/PUBLISHING.md`: release checklist.
- Modify `plugins/profile-memory/README.md`: package scripts and cross-session quick start.

## Task 1: Seed Profile Module

**Files:**
- Create: `plugins/profile-memory/tests/seed-profile.test.mjs`
- Create: `plugins/profile-memory/scripts/seed-profile.mjs`
- Create: `plugins/profile-memory/examples/seed-memory.json`

- [ ] **Step 1: Add the seed fixture**

Create `examples/seed-memory.json` with one confirmed global memory:

```json
{
  "type": "interest",
  "scope": "global",
  "summary": "用户关注跨会话的用户画像式记忆，尤其重视关键词提取和长期偏好建模。",
  "keywords": ["用户画像", "关键词提取", "跨会话记忆", "记忆插件", "长期偏好建模"],
  "confidence": 0.9,
  "source": "confirmed"
}
```

- [ ] **Step 2: Write seed tests**

Test these exact behaviors with `mkdtemp`:

```js
const dryRun = await seedProfile({ dataDir, seedPath, dryRun: true });
assert.equal(dryRun.action, "would-add");
assert.deepEqual(await loadStore(dataDir), { version: 1, memories: [] });

const first = await seedProfile({ dataDir, seedPath });
assert.equal(first.action, "added");
assert.equal((await loadStore(dataDir)).memories.length, 1);

const second = await seedProfile({ dataDir, seedPath });
assert.equal(second.action, "skipped-duplicate");
assert.equal((await loadStore(dataDir)).memories.length, 1);

const context = await loadProfileContext(dataDir);
assert.match(context, /用户画像/);
assert.match(context, /关键词提取/);
```

Also test that `seedProfile({ seedPath })` rejects with `data directory is required`.

- [ ] **Step 3: Run the focused test and confirm failure**

Run:

```bash
node --test plugins/profile-memory/tests/seed-profile.test.mjs
```

Expected: FAIL because `scripts/seed-profile.mjs` does not exist.

- [ ] **Step 4: Implement seed validation and idempotency**

Export:

```js
async function seedProfile({ dataDir, seedPath, dryRun = false })
```

Rules:

- Require `dataDir` and `seedPath`.
- Parse and validate `summary`, non-empty `keywords`, allowed `type`, `scope`, `source`, and confidence `0..1`.
- Identify duplicates by exact normalized summary or at least 80% keyword overlap.
- Return `{ action: "would-add", memory, dataPath }` on dry-run.
- Return `{ action: "skipped-duplicate", memory, dataPath }` when matched.
- Otherwise call existing `addMemory` and return `{ action: "added", memory, dataPath }`.
- CLI accepts `--data-dir`, `--seed`, and `--dry-run`; it also reads `PROFILE_MEMORY_DATA`.
- CLI exits nonzero with a concise message when no data directory is supplied.

- [ ] **Step 5: Re-run focused tests**

Run:

```bash
node --test plugins/profile-memory/tests/seed-profile.test.mjs
```

Expected: all seed tests PASS.

## Task 2: Local Marketplace and Package Scripts

**Files:**
- Create: `plugins/marketplace.json`
- Create: `plugins/profile-memory/package.json`
- Create: `plugins/profile-memory/scripts/check-package.mjs`

- [ ] **Step 1: Add local marketplace manifest**

Create:

```json
{
  "name": "local-profile-memory-marketplace",
  "version": 1,
  "pluginRoot": ".",
  "plugins": [
    {
      "name": "profile-memory",
      "version": "0.1.0",
      "description": "Local user-profile memory for ZCode with keyword extraction and explicit confirmation.",
      "source": "profile-memory"
    }
  ]
}
```

- [ ] **Step 2: Add package scripts**

Create `package.json` with no dependencies:

```json
{
  "name": "@local/profile-memory-zcode-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "check": "node scripts/check-package.mjs && node --test tests/*.test.mjs",
    "mcp:tools": "node scripts/check-package.mjs --mcp-tools",
    "seed": "node scripts/seed-profile.mjs"
  }
}
```

- [ ] **Step 3: Implement package checker**

The checker must:

- Parse `.zcode-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, and `examples/seed-memory.json`.
- Verify manifest version equals package version.
- Verify manifest component paths exist inside the plugin root.
- Verify commands, skill, MCP server, context CLI, SessionStart hook, seed script, README, CHANGELOG, LICENSE, INSTALL, and PUBLISHING files.
- Validate the seed fixture contains no keys matching `password`, `token`, `secret`, `apiKey`, `privateKey`, `address`, `idNumber`, or `bankCard` case-insensitively.
- Print `package check ok` on success.
- With `--mcp-tools`, spawn the MCP server, send `initialize` and `tools/list`, and assert the exact seven expected tools.

- [ ] **Step 4: Run package checker**

Run:

```bash
node plugins/profile-memory/scripts/check-package.mjs
```

Expected: FAIL until documentation files are added in Task 3. This verifies the checker catches incomplete packages.

## Task 3: Packaging and Installation Documentation

**Files:**
- Create: `plugins/profile-memory/CHANGELOG.md`
- Create: `plugins/profile-memory/LICENSE`
- Create: `plugins/profile-memory/docs/INSTALL.md`
- Create: `plugins/profile-memory/docs/PUBLISHING.md`
- Modify: `plugins/profile-memory/README.md`

- [ ] **Step 1: Add changelog**

Document version `0.1.0` with keyword extraction, confirmed local storage, seven MCP tools, three slash commands, SessionStart injection, local marketplace, and explicit seed initialization.

- [ ] **Step 2: Add MIT license**

Use the standard MIT license text with year `2026` and copyright holder `Local`.

- [ ] **Step 3: Add installation guide**

Document:

```bash
zcode --plugin-dir /absolute/path/to/plugins/profile-memory
```

and the Plugin Management local marketplace flow using `plugins/marketplace.json` or the `plugins` directory.

For cross-session seed setup, document:

```bash
cd plugins/profile-memory
npm run seed -- --dry-run --data-dir "<profile-memory plugin data directory>"
npm run seed -- --data-dir "<profile-memory plugin data directory>"
```

State that the real plugin data directory is assigned by ZCode, must be confirmed before writing, and that new/cleared sessions trigger SessionStart injection.

- [ ] **Step 4: Add publishing guide**

Require version synchronization, changelog update, `npm run check`, sensitive-data review, generic examples only, and marketplace source validation.

- [ ] **Step 5: Update README**

Add sections for local marketplace installation, `npm run check`, and “让新会话认识你”. Explain that installation alone does not save a profile; running the seed command or `/remember` does.

## Task 4: Full Verification

**Files:**
- Verify all files under `plugins/profile-memory`
- Verify `plugins/marketplace.json`

- [ ] **Step 1: Run package check and all tests**

Run:

```bash
cd plugins/profile-memory && npm run check
```

Expected: `package check ok`, then all tests PASS.

- [ ] **Step 2: Verify MCP tool discovery**

Run:

```bash
cd plugins/profile-memory && npm run mcp:tools
```

Expected: `package check ok` and seven expected MCP tools validated.

- [ ] **Step 3: Verify dry-run and real seed against a temporary directory**

Run with a temporary directory and confirm:

- dry-run creates no `profile-memory.json`;
- first real seed reports `added`;
- second real seed reports `skipped-duplicate`;
- `mcp/context-cli.mjs` output includes `用户画像` and `关键词提取`.

- [ ] **Step 4: Parse marketplace JSON from repository root**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('plugins/marketplace.json','utf8')); console.log('marketplace ok')"
```

Expected: `marketplace ok`.

- [ ] **Step 5: Report real-data limitation**

State explicitly that no real `${ZCODE_PLUGIN_DATA}` directory was modified. Provide the exact command the user can run after identifying the installed plugin data directory.
