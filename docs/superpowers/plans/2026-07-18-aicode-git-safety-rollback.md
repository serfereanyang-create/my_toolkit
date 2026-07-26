# aicode CLI Git Safety and Selective Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every ordinary agent turn and task-board task local baseline/result Git snapshots, append-only audit history, conflict-safe selective rollback, and explicitly confirmed non-force publication without changing the user's branch, `HEAD`, or index.

**Architecture:** Add a focused `src/git-safety/` package that uses fixed-argument `execFile` Git plumbing and a temporary index to create hidden checkpoint commits under `refs/aicode/checkpoints/`. A lifecycle facade wraps ordinary turns and task-board tasks exactly once; a separate rollback service restores only affected worktree paths after all-or-nothing conflict checks; publication remains a user-only slash command with one-shot confirmation.

**Tech Stack:** TypeScript 5.8, Node.js 24 (`node:test`, `node:assert`, `child_process.execFile`, `fs/promises`), Git plumbing, JSONL.

**Approved spec:** `docs/superpowers/specs/2026-07-18-aicode-git-safety-rollback-design.md`

**Commit policy:** This workspace is not currently a Git repository and the user has not requested repository initialization or commits for development work. Run no `git init`, `git add`, or `git commit` against this workspace while implementing. The product tests create isolated temporary repositories only.

---

## File Map

**Create**

- `cli/src/git-safety/types.ts` — domain types, unit/snapshot/manifest/audit/publication contracts.
- `cli/src/git-safety/git.ts` — fixed-argument Git process adapter and validators.
- `cli/src/git-safety/audit.ts` — append-only, sanitized JSONL audit store.
- `cli/src/git-safety/repository.ts` — repository discovery, workspace scoping, confirmed initialization.
- `cli/src/git-safety/snapshot.ts` — temporary-index tree/commit/ref snapshots.
- `cli/src/git-safety/diff.ts` — NUL-safe snapshot manifests and current/index path states.
- `cli/src/git-safety/service.ts` — exactly-once execution-unit lifecycle.
- `cli/src/git-safety/rollback.ts` — rollback query, preview, all-or-nothing conflict detection, apply.
- `cli/src/git-safety/publisher.ts` — one-shot confirmed local Git publisher.
- `cli/src/git-safety/format.ts` — CLI-safe list/show/preview/status formatting.
- `cli/tests/git-test-helpers.ts` — isolated real-Git fixtures.
- `cli/tests/git-safety.test.ts` — Git adapter/repository/snapshot/audit/lifecycle tests.
- `cli/tests/git-rollback.test.ts` — selective rollback tests.
- `cli/tests/git-publisher.test.ts` — confirmed publication and prohibition tests.

**Modify**

- `cli/src/agent/agent.ts` — ordinary-turn lifecycle wrapper, explicit current-turn result.
- `cli/src/tasks/runtime.ts` — task unit ownership and `finally` result snapshot.
- `cli/src/cli/repl.ts` — pass task-owned unit context into the inner agent turn.
- `cli/src/cli/commands.ts` — `/rollback` and `/git publish`.
- `cli/src/index.ts` — production dependency composition.
- `cli/src/safety/policy.ts` — remove mutating Git branch auto-allow and harden destructive Git detection.
- `cli/src/audit/checks.ts` — structural checks and test/document needles.
- `cli/tests/autonomy.test.ts` — ordinary-turn exactly-once lifecycle tests.
- `cli/tests/task-board.test.ts` — task ownership/no-nesting tests.
- `cli/tests/approval.test.ts` — shell Git safety regressions.
- `cli/tests/cli-process.test.ts` — non-interactive non-Git behavior.
- `cli/README.md` — commands, semantics, degraded mode, push safety.
- `cli/docs/capability-matrix.md` — implemented Git safety capability and limits.

---

### Task 1: Domain contracts, Git adapter, and append-only audit

**Files:**
- Create: `cli/src/git-safety/types.ts`
- Create: `cli/src/git-safety/git.ts`
- Create: `cli/src/git-safety/audit.ts`
- Create: `cli/tests/git-test-helpers.ts`
- Create: `cli/tests/git-safety.test.ts`

- [ ] **Step 1: Add failing validator and audit tests**

Start `cli/tests/git-safety.test.ts` with behavior-focused tests:

