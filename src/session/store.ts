import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentMessage, MessagePart, ProviderName, ResponsesContinuation } from '../providers/types.js';
import type { LazyDevGuardState } from '../guard/types.js';
import type { TaskRuntimeState } from '../tasks/types.js';

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
};

export class SessionStore {
  private writeQueue: Promise<void> = Promise.resolve();

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

  async create(options: { provider: ProviderName; model: string; workspaceRoot: string }) {
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
    await this.save(session);
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
    const payload = `${JSON.stringify(session, null, 2)}\n`;
    const run = this.writeQueue.then(() => this.saveSnapshot(session.id, payload));
    // A failed save must not poison the queue for future turns.
    this.writeQueue = run.catch(() => undefined);
    await run;
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
  return value as SessionRecord;
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
