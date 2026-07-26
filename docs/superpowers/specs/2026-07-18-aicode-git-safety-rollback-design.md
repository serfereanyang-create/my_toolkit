# aicode CLI Git Safety, Checkpoints, and Selective Rollback Design

**Date:** 2026-07-18  
**Status:** Approved for implementation

## 1. Goal

Add repository-level recovery to aicode CLI without disturbing a user's branch, `HEAD`, staging area, existing uncommitted work, or remote history.

The feature must:

- create durable local Git snapshots before and after each execution unit;
- preserve pre-existing dirty work in the baseline snapshot;
- support conflict-safe selective rollback of one execution unit;
- keep an append-only audit trail;
- never push automatically;
- require explicit confirmation for every push, regardless of whether publication uses a local Git remote, a self-hosted Git server, or an MCP provider;
- retain the existing file-level `/undo` as a separate fallback and convenience command.

## 2. Non-goals

This version will not:

- force-push or delete remote branches;
- rewrite user branch history;
- automatically merge or rebase;
- automatically publish checkpoint refs;
- infer file ownership when another process modifies the repository during an active execution unit;
- replace Git with a custom patch archive;
- provide OS-level sandboxing.

## 3. Confirmed Product Decisions

1. **Snapshot representation:** Git commit objects referenced under `refs/aicode/checkpoints/`.
2. **Checkpoint creation:** automatic and local only.
3. **Dirty worktree:** protected in hidden snapshots; never committed to the user's current branch.
4. **Snapshot granularity:** baseline and result snapshots for every task-board task; baseline and result snapshots for every ordinary agent turn.
5. **Rollback scope:** selective rollback of paths changed between that unit's baseline and result snapshots.
6. **Conflict behavior:** all-or-nothing. If any affected path no longer matches the recorded result state, no path is changed.
7. **Non-Git workspace:** ask before `git init`; if confirmation is declined or unavailable, use the existing file checkpoint behavior and record that Git protection was unavailable.
8. **Push behavior:** every push requires a fresh explicit user confirmation. Authorization never persists across pushes.
9. **Remote extensibility:** ordinary Git remotes, self-hosted servers, and MCP publication use a common publisher boundary.

## 4. Architecture

Create a focused `cli/src/git-safety/` package:

```text
cli/src/git-safety/
  types.ts          Domain types and audit event schema
  git.ts            Fixed-argument Git process adapter
  repository.ts     Repository discovery and optional initialization
  snapshot.ts       Temporary-index tree/commit/ref creation
  diff.ts           Snapshot manifest and path-state calculation
  audit.ts          Append-only JSONL audit store
  rollback.ts       Preview, conflict detection, and selective restore
  service.ts        Execution-unit lifecycle orchestration
  publisher.ts      Confirmed push abstraction and local Git implementation
  format.ts         Slash-command output formatting
```

### 4.1 `GitProcess`

`GitProcess` invokes Git through `execFile`, never a concatenated shell command. Public methods accept structured values and validate refs, object IDs, remotes, branches, and repository-relative paths.

It must preserve and restore process-level environment variables and use temporary paths inside `.aicode/git-safety/tmp/`. Temporary index operations set `GIT_INDEX_FILE` only for the child process.

### 4.2 `GitRepository`

Responsibilities:

- discover the enclosing repository and repository root;
- allow the configured workspace to equal the repository root or be a descendant of it, while scoping capture, diff, and restore operations strictly to the configured workspace;
- reject any computed path that escapes either the repository root or configured workspace through traversal, symlink resolution, or malformed Git output;
- determine whether `HEAD` is unborn;
- return current branch/ref and status metadata without changing them;
- initialize a repository only after a runtime confirmation callback returns true;
- never edit global or local Git identity configuration.

For snapshot commits, identity is passed only to the child Git process:

```text
GIT_AUTHOR_NAME=aicode checkpoint
GIT_AUTHOR_EMAIL=aicode@local.invalid
GIT_COMMITTER_NAME=aicode checkpoint
GIT_COMMITTER_EMAIL=aicode@local.invalid
```

### 4.3 `GitSnapshotStore`

The snapshot store uses a dedicated temporary index:

