import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentMessage, MessagePart, ProviderName, ResponsesContinuation } from '../providers/types.js';
import type { LazyDevGuardState } from '../guard/types.js';
import type { TaskRuntimeState } from '../tasks/types.js';
import { serializeWrites } from '../utils/atomic.js';
import { withFileLock, type LockOptions } from '../utils/lockfile.js';

const SESSION_ID = /^sess_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DEFAULT_RENAME_RETRIES = 8;
const DEFAULT_RENAME_RETRY_DELAY_MS = 25;
const MAX_RENAME_RETRY_DELAY_MS = 1000;

export type SessionStoreOptions = {
  /** Override the filesystem rename operation for fault-injection tests. */
  rename?: typeof rename;
  /** Override retry sleeping for deterministic fault-injection tests. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Number of retries after the first rename attempt. Defaults to Windows-only retries. */
  renameRetries?: number;
  /** Initial delay for transient rename retries. */
  renameRetryDelayMs?: number;
  /**
   * Cross-process lock parameters, shared with `ProjectMemoryStore`.
   *
   * One store instance is one process's view; the session directory is written
   * by the REPL, the desktop bridge and every spawned sub-agent CLI. The
   * per-instance queue below only serialises writes from the same object, so a
   * save has to take the same `open(…, 'wx')` lock the memory store uses.
   */
  lock?: LockOptions;
};

export type ToolCallRecord = {
  id: string;
  tool: string;
  input: unknown;
  ok: boolean;
  output: string;
  data?: unknown;
  providerCallId?: string;
  createdAt: string;
};

export type LastTurnRecord = {
  /** The exact user prompt submitted to the agent (text-only, provider-safe). */
  prompt: string;
  /** Original display text shown in the UI/log, if different from prompt. */
  displayText?: string;
  /** Multimodal parts (e.g. images) so /retry can replay them. */
  parts?: MessagePart[];
  /** Lifecycle status: running while executing, done/failed after completion. */
  status: 'running' | 'done' | 'failed';
  outcome?: 'done' | 'failed' | 'cancelled';
  /** ISO timestamp when this turn started. */
  startedAt: string;
};

export type SessionRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  provider: ProviderName;
  model: string;
  workspaceRoot: string;
  messages: AgentMessage[];
  toolCalls: ToolCallRecord[];
  finalAnswers: string[];
  /**
   * Title set by `/rename`. Lives on the record itself so every reader can find
   * it; the desktop keeps ITS title in a sidecar overlay that wins when both
   * exist. `/rename` used to write the title into `finalAnswers[0]`, which
   * destroyed the session's first answer and was read by nobody.
   */
  title?: string;
  /** Pinned by `/pin`. The desktop keeps its own pin in the same overlay. */
  pinned?: boolean;
  guard?: {
    lazyDev?: LazyDevGuardState;
  };
  /**
   * Tiered-dispatch selection for this session (/省钱分级). Persisted so a
   * resumed session keeps spending the same way, and so sub-agents can read
   * which provider each tier maps to. Model names, not credentials.
   */
  dispatch?: {
    expensive?: string | string[];
    standard?: string | string[];
    cheap?: string | string[];
  };
  taskRuntime?: TaskRuntimeState;
  /** Persistent session goal set via /goal */
  goal?: string;
  /** Set by /computer use: arms the desktop computer-control tools for this session. */
  computerUse?: boolean;
  providerContinuation?: ResponsesContinuation;
  lastTurn?: LastTurnRecord;
  /**
   * When set, every message older than this stamp was deliberately removed
   * (`/clear`, compaction). `save()` uses it to keep a writer that never saw
   * the removal from putting those messages back.
   */
  clearedAt?: string;
};

export class SessionStore {
  constructor(
    private readonly sessionDir: string,
    private readonly options: SessionStoreOptions = {},
  ) {}

  /**
   * A store writing beside this one, for records that are not the user's
   * conversations.
   *
   * Sub-agents create a session per segment, and the desktop lists every
   * record in the session directory as a conversation: the user's sidebar
   * filled up with untitled shells and `## 主任务背景` runs that were never
   * opened. Keeping them in a sibling directory leaves the chat list to the
   * chats, while the ids stay valid and loadable by `filePath`.
   */
  sibling(name: string) {
    return new SessionStore(join(dirname(this.sessionDir), name), this.options);
  }

