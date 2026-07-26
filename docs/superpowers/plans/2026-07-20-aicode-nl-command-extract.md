# aicode NL Command Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared natural-language command extractor that directly executes high-confidence read-only tool chains and injects stronger strategy for everything else.

**Architecture:** Introduce `cli/src/agent/commandExtract/` with pure extract/plan helpers plus an execute path that reuses the existing tool registry. `runAgentTurn` consults the planner before calling a provider; mock planning reuses the same extractor so rule systems do not drift.

**Tech Stack:** TypeScript, Node.js `node:test`, existing agent/tool/session infrastructure.

**Spec:** `docs/superpowers/specs/2026-07-20-aicode-nl-command-extract-design.md`

---

## File Map

**Create**
- `cli/src/agent/commandExtract/types.ts`
- `cli/src/agent/commandExtract/extract.ts`
- `cli/src/agent/commandExtract/plan.ts`
- `cli/src/agent/commandExtract/format.ts`
- `cli/src/agent/commandExtract/execute.ts`
- `cli/src/agent/commandExtract/index.ts`
- `cli/tests/command-extract.test.ts`

**Modify**
- `cli/src/agent/agent.ts` — consult extractor before provider
- `cli/src/providers/mock.ts` — reuse shared planner
- `cli/src/agent/toolStrategy.ts` — share helpers where needed, avoid duplicate sources of truth
- `cli/src/audit/checks.ts` — new files/needles
- `cli/README.md` / `cli/docs/capability-matrix.md` — document NL command extraction

---

### Task 1: Extractor types, pure extract/plan, unit tests

**Files:**
- Create: `cli/src/agent/commandExtract/types.ts`
- Create: `cli/src/agent/commandExtract/extract.ts`
- Create: `cli/src/agent/commandExtract/plan.ts`
- Create: `cli/src/agent/commandExtract/format.ts`
- Create: `cli/src/agent/commandExtract/index.ts`
- Create: `cli/tests/command-extract.test.ts`

- [ ] **Step 1: Write failing unit tests for extract/plan**

```ts
test('extracts high-confidence readonly intents and slots', () => {
  assert.equal(extractCommand('C盘还有多少空间').intent, 'disk_capacity');
  assert.equal(extractCommand('C盘还有多少空间').slots.drive, 'C');
  assert.equal(extractCommand('搜索 apply_patch').intent, 'code_search');
  assert.equal(extractCommand('读取 package.json').intent, 'file_read');
  assert.equal(extractCommand('读取 package.json').slots.path, 'package.json');
});

test('plans direct execution only for high-confidence readonly tools', () => {
  assert.equal(planCommand(extractCommand('搜索 apply_patch')).mode, 'execute');
  assert.equal(planCommand(extractCommand('帮我改登录按钮样式')).mode, 'strategy');
  assert.equal(planCommand(extractCommand('运行 npm test')).mode, 'strategy');
});
```

- [ ] **Step 2: Run test to verify RED**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
```

Expected: missing module errors for commandExtract.

- [ ] **Step 3: Implement types + extract + plan + format**

Public API:

```ts
export function extractCommand(prompt: string): ExtractionResult;
export function planCommand(extraction: ExtractionResult): CommandPlan;
export function formatCommandStrategy(plan: CommandPlan, extraction: ExtractionResult): string;
```

Direct-execute allowlist only: `disk_info`, `disk_growth`, `project_status`, `project_index`, `search_text`, `read_file`, `environment_info`, `process_memory`, `recent_activity`.

- [ ] **Step 4: Run unit tests GREEN**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/command-extract.test.js"
```

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/34516/ZCodeProject/cli" add src/agent/commandExtract tests/command-extract.test.ts
git -C "C:/Users/34516/ZCodeProject/cli" commit -m "feat: add NL command extract and readonly plan primitives"
```

---

### Task 2: Direct execute path and agent integration

**Files:**
- Create: `cli/src/agent/commandExtract/execute.ts`
- Modify: `cli/src/agent/agent.ts`
- Modify: `cli/tests/command-extract.test.ts`
- Modify: `cli/tests/autonomy.test.ts` if needed

- [ ] **Step 1: Write failing integration tests**

```ts
test('high-confidence readonly prompt executes tools without calling provider', async () => {
  // provider.complete must not be called
  // session contains disk_info or search_text tool call
});

test('strategy-only edit prompt still calls provider with strategy text', async () => {
  // provider receives toolStrategy containing intent=code_edit
});
```

- [ ] **Step 2: Implement executeCommandPlan(runtime, plan)**

Reuse `runtime.tools.execute`, session append, UI events. On full success return final answer. On recoverable failure return `{ fallbackToProvider: true }`.

- [ ] **Step 3: Wire into runAgentTurnCore before provider loop**

If plan.mode === 'execute' and execution succeeds, return without provider. Otherwise format strategy and continue existing loop.

- [ ] **Step 4: Run focused tests GREEN**

```bash
node --test dist/tests/command-extract.test.js dist/tests/autonomy.test.js dist/tests/smoke.test.js
```

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/34516/ZCodeProject/cli" commit -am "feat: execute high-confidence readonly NL tool chains"
```

---

### Task 3: Mock reuse + docs/audit + full verification

**Files:**
- Modify: `cli/src/providers/mock.ts`
- Modify: `cli/src/audit/checks.ts`
- Modify: `cli/README.md`
- Modify: `cli/docs/capability-matrix.md`

- [ ] **Step 1: Make mock.planNaturalLanguage use shared extract/plan**

Keep one-tool-per-turn serialization for existing smoke compatibility, but source steps from shared planner for overlapping intents.

- [ ] **Step 2: Update audit needles and docs**

Needles: `extractCommand`, `planCommand`, `executeCommandPlan`, high-confidence tests, capability matrix row for NL command extraction.

- [ ] **Step 3: Full verification**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run typecheck
npm --prefix "C:/Users/34516/ZCodeProject/cli" test
npm --prefix "C:/Users/34516/ZCodeProject/cli" run audit:100
npm --prefix "C:/Users/34516/ZCodeProject/cli" run smoke
```

- [ ] **Step 4: Commit**

```bash
git -C "C:/Users/34516/ZCodeProject/cli" commit -am "feat: share NL extraction with mock and document command extract"
```