1. create a fresh temporary index file;
2. if `HEAD` exists, initialize it with `git read-tree HEAD`; otherwise initialize an empty index;
3. run `git add -A -- <workspace-pathspec>` against the temporary index to capture tracked changes, deletions, and non-ignored untracked files within the configured workspace;
4. exclude CLI-owned runtime artifacts under `.aicode/` using an internal Git pathspec exclusion, except when a future explicit user setting opts those paths into source control; user `.gitignore` rules continue to apply;
5. create a tree using `git write-tree`;
6. create a commit using `git commit-tree`, with the current `HEAD` as informational parent when one exists;
7. update one hidden ref using compare-and-swap semantics;
8. delete the temporary index in `finally`.

The user's index, branch, `HEAD`, and worktree are not changed.

Refs use validated IDs:

```text
refs/aicode/checkpoints/<unit-id>/baseline
refs/aicode/checkpoints/<unit-id>/result
refs/aicode/checkpoints/<unit-id>/rollback-<rollback-id>
```

A snapshot contains at least:

- snapshot ID and phase;
- unit ID;
- commit and tree object IDs;
- hidden ref;
- captured `HEAD` object ID, if any;
- current branch name, if attached;
- timestamp;
- session, turn, board, and task correlation fields.

### 4.4 `GitRollbackAuditLog`

The authoritative audit trail is append-only JSONL:

```text
.aicode/git-safety/audit.jsonl
```

Each line is a versioned event with:

- event ID and schema version;
- event type;
- timestamp;
- workspace/repository identity;
- session ID;
- unit ID and unit kind (`turn` or `task`);
- optional turn, board, and task IDs;
- snapshot refs and object IDs;
- affected path records with baseline/result/current blob IDs and modes where relevant;
- outcome and sanitized error information;
- push target metadata for publication events, excluding credentials.

Required event types:

```text
repository_init_requested
repository_initialized
repository_init_declined
unit_started
snapshot_created
snapshot_failed
unit_finished
rollback_previewed
rollback_conflicted
rollback_applied
rollback_failed
push_requested
push_declined
push_succeeded
push_failed
```

Audit writes create the parent directory and append one complete UTF-8 line. Secrets, remote credentials, file contents, prompts, and environment variables are never logged. A failed audit append is surfaced as a warning; it does not justify destructive fallback behavior.

## 5. Execution-unit Lifecycle

### 5.1 Unit identity

Every protected operation gets an immutable unit ID.

- Task-board unit: correlated with `sessionId`, `boardId`, and `taskId`.
- Ordinary turn unit: correlated with `sessionId` and a generated `turnId`.

### 5.2 Start

Before model/tool execution:

1. discover the repository;
2. if absent, request confirmation for `git init`;
3. if approved, initialize and continue;
4. if declined or confirmation is unavailable, mark the unit as file-checkpoint-only and continue under existing safeguards;
5. create the baseline hidden snapshot;
6. append lifecycle and snapshot events.

If a Git repository exists but baseline creation fails, the unit may continue only with an explicit warning and existing file checkpoints. It must never be represented as Git-protected.

### 5.3 Finish

A result snapshot is attempted in a `finally`-style lifecycle for these outcomes:

- done;
- blocked;
- failed;
- cancelled.

After result creation, calculate and persist the baseline-to-result manifest. A result-snapshot failure is recorded and reported. It does not move `HEAD` or trigger an automatic reset.

### 5.4 Concurrent changes

All changes captured between baseline and result belong to the execution window for recovery purposes. The system does not claim that every captured change was authored by the CLI. The result-state conflict check prevents rollback from overwriting changes made after the result snapshot.

## 6. Manifest and Selective Rollback

### 6.1 Path state

For every path changed between baseline and result, record:

- repository-relative path;
- optional source path for a detected rename;
- change kind: add, modify, delete, rename, type-change, or mode-change;
- baseline blob/object ID and mode, if present;
- result blob/object ID and mode, if present.

Path data comes from Git tree/diff plumbing with NUL-delimited output where Git supports it. Paths are never parsed by splitting human-formatted whitespace.

### 6.2 Commands

