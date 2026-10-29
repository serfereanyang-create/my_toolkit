import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sanitizeError, sanitizeRemote } from './git.js';
import type {
  GitAuditEvent,
  GitAuditEventType,
  GitIndexEntry,
  GitMode,
  GitPathChange,
  GitPathState,
  GitRepositoryInfo,
  GitSnapshot,
} from './types.js';

const MAX_AUDIT_LINE_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_LENGTH = 16 * 1024;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_MIN_DELAY_MS = 10;
const LOCK_MAX_DELAY_MS = 100;
const processQueues = new Map<string, Promise<void>>();

const EVENT_TYPES = new Set<GitAuditEventType>([
  'repository_init_requested',
  'repository_initialized',
  'repository_init_declined',
  'unit_started',
  'snapshot_created',
  'snapshot_failed',
  'unit_finished',
  'rollback_previewed',
  'rollback_conflicted',
  'rollback_applied',
  'rollback_failed',
  'push_requested',
  'push_declined',
  'push_succeeded',
  'push_failed',
]);
const UNIT_KINDS = new Set(['turn', 'task'] as const);
const OUTCOMES = new Set(['done', 'blocked', 'failed', 'cancelled'] as const);
const PROTECTION_MODES = new Set(['git', 'file-checkpoint-only'] as const);
const SNAPSHOT_PHASES = new Set(['baseline', 'result', 'pre-rollback', 'rollback-result'] as const);
const CHANGE_KINDS = new Set(['add', 'modify', 'delete', 'rename', 'type-change', 'mode-change'] as const);
const GIT_MODES = new Set<GitMode>(['100644', '100755', '120000']);
const ERROR_SECRET_MARKER = /\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,})\b/gi;
const EVENT_FIELDS = new Set([
  'version', 'id', 'type', 'timestamp', 'workspaceRoot', 'sessionId', 'unitId', 'unitKind', 'turnId',
  'boardId', 'taskId', 'outcome', 'protectionMode', 'baseline', 'result', 'snapshot', 'changes',
  'conflicts', 'remote', 'localRef', 'remoteBranch', 'error', 'errorTruncated',
]);
const SNAPSHOT_FIELDS = new Set(['id', 'unitId', 'phase', 'ref', 'commit', 'tree', 'createdAt', 'repository']);
const REPOSITORY_FIELDS = new Set(['root', 'workspaceRoot', 'workspacePathspec', 'head', 'branch']);
const CHANGE_FIELDS = new Set(['kind', 'path', 'sourcePath', 'baseline', 'result', 'resultIndex', 'resultOids']);
const PATH_STATE_FIELDS = new Set(['path', 'oid', 'mode']);
const INDEX_ENTRY_FIELDS = new Set(['path', 'mode', 'oid', 'stage']);

type SafeRecord = Record<string, unknown>;

export class GitAuditLog {
  readonly filePath: string;
  private readonly queueKey: string;

  constructor(workspaceRoot: string) {
    this.filePath = resolve(workspaceRoot, '.aicode', 'git-safety', 'audit.jsonl');
    this.queueKey = canonicalPath(this.filePath);
  }

