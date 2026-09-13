import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentMessage, MessagePart, ProviderName, ResponsesContinuation } from '../providers/types.js';
import type { LazyDevGuardState } from '../guard/types.js';
import type { TaskRuntimeState } from '../tasks/types.js';

const SESSION_ID = /^sess_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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
  guard?: {
    lazyDev?: LazyDevGuardState;
  };
  taskRuntime?: TaskRuntimeState;
  /** Persistent session goal set via /goal */
  goal?: string;
  providerContinuation?: ResponsesContinuation;
  lastTurn?: LastTurnRecord;
};

export class SessionStore {
  constructor(private readonly sessionDir: string) {}

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

  async appendMessage(session: SessionRecord, message: Omit<AgentMessage, 'createdAt'>) {
    session.messages.push({ ...message, createdAt: new Date().toISOString() });
    await this.touch(session);
  }

  async appendToolCall(session: SessionRecord, call: Omit<ToolCallRecord, 'id' | 'createdAt'>) {
    const record: ToolCallRecord = {
      ...call,
      id: `tool_${session.toolCalls.length + 1}_${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
    };
    session.toolCalls.push(record);
    await this.appendMessage(session, {
      role: 'tool',
      name: call.tool,
      content: call.output,
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
    return parseSession(JSON.parse(await readFile(file, 'utf8')), safeId);
  }

  async save(session: SessionRecord) {
    const file = this.filePath(session.id);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