  async create(options: {
    provider: ProviderName;
    model: string;
    workspaceRoot: string;
    /**
     * Write the record to disk right away. Defaults to true.
     *
     * A launched process creates a session before it knows whether the user
     * will say anything. With an eager write, every launch — every app start,
     * every spawned child, every harness run — leaves an empty conversation in
     * the sidebar that nobody ever opened. `createRuntime` passes false: the
     * record stays in memory and `appendMessage`/`touch` persist it with the
     * first real turn.
     */
    persist?: boolean;
  }) {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: `sess_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`,
      createdAt: now,
      updatedAt: now,
      provider: options.provider,
      model: options.model,
      workspaceRoot: options.workspaceRoot,
      messages: [],
      toolCalls: [],
      finalAnswers: [],
    };
    if (options.persist !== false) await this.save(session);
    return session;
  }

  /**
   * Copy a session into a new one that inherits its whole conversation.
   *
   * A fork that carries only the last message is not an inheritance — the new
   * session has no idea what was decided earlier. Copying the transcript keeps
   * the branch coherent.
   *
   * The source record is never written: everything is read from a fresh load,
   * so forking cannot mutate the conversation being forked.
   */
  async fork(id: string, options: { provider: ProviderName; model: string; workspaceRoot: string }) {
    const source = await this.load(id);
    const now = new Date().toISOString();
    const forked: SessionRecord = {
      ...structuredClone(source),
      id: `sess_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`,
      createdAt: now,
      updatedAt: now,
      provider: options.provider,
      model: options.model,
      workspaceRoot: options.workspaceRoot,
    };
    forked.messages = [
      ...structuredClone(source.messages),
      { role: 'user', content: forkMarker(source.id), createdAt: now },
    ];
    // A forked session is a new conversation: it must not resume the source's
    // provider-side response chain, replay its last turn, or inherit a task
    // board whose board id still belongs to the source session.
    delete forked.providerContinuation;
    delete forked.lastTurn;
    delete forked.taskRuntime;
    await this.save(forked);
    return forked;
  }

  async appendMessage(session: SessionRecord, message: Omit<AgentMessage, 'createdAt'>) {
    session.messages.push({ ...message, createdAt: new Date().toISOString() });
    await this.touch(session);
  }

  async appendToolCall(
    session: SessionRecord,
    call: Omit<ToolCallRecord, 'id' | 'createdAt'>,
    options?: { parts?: MessagePart[] },
  ) {
    const record: ToolCallRecord = {
      ...call,
      id: `tool_${session.toolCalls.length + 1}_${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
    };
    session.toolCalls.push(record);
    // Multimodal parts (e.g. a computer-control screenshot) ride on the tool
    // MESSAGE so providers can show them to the model, but never on the
    // persisted ToolCallRecord — base64 would bloat the session JSONL.
    // Keep at most one screenshot in history: older image parts downgrade to
    // text placeholders before the new one is appended.
    if (options?.parts?.some((part) => part.type === 'image')) {
      for (const message of session.messages) {
        if (!message.parts?.some((part) => part.type === 'image')) continue;
        message.parts = message.parts.map((part) =>
          part.type === 'image'
            ? { type: 'text', text: `[screenshot omitted: ${part.path ?? part.mediaType}]` }
            : part,
        );
      }
    }
    await this.appendMessage(session, {
      role: 'tool',
      name: call.tool,
      content: call.output,
      ...(options?.parts?.length ? { parts: options.parts } : {}),
    });
    return record;
  }

  async appendFinalAnswer(session: SessionRecord, answer: string) {
    session.finalAnswers.push(answer);
    await this.appendMessage(session, { role: 'assistant', content: answer });
  }

  async list() {
    await mkdir(this.sessionDir, { recursive: true });
    const names = await readdir(this.sessionDir);
    const sessions: SessionRecord[] = [];
    for (const name of names.filter((item) => item.endsWith('.json'))) {
      const id = name.slice(0, -'.json'.length);
      if (!isSafeSessionId(id)) continue;
      const file = join(this.sessionDir, name);
      try {
        sessions.push(parseSession(JSON.parse(await readFile(file, 'utf8')), id));
      } catch {
        // Ignore corrupt session files so one bad file does not break the CLI.
      }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async load(id: string) {
    const safeId = assertSafeSessionId(id);
    const file = this.filePath(safeId);
    const raw = await readFile(file, 'utf8');
    try {
      return parseSession(JSON.parse(raw), safeId);
    } catch (error) {
      // A session file we cannot parse is the ONLY copy of that conversation, and
      // `save()` writes this same path. Left in place, the next turn on this id
      // would replace it with a fresh record. Move it aside once — the new name no
      // longer ends in `.json`, so nothing lists it or saves over it — and say
      // where it went instead of surfacing a bare JSON SyntaxError.
      const backup = `${file}.corrupt-${Date.now()}.json`;
      const preserved = await this.renameWithRetry(file, backup).then(() => true, () => false);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Session ${safeId} is unreadable (${message}). `
        + (preserved
          ? `The file was preserved as ${backup}.`
          : 'The file could not be moved aside and was left untouched.'),
      );
    }
  }

  async save(session: SessionRecord) {
    // Freeze the payload before waiting behind an earlier save. Callers mutate
    // the live session immediately before save(), so serializing later would
    // let a newer mutation change the older queued write.
    //
    // Two layers, because they cover different writers:
    //   - `serializeWrites` (module-level, keyed by path) orders every store
    //     instance in this process — the runtime, a sub-agent store, tests;
    //   - the file lock covers other processes (desktop bridge, spawned CLI).
    // The merge happens INSIDE both, so it reads what the last writer actually
    // left on disk. A read outside the lock could merge against a snapshot a
    // concurrent process is about to replace.
    const run = serializeWrites(this.filePath(session.id), () =>
      this.withWriteLock(session.id, () => this.saveMerged(session)),
    );
    await run;
  }

  private withWriteLock<Result>(id: string, task: () => Promise<Result>): Promise<Result> {
    return withFileLock(`${this.filePath(id)}.lock`, task, this.options.lock ?? {});
  }

  private async saveMerged(session: SessionRecord) {
    /*
     * Always merge against what is on disk. A stat-based fast path was written
     * and then removed: the write itself is ~19.5 ms of a 200 KB save while the
     * read + parse + merge is ~3 ms, so the saving was ~15%, and `mtimeMs` is
     * not a reliable "nobody else wrote" witness — two same-size renames inside
     * one filesystem tick report the same value (measured: 2 of 6 consecutive
     * writes). Correctness is worth more than 15%.
     */
    // Freeze the lengths before the first await. The caller keeps appending to
    // this same object while a save is queued behind another (see the
    // concurrent-saves test): adopting the merged lists over a record that
    // grew in the meantime would roll that newer turn back off it.
    const sizesBefore = recordSizes(session);
    const record = await this.mergedWithDisk(session);
    const payload = `${JSON.stringify(record, null, 2)}
`;
    await this.saveSnapshot(session.id, payload);
    /*
     * After a merge the file holds more than the caller's record does, and the
     * caller keeps appending to that very object. Adopt the merged lists back
     * into it, so the NEXT save starts from the union instead of paying for the
     * same read forever.
     *
     * Only when the record did NOT grow during this save: the merged lists are
     * a snapshot taken at read time, so adopting them over a message appended
     * since would silently discard it.
     */
    if (record !== session && sameSizes(sizesBefore, recordSizes(session))) {
      session.messages = record.messages;
      session.toolCalls = record.toolCalls;
      session.finalAnswers = record.finalAnswers;
      session.lastTurn = record.lastTurn;
      session.providerContinuation = record.providerContinuation;
      if (record.clearedAt !== undefined) session.clearedAt = record.clearedAt;
    }
  }

  private async mergedWithDisk(session: SessionRecord): Promise<SessionRecord> {
    const existing = await this.readExisting(session.id);
    return existing ? mergeForSave(existing, session) : session;
  }

  /**
   * Read the current on-disk record for a merge, or `undefined` when there is
   * none. A file we cannot parse is NOT an empty record: `load()` moves such a
   * file aside once so the user's conversation survives; doing that from here
   * would quarantine and then overwrite it. The caller's record simply wins.
   */
  private async readExisting(id: string): Promise<SessionRecord | undefined> {
    try {
      return parseSession(JSON.parse(await readFile(this.filePath(id), 'utf8')), id);
    } catch {
      return undefined;
    }
  }

  private async saveSnapshot(id: string, payload: string) {
    const file = this.filePath(id);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, payload, { encoding: 'utf8', flag: 'wx' });
      await this.renameWithRetry(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async renameWithRetry(temporary: string, file: string) {
    const renameOperation = this.options.rename ?? rename;
    const sleep = this.options.sleep ?? sleepFor;
    const retries = normalizeNonNegativeInteger(
      this.options.renameRetries ?? (process.platform === 'win32' ? DEFAULT_RENAME_RETRIES : 0),
    );
    const initialDelay = normalizeNonNegativeInteger(
      this.options.renameRetryDelayMs ?? DEFAULT_RENAME_RETRY_DELAY_MS,
    );

    for (let attempt = 0; ; attempt += 1) {
      try {
        await renameOperation(temporary, file);
        return;
      } catch (error) {
        if (attempt >= retries || !isTransientRenameError(error)) throw error;
        const delay = Math.min(MAX_RENAME_RETRY_DELAY_MS, initialDelay * (2 ** attempt));
        await sleep(delay);
      }
    }
  }

  /** Set/refresh the persisted replay payload for the current turn. */
  async setLastTurn(session: SessionRecord, turn: LastTurnRecord) {
    session.lastTurn = turn;
    await this.touch(session);
  }

  /** Clear any persisted turn payload (used before replaying). */
  async clearLastTurn(session: SessionRecord) {
    if (session.lastTurn) {
      delete session.lastTurn;
      await this.touch(session);
    }
  }

  filePath(id: string) {
    return resolve(this.sessionDir, `${assertSafeSessionId(id)}.json`);
  }

  private async touch(session: SessionRecord) {
    session.updatedAt = new Date().toISOString();
    await this.save(session);
  }
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isTransientRenameError(error: unknown): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function sleepFor(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function isSafeSessionId(id: string) {
  return SESSION_ID.test(id);
}

function assertSafeSessionId(id: string) {
  if (!isSafeSessionId(id)) throw new Error(`Invalid session ID: ${id}`);
  return id;
}

function parseSession(value: unknown, expectedId: string): SessionRecord {
  if (!isRecord(value) || value.id !== expectedId) throw new Error(`Invalid session record: ${expectedId}`);
  // Container shape only. Field-level repair would mean inventing ids and
  // timestamps a reader then reports as real; the merge in `save()` and the
  // readers' own guards handle a partially hand-edited record. What must never
  // reach them is a non-list where every call site does `.length`/`.slice`:
  // `recent_activity` and the audit ledger read session files raw.
  for (const key of ['messages', 'toolCalls', 'finalAnswers'] as const) {
    const field = value[key];
    if (field === undefined) continue;
    if (!Array.isArray(field)) throw new Error(`Invalid session record ${expectedId}: ${key} is not a list`);
  }
  return value as SessionRecord;
}

/**
 * Fold a record onto what is already on disk instead of replacing it.
 *
 * Every append in this file reads a live in-memory record and rewrites the
 * whole file. Two writers exist in practice — the desktop bridge and a spawned
 * sub-agent CLI, or the REPL and an automation run — and each has its own
 * `SessionStore`. Without this, the later save silently drops the other's
 * messages: nothing throws, the turns just stop existing.
 *
 * The merge is commutative for everything a turn appends (messages, tool
 * calls, answers), which is what makes "last writer wins" safe here.
 *
 * What it deliberately does NOT resurrect:
 *   - a cleared transcript: an incoming `messages`/`finalAnswers` that is a
 *     strict prefix of the disk copy is `/clear`'s intent, not a lost update;
 *   - a cleared continuation: only the incoming side can clear it per turn.
 * `lastTurn` is the exception that cannot be inferred: it is a single slot
 * with no ordering that survives the turn, so the newer `startedAt` wins and
 * an older writer cannot bring back a turn `/clear` removed.
 */
function mergeForSave(existing: SessionRecord, incoming: SessionRecord): SessionRecord {
  const incomingMessages = Array.isArray(incoming.messages) ? incoming.messages : [];
  const existingMessages = Array.isArray(existing.messages) ? existing.messages : [];
  const incomingAnswers = Array.isArray(incoming.finalAnswers) ? incoming.finalAnswers : [];
  const existingAnswers = Array.isArray(existing.finalAnswers) ? existing.finalAnswers : [];

  // A clear or a compaction is the only rewrite that shrinks the transcript.
  // `clearedAt` on disk means every message older than it is gone; a writer
  // that never saw the clear still holds them, and putting them back is the
  // lost-update bug in reverse. Messages it appended AFTER the clear are kept.
  const clearedAt = typeof existing.clearedAt === 'string' ? existing.clearedAt : undefined;
  const keptMessages = clearedAt
    ? incomingMessages.filter((message) => typeof message.createdAt === 'string' && message.createdAt > clearedAt)
    : incomingMessages;

  // `/clear` empties the transcript outright (commands.ts). Edits that merely
  // rewrite a shorter list are not treated as a clear: concurrent writers with
  // different prefixes look exactly like that and would lose each other's turns.
  const incomingEmptied = incomingMessages.length === 0 && incomingAnswers.length === 0 && existingMessages.length > 0;
  // Compaction keeps a summary stub plus a short tail of real messages.
  /*
   * Compaction = summary stub + a SUBSET of the old messages, in order. The
   * subset is not contiguous: `autoCompact` keeps the summary plus the most
   * recent N USER messages, which are scattered through the history (assistant
   * and tool turns sit between them). Requiring a contiguous suffix (what this
   * first did) missed every real compaction, and the merge then put the whole
   * pre-compaction transcript back — the exact opposite of compacting.
   */
  const compacted = keptMessages.length < existingMessages.length
    && isCompactionStub(keptMessages[0])
    && isSubsequenceThenAppends(existingMessages, keptMessages.slice(1));
  // A rewritten transcript (clear, compaction, or anything appended after one
  // that the disk copy does not have yet) is written as-is.
  const droppedPreClear = Boolean(clearedAt) && keptMessages.length !== incomingMessages.length;
  const rewritten = incomingEmptied || compacted || droppedPreClear;
  // A stale copy also still holds answers and tool calls from before the clear.
  // The disk copy is the authority for those: once it was emptied, only what
  // the stale copy added after `clearedAt` may come back.
  const clearedAnswers = droppedPreClear && existingAnswers.length === 0;
  const clearedCalls = droppedPreClear && (!Array.isArray(existing.toolCalls) || existing.toolCalls.length === 0);
  /*
   * A summary stub can only be the FIRST message: compaction builds the array
   * that way. If the disk history has no stub and the incoming list carries one
   * anywhere but the head, it is residue from a stale copy (a writer that
   * compacted before the disk was compacted) — taking the union would splice a
   * summary into the middle of a conversation.
   */
  const strayStub = !rewritten && keptMessages.some((message, index) => index > 0 && isCompactionStub(message));
  /*
   * The disk copy is already compacted and the writer saving now is not: it is
   * a stale view from before the compaction. Its messages must not come back —
   * that is the whole point of compacting — so the disk history wins.
   */
  const stalePreCompaction = isCompactionStub(existingMessages[0])
    && !isCompactionStub(keptMessages[0])
    && keptMessages.length > 0;

  const merged: SessionRecord = {
    ...structuredClone(incoming),
    messages: rewritten || strayStub || stalePreCompaction
      ? (stalePreCompaction ? existingMessages : keptMessages)
      // A saved history that still starts with the summary stub carries the
      // compaction decision itself. The merge cannot re-derive it — dropping
      // messages leaves no trace on disk — so trusting the stub is what keeps a
      // COMPACTED case (`stub + kept + new turn`) from being merged back into
      // the pre-compaction transcript. A stale copy starts with an ordinary
      // message and is unaffected.
      : isCompactionStub(keptMessages[0])
        ? keptMessages
        : mergeMessages(existingMessages, keptMessages),
    toolCalls: rewritten || clearedCalls ? incoming.toolCalls : stalePreCompaction ? existing.toolCalls : mergeToolCalls(
      Array.isArray(existing.toolCalls) ? existing.toolCalls : [],
      Array.isArray(incoming.toolCalls) ? incoming.toolCalls : [],
    ),
    finalAnswers: rewritten || clearedAnswers ? incomingAnswers : stalePreCompaction ? existingAnswers : mergeFinalAnswers(existingAnswers, incomingAnswers),
    createdAt: earliestStamp(existing.createdAt, incoming.createdAt),
    updatedAt: latestStamp(existing.updatedAt, incoming.updatedAt),
  };
  // A transcript wipe also drops the replay payload; otherwise keep the newer turn.
  merged.lastTurn = rewritten
    ? incoming.lastTurn
    : newerLastTurn(existing.lastTurn, incoming.lastTurn);
  // Continuation is the one field that can be CLEARED deliberately (cancels,
  // compaction, `/retry`). Presence of the key means the writer has an opinion:
  // a live record that was assigned `undefined` clears it, one loaded from an
  // older file simply does not carry it and leaves the disk copy alone.
  merged.providerContinuation = 'providerContinuation' in incoming
    ? incoming.providerContinuation
    : existing.providerContinuation;
  // Stamp the boundary for everyone who saves after this rewrite, so their
  // stale copies cannot put the removed messages back. The boundary is NOW,
  // not the record's `updatedAt`: `/clear` does not touch the record, so its
  // `updatedAt` still names the last turn, and anything appended between that
  // turn and the clear would be dropped from a stale writer that is actually
  // newer than the boundary.
  if (incomingEmptied) {
    // Only an outright empty rewrite gets a time boundary. A compaction keeps
    // OLD messages by design, so the same filter would drop every one of them
    // on the next save; compaction is protected by the summary stub instead
    // (see `stalePreCompaction` below).
    merged.clearedAt = latestStamp(existing.clearedAt ?? '', new Date().toISOString());
  } else if (clearedAt) {
    merged.clearedAt = clearedAt;
  }
  return merged;
}

const COMPACTION_MARKERS = ['[compacted session history]', '[Compacted —'];

function isCompactionStub(message: AgentMessage | undefined): boolean {
  return typeof message?.content === 'string' && COMPACTION_MARKERS.some((marker) => message.content.startsWith(marker));
}

/**
 * True when `candidate` reads as "an ordered subset of `long`, then zero or more
 * messages `long` has never seen".
 *
 * The trailing run is not a loophole: compaction replaces the history and the
 * caller saves again on the next append, so the array being saved is normally
 * `[summary stub, ...kept, ...new turn]`. Judging only the first element of the
 * tail (or requiring the whole tail to be old) made every real compaction look
 * like an ordinary append, and the merge put the pre-compaction transcript back.
 * A message `long` has never seen can only be new, and new messages are
 * appended after old ones — so old-then-new is the only order that means
 * "compacted, then continued".
 */
function isSubsequenceThenAppends(long: AgentMessage[], candidate: AgentMessage[]): boolean {
  const known = new Set(long.map(messageKey));
  let cursor = 0;
  let seenNew = false;
  for (const message of candidate) {
    if (!known.has(messageKey(message))) {
      seenNew = true;
      continue;
    }
    if (seenNew) return false;
    while (cursor < long.length && !sameMessage(long[cursor], message)) cursor += 1;
    if (cursor >= long.length) return false;
    cursor += 1;
  }
  return true;
}

function sameMessage(left: AgentMessage | undefined, right: AgentMessage | undefined): boolean {
  return Boolean(left && right) && messageKey(left!) === messageKey(right!);
}

function messageKey(message: AgentMessage): string {
  return `${message.createdAt}\u0000${message.role}\u0000${message.name ?? ''}\u0000${message.content}`;
}

function isMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value)) return false;
  return typeof value.role === 'string'
    && typeof value.content === 'string'
    && typeof value.createdAt === 'string';
}