  append(event: GitAuditEvent): Promise<void> {
    let trusted: GitAuditEvent;
    try {
      trusted = reconstructAuditEvent(event);
    } catch (error) {
      return Promise.reject(new Error('Invalid audit event.', { cause: error }));
    }

    const line = Buffer.from(`${JSON.stringify(trusted)}\n`, 'utf8');
    if (line.byteLength > MAX_AUDIT_LINE_BYTES) {
      return Promise.reject(new Error('Invalid audit event: encoded line exceeds the size limit.'));
    }

    const previous = processQueues.get(this.queueKey) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => this.appendLocked(line));
    processQueues.set(this.queueKey, pending);
    return pending.finally(() => {
      if (processQueues.get(this.queueKey) === pending) processQueues.delete(this.queueKey);
    });
  }

  async read(): Promise<{ events: GitAuditEvent[]; warnings: string[] }> {
    const events: GitAuditEvent[] = [];
    const warnings: string[] = [];
    let stream: ReturnType<typeof createReadStream>;
    try {
      await stat(this.filePath);
      stream = createReadStream(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events, warnings };
      throw error;
    }

    let lineNumber = 0;
    let lineLength = 0;
    let oversized = false;
    let pieces: Buffer[] = [];

    const consumeLine = (): void => {
      lineNumber += 1;
      if (oversized) {
        warnings.push(`Corrupt audit line ${lineNumber}; skipped.`);
      } else {
        let line = pieces.length === 0 ? Buffer.alloc(0) : Buffer.concat(pieces, lineLength);
        if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
        if (line.toString('utf8').trim()) {
          try {
            events.push(reconstructAuditEvent(JSON.parse(line.toString('utf8'))));
          } catch {
            warnings.push(`Corrupt audit line ${lineNumber}; skipped.`);
          }
        }
      }
      lineLength = 0;
      oversized = false;
      pieces = [];
    };

    try {
      for await (const chunkValue of stream) {
        const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(0x0a, start);
          const end = newline === -1 ? chunk.length : newline;
          const pieceLength = end - start;
          if (!oversized && lineLength + pieceLength <= MAX_AUDIT_LINE_BYTES) {
            if (pieceLength > 0) pieces.push(chunk.subarray(start, end));
            lineLength += pieceLength;
          } else if (pieceLength > 0) {
            oversized = true;
            pieces = [];
            lineLength = 0;
          }
          if (newline === -1) break;
          consumeLine();
          start = newline + 1;
        }
      }
      if (oversized || lineLength > 0) consumeLine();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events, warnings };
      throw error;
    }

    return { events, warnings };
  }

  private async appendLocked(line: Buffer): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const release = await acquireFileLock(`${this.filePath}.lock`);
    try {
      const handle = await open(this.filePath, 'a+');
      try {
        const file = await handle.stat();
        if (file.size > 0) {
          const lastByte = Buffer.allocUnsafe(1);
          const { bytesRead } = await handle.read(lastByte, 0, 1, file.size - 1);
          if (bytesRead === 1 && lastByte[0] !== 0x0a) await writeAll(handle, Buffer.from('\n'));
        }
        await writeAll(handle, line);
      } finally {
        await handle.close();
      }
    } finally {
      await release();
    }
  }
}