Add slash commands:

```text
/rollback list
/rollback show <unit-id>
/rollback preview <unit-id>
/rollback apply <unit-id>
```

Behavior:

- `list` returns recent units and their protection/outcome state.
- `show` displays snapshot and audit metadata.
- `preview` performs a fresh conflict check and displays exact affected paths and actions.
- `apply` always repeats preview internally immediately before writing.

The existing `/undo` remains a single-file checkpoint command and does not become an alias for `/rollback`.

### 6.3 Conflict detection

Before any write, compare every affected path's current worktree state with its recorded result state, including existence, blob/object ID, and Git mode (`100644`, `100755`, or `120000`). Capture the real user index state for affected paths in both the baseline and result unit metadata without changing it.

Rules:

- if every path matches, rollback may proceed;
- if any path differs, append `rollback_conflicted`, list conflicts, and change nothing;
- ignored files not captured by the snapshot are outside the rollback scope;
- pre-existing staged content is allowed and remains untouched;
- if the real index state for any affected path differs from the index state recorded at result-snapshot time, treat it as a conflict;
- because rollback never writes the index, successful rollback may leave an intentional staged/worktree difference that reflects the user's pre-existing staged content.

Rollback modifies only the worktree. It does not change `HEAD`, current branch, or index.

### 6.4 Applying rollback

Restore baseline path states using Git object contents and validated filesystem operations:

- baseline file present: write exact blob bytes and restore supported mode;
- baseline path absent: remove the result-created path only after conflict checks;
- deleted file: recreate from the baseline blob;
- rename: remove result destination and restore baseline source as one planned transaction;
- symlink: restore as a symlink only where the platform and repository mode support it; otherwise report unsupported/conflict without partial writes.

Atomicity is best-effort at filesystem level. Before applying, create a fresh pre-rollback hidden snapshot. If a filesystem write fails after changes begin, append `rollback_failed`, retain the pre-rollback snapshot, and provide its ID for recovery. No `git reset --hard`, forced checkout, or branch switch is used.

After success, create a `rollback-<rollback-id>` snapshot and append `rollback_applied` with the restored paths.

## 7. Remote Publication Safety

### 7.1 Publisher interface

Define a `GitRemotePublisher` interface that accepts a structured publication request and returns a structured result. Initial implementation supports an existing local Git remote through fixed-argument Git invocation. Future MCP/self-hosted publishers implement the same interface.

### 7.2 Mandatory confirmation

Every push requires a fresh confirmation containing:

- publisher type;
- sanitized remote identity/URL;
- local source object/ref;
- destination branch/ref;
- commits or objects to be published;
- whether checkpoint refs are included.

Confirmation is scoped to that exact request and expires immediately after the attempt. No session-wide or project-wide push authorization exists.

### 7.3 Hard prohibitions

The publication layer rejects, before confirmation:

- force push and force-with-lease;
- deletion refspecs;
- remote branch deletion;
- wildcard refspecs;
- pushing directly to hidden `refs/aicode/checkpoints/` unless a future explicit product feature defines a reviewed destination;
- credentials embedded in logged URLs;
- shell-form Git commands.

Default task execution never invokes publication. Push is exposed only through an explicit user-entered command:

```text
/git publish <remote> <local-ref> <remote-branch>
```

The command resolves and previews the exact structured request before asking for confirmation. Agents and task-board automation cannot invoke it indirectly. All requests, declines, successes, and failures are audited.

## 8. Safety-policy Changes

- Add first-class, structured Git safety operations instead of relying on `run_command`.
- Remove mutating `git branch` forms from the automatic shell allowlist; only proven read-only forms remain automatic.
- Continue blocking `git reset --hard` and expand command classification so global Git options or executable suffixes cannot trivially bypass destructive-command detection.
- Dedicated rollback code never calls `run_command`.
- `approval=auto` does not authorize repository initialization or push.
- Non-interactive mode cannot initialize or push without a dedicated, explicit command-line authorization designed for that exact operation; this version provides no such push bypass.

## 9. Error Handling and Recovery