```ts
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { GitAuditLog } from '../src/git-safety/audit.js';
import { GitProcess, assertObjectId, assertSafeRef, assertSafeRelativePath } from '../src/git-safety/git.js';
import { makeTempWorkspace } from './git-test-helpers.js';

test('Git validators reject unsafe refs object ids and paths', () => {
  assert.throws(() => assertSafeRef('refs/aicode/../../heads/main'));
  assert.throws(() => assertObjectId('HEAD'));
  assert.throws(() => assertSafeRelativePath('../outside.txt'));
  assert.equal(assertSafeRef('refs/aicode/checkpoints/unit_123/baseline'), 'refs/aicode/checkpoints/unit_123/baseline');
  assert.equal(assertObjectId('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(assertSafeRelativePath('src/space name.ts'), 'src/space name.ts');
});

test('GitAuditLog appends events and skips corrupt lines with a warning', async () => {
  const fixture = await makeTempWorkspace('audit');
  try {
    const log = new GitAuditLog(fixture.root);
    await log.append({
      version: 1,
      id: 'event_1',
      type: 'unit_started',
      timestamp: '2026-07-18T00:00:00.000Z',
      workspaceRoot: fixture.root,
      sessionId: 'sess_1',
      unitId: 'unit_1',
      unitKind: 'turn',
    });
    await writeFile(log.filePath, `${await readFile(log.filePath, 'utf8')}not-json\n`, 'utf8');
    const result = await log.read();
    assert.equal(result.events.length, 1);
    assert.match(result.warnings[0], /corrupt audit line/i);
  } finally {
    await fixture.cleanup();
  }
});

test('GitAuditLog redacts credentials from remote publication events', async () => {
  const fixture = await makeTempWorkspace('audit-redact');
  try {
    const log = new GitAuditLog(fixture.root);
    await log.append({
      version: 1,
      id: 'event_2',
      type: 'push_requested',
      timestamp: '2026-07-18T00:00:00.000Z',
      workspaceRoot: fixture.root,
      sessionId: 'sess_1',
      remote: 'https://user:secret@example.test/repo.git',
      localRef: 'refs/heads/main',
      remoteBranch: 'main',
    });
    const raw = await readFile(log.filePath, 'utf8');
    assert.doesNotMatch(raw, /secret/);
    assert.match(raw, /https:\/\/example\.test\/repo\.git/);
  } finally {
    await fixture.cleanup();
  }
});
```

Create `cli/tests/git-test-helpers.ts` with a temporary-workspace helper that always cleans up and a fixed-argument `git()` helper using `execFile` rather than shell interpolation.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/git-safety.test.js"
```

Expected: build fails because `src/git-safety/audit.ts`, `git.ts`, and `types.ts` do not exist.

- [ ] **Step 3: Define stable domain contracts**

Implement `types.ts` with these public contracts and no prompt/file-content/credential fields:

```ts
export type GitUnitKind = 'turn' | 'task';
export type GitUnitOutcome = 'done' | 'blocked' | 'failed' | 'cancelled';
export type GitProtectionMode = 'git' | 'file-checkpoint-only';
export type GitSnapshotPhase = 'baseline' | 'result' | 'pre-rollback' | 'rollback-result';
export type GitMode = '100644' | '100755' | '120000';

export type GitUnitRequest = {
  kind: GitUnitKind;
  sessionId: string;
  turnId?: string;
  boardId?: string;
  taskId?: string;
};

export type GitRepositoryInfo = {
  root: string;
  workspaceRoot: string;
  workspacePathspec: string;
  head?: string;
  branch?: string;
};

export type GitIndexEntry = { path: string; mode: string; oid: string; stage: number };
export type GitPathState = { path: string; oid?: string; mode?: GitMode };
export type GitPathChange = {
  kind: 'add' | 'modify' | 'delete' | 'rename' | 'type-change' | 'mode-change';
  path: string;
  sourcePath?: string;
  baseline: GitPathState;
  result: GitPathState;
  resultIndex: GitIndexEntry[];
};

export type GitSnapshot = {
  id: string;
  unitId: string;
  phase: GitSnapshotPhase;
  ref: string;
  commit: string;
  tree: string;
  createdAt: string;
  repository: GitRepositoryInfo;
};

export type GitUnitContext = {
  unitId: string;
  request: GitUnitRequest;
  protectionMode: GitProtectionMode;
  repository?: GitRepositoryInfo;
  baseline?: GitSnapshot;
  warnings: string[];
  finished?: boolean;
};

export type GitUnitResult = GitUnitContext & {
  outcome: GitUnitOutcome;
  result?: GitSnapshot;
  changes: GitPathChange[];
};