function canonicalPath(filePath: string): string {
  const canonical = resolve(filePath);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  let delay = LOCK_MIN_DELAY_MS;
  while (true) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      return async () => {
        try {
          await handle?.close();
        } finally {
          await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      const failure = error as NodeJS.ErrnoException;
      if (failure.code !== 'EEXIST') throw error;
      await recoverStaleLock(lockPath);
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring audit lock after ${LOCK_TIMEOUT_MS}ms.`);
      }
      await sleep(delay);
      delay = Math.min(LOCK_MAX_DELAY_MS, delay * 2);
    }
  }
}

async function recoverStaleLock(lockPath: string): Promise<void> {
  try {
    const lock = await stat(lockPath);
    if (Date.now() - lock.mtimeMs <= LOCK_STALE_MS) return;
    const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
    await rename(lockPath, stalePath);
    await unlink(stalePath).catch(() => undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) throw new Error('Audit write made no progress.');
    offset += bytesWritten;
  }
}

function reconstructAuditEvent(value: unknown): GitAuditEvent {
  const source = safeRecord(value, EVENT_FIELDS, 'audit event');
  if (source.version !== 1) throw new Error('unsupported version');
  const type = enumValue(source.type, EVENT_TYPES, 'event type');
  const result: GitAuditEvent = {
    version: 1,
    id: clean(stringValue(source.id, 'id')),
    type,
    timestamp: clean(stringValue(source.timestamp, 'timestamp')),
    workspaceRoot: clean(stringValue(source.workspaceRoot, 'workspaceRoot', 32_768)),
  };

  result.sessionId = optionalCleanString(source, 'sessionId');
  result.unitId = optionalCleanString(source, 'unitId');
  result.turnId = optionalCleanString(source, 'turnId');
  result.boardId = optionalCleanString(source, 'boardId');
  result.taskId = optionalCleanString(source, 'taskId');
  result.unitKind = optionalEnum(source, 'unitKind', UNIT_KINDS);
  result.outcome = optionalEnum(source, 'outcome', OUTCOMES);
  result.protectionMode = optionalEnum(source, 'protectionMode', PROTECTION_MODES);
  if (source.baseline !== undefined) result.baseline = reconstructSnapshot(source.baseline, false);
  if (source.result !== undefined) result.result = reconstructSnapshot(source.result, false);
  if (source.snapshot !== undefined) result.snapshot = reconstructSnapshot(source.snapshot, true);
  if (source.changes !== undefined) result.changes = arrayValues(source.changes, 'changes', 20_000).map(reconstructChange);
  if (source.conflicts !== undefined) {
    result.conflicts = arrayValues(source.conflicts, 'conflicts', 100_000).map((item) => clean(stringValue(item, 'conflict', 4_096)));
  }
  if (source.remote !== undefined) result.remote = clean(sanitizeRemote(stringValue(source.remote, 'remote', 32_768)));
  if (source.localRef !== undefined) result.localRef = clean(assertRef(stringValue(source.localRef, 'localRef')));
  if (source.remoteBranch !== undefined) result.remoteBranch = clean(stringValue(source.remoteBranch, 'remoteBranch', 4_096));
  if (source.error !== undefined) {
    const sanitizedError = sanitizeError(stringValue(source.error, 'error', MAX_AUDIT_LINE_BYTES)).replace(ERROR_SECRET_MARKER, '[REDACTED]');
    result.error = sanitizedError.slice(0, MAX_ERROR_LENGTH);
    if (sanitizedError.length > MAX_ERROR_LENGTH) result.errorTruncated = true;
  }
  if (source.errorTruncated !== undefined) {
    if (typeof source.errorTruncated !== 'boolean') throw new Error('invalid errorTruncated');
    if (source.errorTruncated) result.errorTruncated = true;
  }

  removeUndefinedProperties(result as unknown as SafeRecord);
  return result;
}

function reconstructSnapshot(value: unknown, partial: false): GitSnapshot;
function reconstructSnapshot(value: unknown, partial: true): Partial<GitSnapshot>;
function reconstructSnapshot(value: unknown, partial: boolean): GitSnapshot | Partial<GitSnapshot> {
  const source = safeRecord(value, SNAPSHOT_FIELDS, 'snapshot');
  const result: Partial<GitSnapshot> = {};
  if (!partial || source.id !== undefined) result.id = clean(stringValue(source.id, 'snapshot.id'));
  if (!partial || source.unitId !== undefined) result.unitId = clean(stringValue(source.unitId, 'snapshot.unitId'));
  if (!partial || source.phase !== undefined) result.phase = enumValue(source.phase, SNAPSHOT_PHASES, 'snapshot.phase');
  if (!partial || source.ref !== undefined) result.ref = clean(assertRef(stringValue(source.ref, 'snapshot.ref')));
  if (!partial || source.commit !== undefined) result.commit = assertObjectId(stringValue(source.commit, 'snapshot.commit'));
  if (!partial || source.tree !== undefined) result.tree = assertObjectId(stringValue(source.tree, 'snapshot.tree'));
  if (!partial || source.createdAt !== undefined) result.createdAt = clean(stringValue(source.createdAt, 'snapshot.createdAt'));
  if (!partial || source.repository !== undefined) result.repository = reconstructRepository(source.repository);
  return result;
}

function reconstructRepository(value: unknown): GitRepositoryInfo {
  const source = safeRecord(value, REPOSITORY_FIELDS, 'repository');
  const result: GitRepositoryInfo = {
    root: clean(stringValue(source.root, 'repository.root', 32_768)),
    workspaceRoot: clean(stringValue(source.workspaceRoot, 'repository.workspaceRoot', 32_768)),
    workspacePathspec: clean(assertWorkspacePathspec(stringValue(source.workspacePathspec, 'repository.workspacePathspec', 4_096))),
  };
  if (source.head !== undefined) result.head = assertObjectId(stringValue(source.head, 'repository.head'));
  if (source.branch !== undefined) result.branch = clean(assertRef(stringValue(source.branch, 'repository.branch')));
  return result;
}

function reconstructChange(value: unknown): GitPathChange {
  const source = safeRecord(value, CHANGE_FIELDS, 'path change');
  const result: GitPathChange = {
    kind: enumValue(source.kind, CHANGE_KINDS, 'change.kind'),
    path: clean(assertRelativePath(stringValue(source.path, 'change.path', 4_096))),
    baseline: reconstructPathState(source.baseline),
    result: reconstructPathState(source.result),
    resultIndex: arrayValues(source.resultIndex, 'change.resultIndex', 4).map(reconstructIndexEntry),
  };
  if (source.sourcePath !== undefined) result.sourcePath = clean(assertRelativePath(stringValue(source.sourcePath, 'change.sourcePath', 4_096)));
  if (source.resultOids !== undefined) {
    result.resultOids = arrayValues(source.resultOids, 'change.resultOids', 8)
      .map((item) => assertObjectId(stringValue(item, 'change.resultOids')));
  }
  return result;
}

function reconstructPathState(value: unknown): GitPathState {
  const source = safeRecord(value, PATH_STATE_FIELDS, 'path state');
  const result: GitPathState = { path: clean(assertRelativePath(stringValue(source.path, 'path state.path', 4_096))) };
  if (source.oid !== undefined) result.oid = assertObjectId(stringValue(source.oid, 'path state.oid'));
  if (source.mode !== undefined) result.mode = enumValue(source.mode, GIT_MODES, 'path state.mode');
  return result;
}

function reconstructIndexEntry(value: unknown): GitIndexEntry {
  const source = safeRecord(value, INDEX_ENTRY_FIELDS, 'index entry');
  const stage = source.stage;
  if (!Number.isInteger(stage) || (stage as number) < 0 || (stage as number) > 3) throw new Error('invalid index stage');
  return {
    path: clean(assertRelativePath(stringValue(source.path, 'index entry.path', 4_096))),
    mode: enumValue(source.mode, GIT_MODES, 'index entry.mode'),
    oid: assertObjectId(stringValue(source.oid, 'index entry.oid')),
    stage: stage as number,
  };
}

function safeRecord(value: unknown, allowed: ReadonlySet<string>, label: string): SafeRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`invalid ${label}`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`invalid ${label} prototype`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as SafeRecord;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error(`unknown ${label} field`);
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error(`invalid ${label} field`);
    result[key] = descriptor.value;
  }
  return result;
}

function arrayValues(value: unknown, label: string, maximumLength: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximumLength) {
    throw new Error(`invalid ${label}`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key)) throw new Error(`invalid ${label} field`);
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error(`invalid ${label} entry`);
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) throw new Error(`sparse ${label}`);
    return descriptor.value;
  });
}

function stringValue(value: unknown, label: string, maximumLength = 4_096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength || value.includes('\u0000')) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function optionalCleanString(source: SafeRecord, key: string): string | undefined {
  return source[key] === undefined ? undefined : clean(stringValue(source[key], key));
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, label: string): T {
  if (typeof value !== 'string' || !values.has(value as T)) throw new Error(`invalid ${label}`);
  return value as T;
}

function optionalEnum<T extends string>(source: SafeRecord, key: string, values: ReadonlySet<T>): T | undefined {
  return source[key] === undefined ? undefined : enumValue(source[key], values, key);
}

function assertObjectId(value: string): string {
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value)) throw new Error('invalid object id');
  return value;
}

function assertRef(value: string): string {
  const invalidCharacter = /[\u0000-\u0020\u007f~^:?*\[]/;
  if (!value || value.startsWith('-') || value === '@' || value.startsWith('/') || value.endsWith('/')
    || value.startsWith('.') || value.endsWith('.') || value.includes('..') || value.includes('@{')
    || value.includes('\\') || invalidCharacter.test(value)) throw new Error('invalid ref');
  if (value.split('/').some((segment) => !segment || segment.startsWith('.') || segment.endsWith('.lock'))) throw new Error('invalid ref');
  return value;
}

function assertRelativePath(value: string): string {
  if (value === '.' || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)
    || value.includes('\\') || value.startsWith(':(') || /[*?[\u0000]/.test(value)) throw new Error('invalid path');
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('invalid path');
  return value;
}

function assertWorkspacePathspec(value: string): string {
  if (value === '.') return value;
  return assertRelativePath(value);
}

function clean(value: string): string {
  return sanitizeError(value).replaceAll('[REDACTED]', 'REDACTED');
}

function removeUndefinedProperties(record: SafeRecord): void {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
}
