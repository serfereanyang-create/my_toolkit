import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentMessage, ProviderName, ResponsesContinuation } from '../providers/types.js';
import type { LazyDevGuardState } from '../guard/types.js';
import type { TaskRuntimeState } from '../tasks/types.js';

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
      const file = join(this.sessionDir, name);
      try {
        sessions.push(JSON.parse(await readFile(file, 'utf8')) as SessionRecord);
      } catch {
        // Ignore corrupt session files so one bad file does not break the CLI.
      }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async load(id: string) {
    const file = this.filePath(id);
    return JSON.parse(await readFile(file, 'utf8')) as SessionRecord;
  }

  async save(session: SessionRecord) {
    await mkdir(dirname(this.filePath(session.id)), { recursive: true });
    await writeFile(this.filePath(session.id), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  }

  filePath(id: string) {
    return resolve(this.sessionDir, `${id}.json`);
  }

  private async touch(session: SessionRecord) {
    session.updatedAt = new Date().toISOString();
    await this.save(session);
  }
}