export type GitAuditEvent = {
  version: 1;
  id: string;
  type: string;
  timestamp: string;
  workspaceRoot: string;
  sessionId?: string;
  unitId?: string;
  unitKind?: GitUnitKind;
  boardId?: string;
  taskId?: string;
  outcome?: string;
  protectionMode?: GitProtectionMode;
  baseline?: GitSnapshot;
  result?: GitSnapshot;
  snapshot?: Partial<GitSnapshot>;
  changes?: GitPathChange[];
  conflicts?: string[];
  remote?: string;
  localRef?: string;
  remoteBranch?: string;
  error?: string;
};
```

- [ ] **Step 4: Implement the fixed-argument Git adapter**

Implement `git.ts` around `execFile` with:

```ts
export class GitProcess {
  constructor(readonly cwd: string) {}
  text(args: readonly string[], options?: GitRunOptions): Promise<string>;
  buffer(args: readonly string[], options?: GitRunOptions): Promise<Buffer>;
}
```

Requirements:

- invoke `git` with an argument array and `{ cwd, windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }`;
- accept an optional child-only `env` map and optional stdin `Buffer`/string;
- never mutate `process.env`;
- throw a `GitCommandError` containing sanitized stderr and exit code;
- validators accept only full 40–64 lowercase/uppercase hex object IDs, Git-valid refs without `..`, `@{`, control characters, backslashes, leading/trailing slash/dot, or empty segments, and normalized repository-relative paths that cannot escape;
- include `sanitizeRemote()` that strips username/password/query/hash before audit/UI use.

- [ ] **Step 5: Implement append-only JSONL audit**

Implement `GitAuditLog`:

```ts
export class GitAuditLog {
  readonly filePath: string;
  constructor(workspaceRoot: string);
  append(event: GitAuditEvent): Promise<void>;
  read(): Promise<{ events: GitAuditEvent[]; warnings: string[] }>;
}
```

`append()` must `mkdir(dirname(filePath), { recursive: true })`, sanitize `remote` and `error`, then use `appendFile(..., `${JSON.stringify(event)}\n`, 'utf8')`. `read()` must return empty data on `ENOENT`, parse each non-empty line independently, preserve later valid lines after corruption, and report one warning per invalid line.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run typecheck
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/git-safety.test.js"
```

Expected: all Task 1 tests pass.

---

### Task 2: Repository discovery and non-invasive hidden snapshots

**Files:**
- Create: `cli/src/git-safety/repository.ts`
- Create: `cli/src/git-safety/snapshot.ts`
- Create: `cli/src/git-safety/diff.ts`
- Modify: `cli/tests/git-test-helpers.ts`
- Modify: `cli/tests/git-safety.test.ts`

- [ ] **Step 1: Add real-repository RED tests**

Extend helpers with:

```ts
export async function makeGitRepository(name: string, options?: { unborn?: boolean; workspaceSubdir?: string }) {
  // mkdtemp, git init, command-scoped test identity, optional initial commit,
  // return root/workspace/git(args)/readIndexBytes/cleanup.
}
```

Add tests named exactly:

```ts
test('GitRepository initializes only after explicit confirmation', async () => { /* reject, assert no .git; accept, assert repo */ });
test('GitSnapshotStore creates readable baseline and result refs', async () => { /* resolve refs with git cat-file */ });
test('GitSnapshotStore captures dirty tracked staged deleted and untracked files', async () => { /* inspect snapshot trees */ });
test('GitSnapshotStore supports an unborn HEAD', async () => { /* parentless snapshot commit */ });
test('GitSnapshotStore excludes aicode runtime artifacts', async () => { /* .aicode/audit absent */ });
test('snapshot creation preserves HEAD branch worktree and real index', async () => { /* compare before/after */ });
test('GitSnapshotDiff parses Unicode spaced binary rename and mode changes', async () => { /* exact manifest */ });
```

For the preservation test record before and after:

- `git rev-parse HEAD`;
- `git symbolic-ref -q HEAD`;
- `git status --porcelain=v1 -z --untracked-files=all` as `Buffer`;
- bytes of `.git/index` when present;
- tracked and untracked file bytes.

- [ ] **Step 2: Run focused tests and verify RED**

Expected: missing repository/snapshot/diff modules or unimplemented methods.

- [ ] **Step 3: Implement repository discovery and confirmed initialization**

Implement:

```ts
export class GitRepository {
  constructor(private readonly workspaceRoot: string, private readonly git: GitProcess) {}
  discover(): Promise<GitRepositoryInfo | undefined>;
  ensure(confirm?: (message: string) => Promise<boolean>): Promise<GitRepositoryInfo | undefined>;
}
```

Rules:

- `discover()` uses `git rev-parse --show-toplevel`, `git rev-parse --verify HEAD`, and `git symbolic-ref --quiet --short HEAD` with expected nonzero handling;
- resolve real paths and require `workspaceRoot` to equal or be a descendant of repository root;
- store the workspace pathspec using forward slashes (`.` at repo root);
- `ensure()` calls `confirm('Workspace is not a Git repository. Initialize a local repository for recovery snapshots?')` once;
- absent/false confirmation returns `undefined` and makes no filesystem change;
- accepted confirmation runs `git init -- <workspaceRoot>` via fixed arguments, then discovers the result;
- no local/global user identity is configured.

- [ ] **Step 4: Implement temporary-index snapshots**

Implement:

```ts
export class GitSnapshotStore {
  constructor(private readonly git: GitProcess, private readonly workspaceRoot: string) {}
  create(repository: GitRepositoryInfo, unitId: string, phase: GitSnapshotPhase): Promise<GitSnapshot>;
}
```

Algorithm:

1. Validate `unitId` as `[A-Za-z0-9._-]+` and map phase to a safe hidden ref.
2. Create `.aicode/git-safety/tmp/` and a unique non-existing `index` path under a `mkdtemp` directory.
3. Set child-only `GIT_INDEX_FILE` and checkpoint identity variables.
4. Run `read-tree <HEAD>` or `read-tree --empty`.
5. Run `add -A -- <workspacePathspec> :(exclude)<workspace>/.aicode :(exclude)<workspace>/.aicode/**` using Git pathspec magic and fixed arguments.
6. `write-tree`, then `commit-tree <tree>` with `-p <HEAD>` only when `HEAD` exists; pass message on stdin.
7. Create the new ref with `update-ref <ref> <commit> <40-zero-old-id>` so an existing unit/phase cannot be overwritten.
8. Resolve the tree and return metadata.
9. Remove the temporary directory in `finally`.

Do not call checkout, reset, stash, branch, commit porcelain, or the generic shell tool.

- [ ] **Step 5: Implement NUL-safe manifests and index capture**

Implement `GitSnapshotDiff` with:

```ts
manifest(repository: GitRepositoryInfo, baseline: GitSnapshot, result: GitSnapshot): Promise<GitPathChange[]>;
currentState(repository: GitRepositoryInfo, path: string): Promise<GitPathState>;
indexState(repository: GitRepositoryInfo, path: string): Promise<GitIndexEntry[]>;
blob(oid: string): Promise<Buffer>;
```

Use `git diff --name-status -z --find-renames <baseline> <result> -- <workspacePathspec>`, parse status/path tuples without whitespace splitting, and query exact entries with `git ls-tree -z <commit> -- <path>`. Normalize statuses into the six domain kinds and attach result-time real-index entries from `git ls-files --stage -z -- <path>`.

`currentState()` hashes regular-file bytes or symlink target bytes using `git hash-object --stdin`, returns absence without throwing on `ENOENT`, and maps mode to `100644`, `100755`, or `120000` (honoring `core.filemode` support).

- [ ] **Step 6: Run repository/snapshot tests**

Run build plus `git-safety.test.js`. Expected: all Task 1–2 tests pass and preservation assertions prove no user state changed.

---

### Task 3: Exactly-once lifecycle service

**Files:**
- Create: `cli/src/git-safety/service.ts`
- Create: `cli/src/git-safety/format.ts`
- Modify: `cli/tests/git-safety.test.ts`

- [ ] **Step 1: Add lifecycle RED tests**

Add tests named:

```ts
test('GitSafetyService degrades after repository initialization is declined', async () => {});
test('GitSafetyService creates one baseline and one result per unit', async () => {});
test('GitSafetyService attempts result after blocked failed and cancelled outcomes', async () => {});
test('GitSafetyService records snapshot failure without changing business outcome', async () => {});
test('GitSafetyService finishes a unit at most once', async () => {});
```

Use injected fake repository/snapshot/diff/audit objects for exact call-order assertions and one real-repository integration case.

- [ ] **Step 2: Run and verify RED**

Expected: `GitSafetyService` is missing.

- [ ] **Step 3: Implement lifecycle orchestration**

Public API:

```ts
export class GitSafetyService {
  async startUnit(
    request: GitUnitRequest,
    options?: { confirm?: (message: string) => Promise<boolean>; onWarning?: (message: string) => void },
  ): Promise<GitUnitContext>;

  async finishUnit(context: GitUnitContext, outcome: GitUnitOutcome): Promise<GitUnitResult>;
}
```

Behavior:

- generate `unit_<timestamp>_<uuid>` and validate task correlation (`task` requires board/task; `turn` must not use task IDs);
- append `unit_started` before protection work;
- `repository.ensure(confirm)`; `undefined` returns `file-checkpoint-only`, appends `repository_init_declined`, and does not throw;
- baseline failure appends `snapshot_failed`, warns, and returns degraded context;
- successful baseline appends `snapshot_created`;
- `finishUnit()` is guarded by an internal `Set<string>` plus `context.finished`; duplicate calls return the first cached result;
- attempt result for every outcome when repository information exists, even if baseline failed;
- compute changes only when both snapshots exist;
- append `snapshot_created`/`snapshot_failed` and exactly one `unit_finished` containing `protectionMode`, complete baseline/result metadata, manifest changes, correlation IDs, and outcome so rollback lookup never depends on mutable task/session records;
- warnings never replace the caller's agent/task success or error;
- formatting emits short object IDs and explicit `file-checkpoint-only` language without secrets.

- [ ] **Step 4: Run lifecycle tests**

Expected: all Git safety tests pass.

---

### Task 4: Conflict-safe selective rollback

**Files:**
- Create: `cli/src/git-safety/rollback.ts`
- Create: `cli/tests/git-rollback.test.ts`
- Modify: `cli/src/git-safety/format.ts`

- [ ] **Step 1: Add rollback RED tests**

Create tests named:

```ts
test('rollback preview lists exact add modify delete and rename actions', async () => {});
test('selective rollback restores only paths changed by the selected unit', async () => {});
test('selective rollback preserves the user index and pre-existing staged content', async () => {});
test('post-result worktree edit conflicts and causes zero rollback writes', async () => {});
test('post-result index edit conflicts and causes zero rollback writes', async () => {});
test('rollback restores binary Unicode spaced and executable paths', async () => {});
test('rollback failure retains a pre-rollback snapshot and audit event', async () => {});
```

Each test must create baseline/result snapshots through the real snapshot store. For all-or-nothing tests, compare every affected file and index byte-for-byte before and after the rejected apply.

- [ ] **Step 2: Run and verify RED**

Expected: rollback service is missing.

- [ ] **Step 3: Implement audit-backed unit lookup and preview**

Implement:

```ts
export type RollbackPreview = {
  unitId: string;
  allowed: boolean;
  changes: GitPathChange[];
  conflicts: Array<{ path: string; reason: string }>;
};

export class GitRollbackService {
  list(): Promise<GitUnitResult[]>;
  show(unitId: string): Promise<GitUnitResult | undefined>;
  preview(unitId: string): Promise<RollbackPreview>;
  apply(unitId: string): Promise<{ ok: boolean; preview: RollbackPreview; snapshot?: GitSnapshot; reason?: string }>;
}
```

Reconstruct completed units from valid `unit_finished` audit events. Refuse missing baseline/result refs or objects. Preview must:

- compare every current worktree state to recorded result state;
- compare every current real-index entry to recorded result-index entries;
- validate source and destination for rename;
- collect every conflict before returning;
- append `rollback_previewed` or `rollback_conflicted`;
- make no writes.

- [ ] **Step 4: Implement apply with preflight and recovery snapshot**

`apply()` must call `preview()` fresh and stop if any conflict. Then:

1. create `pre-rollback` snapshot;
2. pre-load every needed baseline blob and verify symlink/mode support before the first write;
3. create parent directories;
4. restore regular/binary blobs with `writeFile`, symlinks with `symlink`, and supported executable mode with `chmod`;
5. remove result-created files with `rm(path, { force: true })` only after validated path containment;
6. never write the real Git index;
7. create `rollback-result` hidden snapshot;
8. append `rollback_applied` with paths and snapshot;
9. on write failure append `rollback_failed` with the pre-rollback snapshot ID and return a recovery reason without reset/checkout.

- [ ] **Step 5: Run rollback tests**

Expected: all rollback tests pass on Windows; gate symlink creation assertions with a capability probe and assert an explicit unsupported conflict when Windows privileges do not permit symlinks.

---

### Task 5: Explicitly confirmed publisher and shell Git hardening

**Files:**
- Create: `cli/src/git-safety/publisher.ts`
- Create: `cli/tests/git-publisher.test.ts`
- Modify: `cli/src/safety/policy.ts`
- Modify: `cli/tests/approval.test.ts`

- [ ] **Step 1: Add publication and policy RED tests**

Tests:

```ts
test('publisher makes no remote change without a confirmation callback', async () => {});
test('publisher asks independently for every push', async () => {});
test('publisher pushes a normal branch after exact confirmation and audits it', async () => {});
test('publisher rejects force deletion wildcard and checkpoint refspecs before confirmation', async () => {});
test('publisher redacts credentials from confirmation and audit output', async () => {});
test('command policy rejects mutating git branch forms', () => {});
test('command policy rejects destructive git commands with executable suffixes and global options', () => {});
test('command policy never auto-allows git push', () => {});
```

Use a temporary bare local repository as the remote; never contact a network.

- [ ] **Step 2: Run and verify RED**

Expected: missing publisher and current `git branch` auto-allow policy failure.

- [ ] **Step 3: Implement structured local publication**

Implement:

```ts
export type GitPublishRequest = { remote: string; localRef: string; remoteBranch: string; sessionId: string };
export interface GitRemotePublisher {
  preview(request: GitPublishRequest): Promise<{ remote: string; localOid: string; destination: string }>;
  publish(request: GitPublishRequest, confirm?: (message: string) => Promise<boolean>): Promise<{ ok: boolean; reason: string }>;
}
```

The local implementation must:

- reject absent confirmation callbacks;
- validate remote names (not URLs supplied as command arguments), local refs, branch names, and no wildcard/colon/deletion syntax;
- reject local refs under `refs/aicode/checkpoints/`;
- resolve the exact local OID and remote URL, sanitize URL for display/audit;
- ask once per invocation with remote, source OID/ref, and destination;
- on acceptance run fixed arguments `git push <remote> <localOid>:refs/heads/<branch>` without `--force`;
- append requested/declined/succeeded/failed events;
- never retry or reuse confirmation.

- [ ] **Step 4: Harden generic shell classification**

Replace permissive Git regexes with explicit read-only forms:

```ts
/^git(?:\.exe)?\s+status(?:\s+--(?:short|branch|porcelain(?:=v1)?))*$/i
/^git(?:\.exe)?\s+diff(?:\s+--(?:cached|stat|name-only))*$/i
/^git(?:\.exe)?\s+log(?:\s+--(?:oneline|decorate|all)|\s+-n\s+\d+)*$/i
/^git(?:\.exe)?\s+branch\s+--(?:show-current|list)$/i
```

Add a token-aware destructive Git classifier that skips safe global options before the subcommand and blocks at least reset `--hard`, clean with force, checkout/restore force, branch deletion/create forms in auto mode, commit, push, fetch-to-forced-ref, rebase, merge, revert, and tag mutation. `ask` may still allow non-hard local Git mutations through generic shell confirmation except commands that the global destructive blocklist prohibits. Push remains outside agent automation and must use `/git publish`.

- [ ] **Step 5: Run publisher and approval tests**

Expected: all tests pass; remote refs change only in the explicitly accepted test.

---

### Task 6: Ordinary-turn and task-board lifecycle integration

**Files:**
- Modify: `cli/src/agent/agent.ts`
- Modify: `cli/src/tasks/runtime.ts`
- Modify: `cli/src/cli/repl.ts`
- Modify: `cli/tests/autonomy.test.ts`
- Modify: `cli/tests/task-board.test.ts`
- Modify: `cli/tests/project-memory.test.ts` if callback types require fixture updates

- [ ] **Step 1: Add ordinary-turn exact-once RED tests**

Add to `autonomy.test.ts`:

```ts
test('ordinary agent turn creates exactly one baseline and result snapshot', async () => {});
test('provider failure still finishes the ordinary Git safety unit', async () => {});
test('result snapshot failure preserves the original agent turn result', async () => {});
test('existing Git safety unit prevents a nested ordinary turn snapshot', async () => {});
```

Use a small recording service fake with `startUnit` and `finishUnit` call arrays. Assert `turn_start < start < provider < finish`, request kind `turn`, and exactly one finish.

- [ ] **Step 2: Add task-owner RED tests**

Add to `task-board.test.ts`:

```ts
test('task board task creates exactly one baseline and result snapshot', async () => {});
test('task board passes its Git safety unit into the inner agent turn without nesting', async () => {});
test('blocked and thrown task turns still finish the Git safety unit', async () => {});
test('reopened task creates a new Git safety unit id', async () => {});
```

At least one test must enter through `runPromptMode` with a real `runAgentTurn` callback and assert that the service sees one `task` start and zero `turn` starts.

- [ ] **Step 3: Refactor `runAgentTurn` into wrapper plus core**

Add to `AgentRuntime`:

```ts
gitSafety?: GitSafetyService;
gitRollback?: GitRollbackService;
gitPublisher?: GitRemotePublisher;
```

Extend result/options:

```ts
export type AgentTurnOptions = { gitSafetyUnit?: GitUnitContext };
export type AgentTurnResult = {
  ok: boolean;
  session: SessionRecord;
  reason?: string;
  finalAnswer?: string;
  hadTerminalFailure?: boolean;
  outcome?: GitUnitOutcome;
  gitSafety?: GitUnitResult;
};
```

Implementation rules:

- call `ui.turnStart` once;
- only the outer wrapper starts a `turn` unit when no existing context is supplied;
- resolve initialization confirmation from `runtime.confirm`, otherwise use `askForApproval` only when `!config.noInput && process.stdin.isTTY`;
- put all existing early returns inside `runAgentTurnCore`;
- core returns the final answer produced by this call, not `session.finalAnswers.at(-1)`;
- classify cancelled/blocked/failed terminal outcomes explicitly;
- in wrapper `finally`, finish only units it owns and attach result; finish warnings/errors do not replace the core result or exception.

- [ ] **Step 4: Make `runTaskBoardLoop` the task owner**

Change callback signature to:

```ts
runTurn: (prompt: string, gitSafetyUnit?: GitUnitContext) => Promise<TaskTurnResult>;
```

Add optional `gitSafety`, `confirm`, and `onInfo`. After persisting `in_progress`, start a `task` unit with session/board/task IDs. Invoke callback inside `try`, map completion to outcome, and finish in `finally`. If callback throws, mark the task blocked with the exception message, pause runtime, save board/session, and still finish with `failed`.

- [ ] **Step 5: Pass task context through REPL callback**

Replace the global-session inference in `continueTaskBoard` with:

```ts
runTurn: async (taskPrompt, gitSafetyUnit) => {
  const result = await runAgentTurn(runtime, taskPrompt, { gitSafetyUnit });
  return {
    ok: result.ok,
    reason: result.reason,
    finalAnswer: result.finalAnswer,
    hadTerminalFailure: result.hadTerminalFailure,
    outcome: result.outcome,
  };
},
gitSafety: runtime.gitSafety,
confirm: runtime.confirm,
```

Delete `beforeFailed`, `afterFailed`, and use of the session-wide last final answer.

- [ ] **Step 6: Run lifecycle integrations and regressions**

Run built `autonomy`, `task-board`, `project-memory`, `lazyDevGuard.integration`, and `checkpoint` tests. Expected: new exact-once tests and all existing tests pass.

---

### Task 7: Slash commands and production composition

**Files:**
- Modify: `cli/src/cli/commands.ts`
- Modify: `cli/src/index.ts`
- Modify: `cli/src/cli/repl.ts`
- Create or modify: `cli/tests/git-commands.test.ts`
- Modify: `cli/tests/cli-process.test.ts`

- [ ] **Step 1: Add command RED tests**

Tests:

```ts
test('/rollback supports list show preview and apply', async () => {});
test('/rollback apply reports all conflicts and changes no files', async () => {});
test('/git publish requires exact syntax and one-shot confirmation', async () => {});
test('/git publish cannot be invoked by an agent tool', async () => {});
test('CLI non-interactive prompt does not initialize a Git repository without confirmation', async () => {});
```

The agent test should assert `/git publish` is not in `tools.specs()` and no generic auto-approved push is possible.

- [ ] **Step 2: Implement command dispatch**

Extend `handleSlashCommand` options with optional `gitRollback`, `gitPublisher`, and `confirm`. Add help entries and dispatch:

```text
/rollback list
/rollback show <unit-id>
/rollback preview <unit-id>
/rollback apply <unit-id>
/git publish <remote> <local-ref> <remote-branch>
```

Use exact token counts, validated IDs, `format.ts`, and clear usage strings. `/rollback apply` is itself explicit authorization but still repeats preview immediately before writes. `/git publish` calls the publisher with only `options.confirm`; without a live callback it declines. Keep `/undo` unchanged.

- [ ] **Step 3: Compose production services**

In `index.ts`, after `CheckpointStore`, construct one `GitProcess` rooted at `workspaceRoot`, `GitAuditLog`, `GitRepository`, `GitSnapshotStore`, `GitSnapshotDiff`, `GitSafetyService`, `GitRollbackService`, and `LocalGitPublisher`. Put only the service facades on runtime.

Do not discover or initialize Git during startup. Discovery/confirmation occurs lazily at unit start, so `/help`, `--version`, `--doctor`, and slash queries never create `.git`.

- [ ] **Step 4: Verify prompt and REPL confirmation propagation**

`interactiveRuntime.confirm` must reach lifecycle initialization, rollback publication, and tool approval. Prompt mode with `--no-input` must have no confirmation callback and therefore degrade rather than initialize/push. Preserve JSON prompt event order with `turn_start` first.

- [ ] **Step 5: Run command/process tests**

Expected: all command tests pass; temporary non-Git workspace remains without `.git` in non-interactive tests.

---

### Task 8: Structural audit, documentation, and full verification

**Files:**
- Modify: `cli/src/audit/checks.ts`
- Modify: `cli/README.md`
- Modify: `cli/docs/capability-matrix.md`
- Modify: `cli/tests/smoke.test.ts` only if production lifecycle requires fixture isolation

- [ ] **Step 1: Add audit RED checks**

Add required files for every `src/git-safety/*.ts` file and the three new test files. Add source/test needles for:

```text
refs/aicode/checkpoints/
GIT_INDEX_FILE
GitSafetyService
GitRollbackService
GitRemotePublisher
/git publish
/rollback preview
task board passes its Git safety unit into the inner agent turn without nesting
post-result worktree edit conflicts and causes zero rollback writes
publisher asks independently for every push
```

Add negative checks proving the auto Git allowlist no longer contains `(status|diff|log|branch)` and no production snapshot/rollback module contains `reset --hard`, `checkout -f`, or `run_command`.

- [ ] **Step 2: Update README and capability matrix**

Document:

- baseline/result units for ordinary turns and tasks;
- hidden local refs and append-only `.aicode/git-safety/audit.jsonl`;
- dirty-worktree and index preservation;
- confirmed `git init`, degraded fallback, and existing `/undo` distinction;
- `/rollback list|show|preview|apply` examples;
- `/git publish` syntax, per-push confirmation, no force/deletion/automatic publication;
- limitations: no automatic pruning, no branch history rewrite, concurrent edits during the unit are attributed to the execution window, filesystem rollback is best-effort after preflight.

Change capability matrix from read-only Git-only wording to “implemented local safety MVP” while retaining the no OS sandbox limitation.

- [ ] **Step 3: Run typecheck and all Git-focused tests**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run typecheck
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test \
  "C:/Users/34516/ZCodeProject/cli/dist/tests/git-safety.test.js" \
  "C:/Users/34516/ZCodeProject/cli/dist/tests/git-rollback.test.js" \
  "C:/Users/34516/ZCodeProject/cli/dist/tests/git-publisher.test.js" \
  "C:/Users/34516/ZCodeProject/cli/dist/tests/git-commands.test.js" \
  "C:/Users/34516/ZCodeProject/cli/dist/tests/autonomy.test.js" \
  "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: zero failures.

- [ ] **Step 4: Run full verification**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" test
npm --prefix "C:/Users/34516/ZCodeProject/cli" run audit:100
npm --prefix "C:/Users/34516/ZCodeProject/cli" run smoke
```

Expected: all tests pass, audit reports all checks passed, smoke exits 0.

- [ ] **Step 5: Perform manual safety probes in temporary repositories only**

Use a newly created temp directory outside the source workspace to verify:

1. declined initialization does not create `.git`;
2. accepted initialization creates only local `.git` plus hidden snapshots after a turn;
3. snapshot leaves current branch/HEAD/index unchanged;
4. rollback conflict changes zero files;
5. accepted local bare-remote publication pushes once;
6. declined second push does not update the remote;
7. no credentials appear in audit or terminal output.

Delete only the temporary fixture created by this step. Do not initialize or mutate Git in `C:/Users/34516/ZCodeProject`.

---

## Completion Checklist

- [ ] Every ordinary turn has at most one baseline/result pair.
- [ ] Every task-board task has at most one baseline/result pair and no nested turn pair.
- [ ] Hidden snapshots preserve branch, `HEAD`, real index, staging, and worktree.
- [ ] Dirty tracked/untracked/deleted/renamed/binary/Unicode paths are captured.
- [ ] Rollback is path-selective and all-or-nothing on conflicts.
- [ ] Rollback never changes the real index or calls destructive Git reset/checkout.
- [ ] Audit is append-only, readable after corrupt lines, and secret-free.
- [ ] Non-Git initialization is always explicitly confirmed.
- [ ] Push is user-only, independently confirmed every time, non-force, and audited.
- [ ] Existing `/undo`, task board, memory, lazy-dev guard, sessions, and tools regressions pass.
- [ ] Typecheck, full tests, audit, and smoke all pass.
