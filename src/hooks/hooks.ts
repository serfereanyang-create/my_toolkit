import type { ToolResult } from '../tools/types.js';

export type HookEvent = {
  tool: string;
  input?: unknown;
  result?: ToolResult;
  error?: unknown;
};

export type HookRegistry = {
  beforeTool(event: HookEvent): Promise<void>;
  afterTool(event: HookEvent): Promise<void>;
  onError(event: HookEvent): Promise<void>;
};

/** Default ceiling for a single hook call; a stuck hook must not wedge a turn. */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

export function createNoopHooks(): HookRegistry {
  return makeScriptableHooks({});
}

export type HookFn = (event: HookEvent) => void | Promise<void>;

export type HookScript = {
  beforeTool?: HookFn;
  afterTool?: HookFn;
  onError?: HookFn;
};

export type ScriptableHookOptions = {
  timeoutMs?: number;
  /** Sink for hook failures; defaults to stderr for the non-vetoing phases. */
  onHookError?: (phase: 'beforeTool' | 'afterTool' | 'onError', error: unknown) => void;
};

/**
 * Build a hook registry from plain functions.
 *
 * The contract is enforced here, not at the registry call sites:
 *
 * - `beforeTool` runs AFTER the approval decision and before `execute`. It can
 *   only veto (by throwing); nothing a hook returns is read as "allow", so a
 *   hook cannot turn a policy deny into a run. It is not called at all for a
 *   call the policy already refused.
 * - `afterTool` / `onError` failures are reported and swallowed here, so a
 *   registry that goes through this module cannot convert a successful call
 *   into a failure. (A raw `{ ...createNoopHooks(), afterTool }` object handed
 *   straight to `ToolRegistry` bypasses this and is still caught by the
 *   registry's own catch block; use makeScriptableHooks to get the guarantee.)
 * - Every hook receives a frozen deep copy of the event. The registry hands the
 *   same validated `input` object to the tool, and the same `result` object
 *   back to the caller; letting a hook mutate them would change what runs after
 *   the user already approved it, or what the user sees the tool returned.
 * - A hook that never settles is rejected after `timeoutMs` (default 5s) like
 *   any other failure. Before this existed, a stuck `beforeTool` hung the turn
 *   with no diagnostic.
 */
export function makeScriptableHooks(script: HookScript, options: ScriptableHookOptions = {}): HookRegistry {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const report = options.onHookError ?? defaultHookErrorReporter;

  const run = async (phase: 'beforeTool' | 'afterTool' | 'onError', fn: HookFn | undefined, event: HookEvent) => {
    if (!fn) return;
    const snapshot = snapshotEvent(event);
    try {
      await withTimeout(Promise.resolve().then(() => fn(snapshot)), timeoutMs, `hook ${phase} timed out after ${timeoutMs}ms`);
    } catch (error) {
      report(phase, error);
      if (phase === 'beforeTool') throw error;
    }
  };

  return {
    async beforeTool(event) {
      await run('beforeTool', script.beforeTool, event);
    },
    async afterTool(event) {
      await run('afterTool', script.afterTool, event);
    },
    async onError(event) {
      await run('onError', script.onError, event);
    },
  };
}

/** Deep, frozen copy of an event. Non-plain values (class instances) are left by reference. */
export function snapshotEvent(event: HookEvent): HookEvent {
  const snapshot: HookEvent = { tool: event.tool };
  if ('input' in event) snapshot.input = freezeCopy(event.input);
  if (event.result) snapshot.result = freezeCopy(event.result) as ToolResult;
  if ('error' in event) snapshot.error = freezeCopy(event.error);
  return Object.freeze(snapshot);
}

function freezeCopy(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  if (seen.has(object)) return seen.get(object);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(object, out);
    for (const item of value) out.push(freezeCopy(item, seen));
    return Object.freeze(out);
  }
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  seen.set(object, out);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = freezeCopy(item, seen);
  return Object.freeze(out);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function defaultHookErrorReporter(phase: string, error: unknown) {
  if (phase === 'beforeTool') return; // the registry turns this into a tool failure
  const message = error instanceof Error ? error.message : String(error);
  try {
    process.stderr.write(`aicode: hook ${phase} failed: ${message}\n`);
  } catch {
    // stderr gone; nothing useful left to do
  }
}
