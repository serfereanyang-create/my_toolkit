# aicode P4 Verify Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development.

**Goal:** Gate task-board completion on discovered package verification scripts, with one automatic repair retry.

**Architecture:** Add pure discover/run helpers in `tasks/verify.ts`, repair prompt builder, and integrate into `runTaskBoardLoop` after textual done detection. Injectable command runner keeps tests fast.

**Tech Stack:** TypeScript, node:test, existing task board runtime.

**Spec:** `docs/superpowers/specs/2026-07-21-aicode-verify-loop-design.md`

---

### Task 1: verify discover/run + unit tests

**Files:** Create `cli/src/tasks/verify.ts`, `cli/tests/task-verify.test.ts`

- discover typecheck/test/build from package.json
- run suite with injectable runner
- truncation, skip missing, fail on nonzero
- env `AICODE_VERIFY_TASKS=0` disable helper `isVerifyTasksEnabled()`

### Task 2: integrate into runTaskBoardLoop + repair once

**Files:** Modify `cli/src/tasks/runtime.ts`, add `buildRepairPrompt` in verify.ts

- after textual done, run verify
- fail → one repair turn → re-verify
- pass → markTaskDone with verified note
- fail → blocked + pause + memory pitfall

### Task 3: docs/audit + full verification

Update README, capability-matrix, audit checks; run full test/audit/smoke; commit.