/**
 * Union of both histories, ordered by append time.
 *
 * Messages carry no id of their own; `createdAt` is stamped when the store
 * appends them, so (createdAt, role, name, content) is unique in practice for
 * anything that came through `appendMessage`. Hand-made fixtures lack
 * `createdAt`; they are dropped rather than written into a record every reader
 * assumes is well-formed.
 */
function mergeMessages(existing: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  /*
   * `incoming` is the newer view of anything both sides carry: it is the record
   * being saved right now. On a key collision the later list therefore wins,
   * not the first one seen. This matters for `parts`: `stripHistoricalImages`
   * rewrites an already-saved tool message to text-only IN MEMORY (base64 must
   * not accumulate), and the disk copy still holds the image. Keeping the disk
   * copy would put the image back and strip it again on every save.
   */
  const merged = new Map<string, AgentMessage>();
  for (const message of [...existing, ...incoming]) {
    if (!isMessage(message)) continue;
    merged.set(messageKey(message), message);
  }
  const out = [...merged.entries()].map(([key, message]) => ({ key, message, order: 0 }));
  /*
   * Concatenating the two lists is not the union in time order. A writer whose
   * copy predates the other's last save appends its message to the END of its
   * own list, so the union is [disk…, stale-newer-than-nothing] even when that
   * message happened in the middle of the disk transcript. `Array.sort` is
   * stable and `order` tracks the pre-sort sequence for equal timestamps, so
   * this cannot shuffle what was already correct.
   */
  out.forEach((entry, index) => { entry.order = index; });
  out.sort((left, right) => {
    const byTime = left.message.createdAt.localeCompare(right.message.createdAt);
    return byTime !== 0 ? byTime : left.order - right.order;
  });
  return out.map((entry) => entry.message);
}