- Git not installed: warn, use existing file checkpoints, audit when possible.
- Not a repository: request initialization; decline means fallback without Git protection.
- Empty repository: create parentless snapshot commits.
- Temporary-index failure: clean temporary files in `finally`; do not touch the user index.
- Ref update race: fail the snapshot and report concurrent mutation; never overwrite a ref blindly.
- Corrupt audit line: preserve it, skip it when listing with a warning, and continue reading subsequent valid lines.
- Missing Git object/ref: refuse rollback and report the missing recovery artifact.
- Worktree/index conflict: refuse the entire rollback.
- Rollback partial filesystem failure: retain pre-rollback snapshot and report manual recovery instructions.
- Push failure: do not retry automatically and do not broaden authorization.

## 10. Retention

Checkpoint refs and audit events are durable by default. This version does not automatically prune them. A future explicit maintenance command may provide previewed retention/pruning, but task execution and rollback never delete checkpoint refs automatically.

## 11. Integration Points

- `runAgentTurn`: wrap ordinary turns with the Git safety unit lifecycle.
- `runTaskBoardLoop`: create one unit around each task execution and correlate board/task IDs.
- Runtime composition in `index.ts`: instantiate repository, snapshot, audit, rollback, and service dependencies.
- `handleSlashCommand`: add `/rollback` commands and the separately confirmed `/git publish` command.
- `TerminalUI`: display protection state, snapshot IDs, rollback conflicts, and degraded-mode warnings.
- Existing `CheckpointStore`: retained for file-level `/undo` and degraded protection.
- Audit checks, README, help, and capability matrix: document semantics and limitations.

The ordinary-turn and task-board integrations must not create nested duplicate units. When a task-board task invokes the agent, the task unit is authoritative and the inner agent turn receives an existing unit context.

## 12. Testing Strategy

### 12.1 Unit tests

- ref/unit ID validation;
- append-only audit serialization, sanitization, and corrupt-line tolerance;
- manifest parsing for spaces, Unicode, renames, deletion, binary blobs, and modes;
- push request validation and mandatory one-shot confirmation;
- safety-policy rejection of destructive Git command variants.

### 12.2 Repository integration tests

Use temporary real Git repositories and local-only configuration:

- clean repository baseline/result snapshots;
- dirty tracked, staged, unstaged, deleted, and untracked files;
- unborn `HEAD`;
- snapshot creation leaves `HEAD`, branch, worktree, and real index byte-for-byte/logically unchanged;
- hidden refs point to readable commits;
- task-selective rollback restores only changed task paths;
- added, deleted, renamed, executable, binary, Unicode, and spaced paths;
- post-result external edit produces all-or-nothing conflict with zero writes;
- staged changes produce a conflict and remain unchanged;
- failed rollback retains pre-rollback snapshot;
- initialization requires confirmation;
- declined initialization uses degraded file checkpoints;
- task-board and ordinary turns create exactly one baseline/result pair each;
- blocked and failed units still attempt result snapshots.

### 12.3 Publication tests

Use a temporary bare local remote:

- no push occurs without confirmation;
- each push asks independently;
- declined push makes no remote change;
- accepted normal push succeeds and is audited;
- force and deletion refspecs are rejected before confirmation;
- credentials are redacted from logs and UI.

### 12.4 Regression and full verification

Run:

```text
npm run typecheck
npm test
npm run audit:100
```

Add structural audit checks for the package, commands, tests, documentation, push prohibitions, and removal of mutating `git branch` from automatic shell policy.

## 13. Acceptance Criteria

The feature is complete when:

1. every ordinary turn and task-board task receives at most one baseline/result pair;
2. snapshot creation does not move `HEAD`, switch branches, alter the user index, or commit to the current branch;
3. a dirty workspace is captured safely;
4. `/rollback preview` identifies exact task changes and conflicts;
5. `/rollback apply` restores only baseline states when every result-state check passes;
6. any conflict prevents all writes;
7. all lifecycle, rollback, and publication events are appended to durable JSONL without secrets;
8. non-Git initialization and every push require explicit confirmation;
9. force pushes, remote deletion, destructive resets, and automatic publication remain prohibited;
10. existing `/undo`, task-board, memory, session, and tool behavior continue to pass their tests.
