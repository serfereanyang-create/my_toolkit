# aicode CLI P5 Git Workflow Design

**Date:** 2026-07-21  
**Status:** Approved for implementation

## Goal

Link task boards to a controlled Git workflow:

1. On `/plan confirm` (and auto-confirm via `--confirm-plan`), create/switch to `aicode/board-<id>` branch.
2. When the board becomes fully completed (all tasks done/skipped and verified), preview changes and prompt for a single confirmed commit.
3. Never auto-push; publish remains `/git publish`.

## Non-goals

- Auto push / force push
- Per-task commits in v1
- Rewriting history / rebase
- Replacing hidden safety snapshots

## Integration points

- `handlePlanCommand` confirm
- `handleDevelopmentPrompt` auto-confirm path
- `continueTaskBoard` after `runTaskBoardLoop` when board completed
- New helpers in `cli/src/git-safety/workflow.ts`
- Optional board fields: `gitBranch`, `gitCommitSha`

## Safety

- Dirty unrelated work: still create branch from current HEAD (Git keeps dirty files).
- Non-interactive without confirm callback: create branch if possible; skip commit and print how to `/git commit`.
- Commit only stages non-ignored tracked/untracked source changes via `git add -A` then commit; respect `.gitignore`.
- Commit message includes board goal and task summaries.