/** Lengths of the lists a save may adopt back; see `saveMerged`. */
function recordSizes(session: SessionRecord) {
  return {
    messages: Array.isArray(session.messages) ? session.messages.length : 0,
    toolCalls: Array.isArray(session.toolCalls) ? session.toolCalls.length : 0,
    finalAnswers: Array.isArray(session.finalAnswers) ? session.finalAnswers.length : 0,
  };
}

function sameSizes(
  left: ReturnType<typeof recordSizes>,
  right: ReturnType<typeof recordSizes>,
) {
  return left.messages === right.messages
    && left.toolCalls === right.toolCalls
    && left.finalAnswers === right.finalAnswers;
}

function mergeToolCalls(existing: ToolCallRecord[], incoming: ToolCallRecord[]): ToolCallRecord[] {
  const byId = new Map<string, ToolCallRecord>();
  for (const call of [...existing, ...incoming]) {
    if (!isRecord(call) || typeof call.id !== 'string' || !call.id) continue;
    byId.set(call.id, call);
  }
  return [...byId.values()].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
}

function mergeFinalAnswers(existing: string[], incoming: string[]): string[] {
  // A shorter list whose head matches is a `/clear` still in flight: the disk
  // copy is the one the user can still see.
  if (isStrictPrefix(incoming, existing)) return existing;
  // Every writer that appends an answer also appends its message, so the
  // incoming list is normally the append-only superset. Any other divergence
  // is a rewrite (compaction), and the newer record is the authority.
  return incoming;
}

function isStrictPrefix(short: unknown[], long: unknown[]): boolean {
  return short.length < long.length && commonPrefixLength(short, long) === short.length;
}

function commonPrefixLength(left: unknown[], right: unknown[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function newerLastTurn(existing: LastTurnRecord | undefined, incoming: LastTurnRecord | undefined) {
  if (!incoming) return existing;
  if (!existing) return incoming;
  return (incoming.startedAt ?? '') >= (existing.startedAt ?? '') ? incoming : existing;
}

function earliestStamp(left: string, right: string): string {
  if (typeof left !== 'string') return right;
  if (typeof right !== 'string') return left;
  return left <= right ? left : right;
}

function latestStamp(left: string, right: string): string {
  if (typeof left !== 'string') return right;
  if (typeof right !== 'string') return left;
  return left >= right ? left : right;
}

/**
 * A trailing user message so the model knows the transcript above is inherited
 * context, not something it just said. Without it the fork opens on an
 * assistant turn and the next prompt reads as a non-sequitur.
 */
export function forkMarker(sourceId: string) {
  return `[forked from ${sourceId}] 以上是继承自原会话的历史记录，请在此基础上继续。`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
