import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { StreamMetrics } from '../providers/streamMetrics.js';

/** One message as it was actually sent to (or returned by) the model. */
export type TrajectoryMessage = {
  role: string;
  content: string;
  name?: string;
};

/**
 * One model round-trip. Mirrors the upstream `ZCodeModelTrajectoryRecord`
 * fields that this app can actually produce: the request context as sent, the
 * response as received, timing, and the correlation ids that tie a row to a
 * turn and a step.
 */
export type TrajectoryRecord = {
  requestId: string;
  turnId: string;
  step: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  model: string;
  provider: string;
  ok: boolean;
  error?: string;
  /** Message count of the request context — the record stores the tail only. */
  requestMessageCount: number;
  /** The last N messages as sent, so the viewer shows the real prompt tail. */
  requestTail: TrajectoryMessage[];
  /** Assistant text produced by this call. */
  responseText: string;
  /**
   * Tools the model **called** this round, in the order it emitted them.
   *
   * This is an activity record, NOT the tool surface: the array that sits in
   * the cached prefix is the *sent* one (below). Recorded in emission order, so
   * two rounds that called the same tools in a different order are not
   * comparable without canonicalisation — see `canonicalToolNames`.
   */
  toolNames: string[];
  /**
   * Canonical (sorted, duplicates kept) form of `toolNames` — analysis only.
   *
   * Never compared to, and never sent as, anything: the model's call order has
   * no bearing on the provider payload. It exists so a "did the called set
   * change?" question has one stable answer instead of two order-dependent ones.
   * Filled by `recordTrajectoryRow`; rows written before this field existed (and
   * hand-written fixtures) get it recomputed on read.
   */
  toolNamesCanonical?: string[];
  /** sha256 of `toolNamesCanonical` — the multiset's identity, order-free. */
  toolNamesHash?: string;
  /**
   * Names of the tools **sent** with this request, in the order sent.
   *
   * This is the array that sits inside the cached prompt prefix, so its order is
   * load-bearing for the cache in a way `toolNames` order is not. Written by the
   * agent loop at the point of sending: the call site takes
   * `stepTools.list().map(tool => tool.name)` — the very array that is
   * serialised into the request — so this field is evidence of what the provider
   * received, not of what the model called. It is what decides a planning turn's
   * last step, where `stepTools` narrows to `[propose_plan]`.
   *
   * Rows written before the writer existed (and hand-written fixtures) lack it;
   * readers fall back to `toolNames` via `recordedToolSurface` and label the
   * result `called-tools` rather than pretending.
   */
  toolSetNames?: string[];
  /** Canonical (sorted, duplicates kept) form of `toolSetNames` — comparison only, never sent. */
  toolSetCanonical?: string[];
  /** sha256 of `toolSetCanonical`: the multiset's identity, order-free. */
  toolSetHash?: string;
  /**
   * Order-sensitive sha256 of the raw `toolSetNames` sequence.
   *
   * `toolSetHash` deliberately ignores order, so it cannot answer the question
   * the prefix actually turns on: providers hash the tool array in the order
   * given, so `[a, b]` and `[b, a]` are two different prefixes. This is the
   * byte-equivalence witness — equal values ⇒ the same names in the same order.
   *
   * Same construction as `toolNamesOrderHash`; the two fields are separate
   * because they describe different things (a sent array vs a call log) and
   * should not be conflated even though the algorithm is shared.
   */
  toolSetOrderHash?: string;
  promptChars: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  streamMetrics?: StreamMetrics;
};

/** Where the rows for one session live: next to the session file itself. */
/** How many trailing messages the viewer keeps per call (the real prompt tail). */
export const TRAJECTORY_TAIL = 6;

// ---------------------------------------------------------------------------
// 工具名的规范表示（只用于比较/分析，绝不改变实际发送顺序）
// ---------------------------------------------------------------------------

/**
 * Separator for hashing a list of names. `\u0000` cannot occur in a tool name
 * (they are identifiers), so the join is unambiguous: ["a","b"] hashes
 * differently from ["ab"].
 *
 * One boundary is worth recording rather than fixing: the join cannot tell
 * `[]` from `[""]`, so both hash to sha256("") = e3b0c44298fc. In practice `""`
 * only appears in `toolNames` — the recorder maps a tool action with no name
 * to `''` — and never in `toolSetNames`, which comes from the registry. Making
 * the empty list distinct would mean prefixing the join with the element count;
 * that changes every hash (all rows recorded before the change would be
 * re-compared under the new scheme) for a case that only means "a nameless
 * call", so the collision is documented instead of "fixed".
 */
const NAME_JOINER = '\u0000';

/**
 * Compare tool names by UTF-16 code unit.
 *
 * Deliberately not `localeCompare`: the canonical form must be identical on
 * every machine and every ICU build, because it is compared against rows
 * recorded days earlier on a different platform. `localeCompare` sorts `_` and
 * case differently per locale, which would make two identical surfaces hash
 * differently.
 */
export function compareToolNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical form of a recorded tool-name list: sorted, duplicates kept.
 *
 * Duplicates are kept because a *called*-tools list legitimately repeats a name
 * (the model called `read_file` twice this round); dropping them would make
 * "called once" and "called twice" compare equal. The result describes the
 * multiset, which is the only order-free invariant of such a list.
 *
 * Returns `null` for absent input (`undefined`/`null`) so that "unknown" and
 * "known to be empty" stay distinguishable — an empty tool array is a real
 * fact about a request, a missing field is not.
 */
export function canonicalToolNames(names: readonly string[] | null | undefined): string[] | null {
  if (names === null || names === undefined) return null;
  return names.map((name) => String(name)).sort(compareToolNames);
}

/** sha256 of the canonical list, first 12 hex chars. `null` when absent. */
export function toolNamesHash(names: readonly string[] | null | undefined): string | null {
  const canonical = canonicalToolNames(names);
  if (canonical === null) return null;
  return createHash('sha256').update(canonical.join(NAME_JOINER)).digest('hex').slice(0, 12);
}

/** Order-sensitive hash: equal only when the raw sequence is identical. */
export function toolNamesOrderHash(names: readonly string[] | null | undefined): string | null {
  if (names === null || names === undefined) return null;
  return createHash('sha256').update(names.map((name) => String(name)).join(NAME_JOINER)).digest('hex').slice(0, 12);
}

export type ToolNameDiff = {
  /** Both sides had the field: only then can anything be asserted. */
  comparable: boolean;
  /** The multiset differs — a name was added, removed, or repeated differently. */
  setChanged: boolean;
  /** The raw sequence differs (order-sensitive). */
  orderChanged: boolean;
  /**
   * The biased case: same multiset, different sequence. For a *called*-tools
   * list this is recording noise; for a *sent*-tools list it is a real cache
   * invalidation, because providers hash the array in the order given.
   */
  orderOnlyChange: boolean;
  /** Names the multiset gained / lost, with multiplicity, sorted. */
  added: string[];
  removed: string[];
  beforeCanonical: string[] | null;
  afterCanonical: string[] | null;
  beforeSetHash: string | null;
  afterSetHash: string | null;
  beforeOrderHash: string | null;
  afterOrderHash: string | null;
};

function multisetCounts(names: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

function multisetDelta(
  from: Map<string, number>,
  to: Map<string, number>,
): string[] {
  const out: string[] = [];
  for (const [name, count] of to) {
    const before = from.get(name) ?? 0;
    for (let i = before; i < count; i++) out.push(name);
  }
  return out.sort(compareToolNames);
}

/**
 * Compare two recorded tool-name lists with the order question kept separate
 * from the set question. Callers that conflate them are the bug this exists to
 * prevent: an unstable recording order looks like a changing tool surface.
 */
export function diffToolNames(
  before: readonly string[] | null | undefined,
  after: readonly string[] | null | undefined,
): ToolNameDiff {
  const beforeCanonical = canonicalToolNames(before);
  const afterCanonical = canonicalToolNames(after);
  const comparable = beforeCanonical !== null && afterCanonical !== null;
  const rawBefore = before === null || before === undefined ? null : before.map((name) => String(name));
  const rawAfter = after === null || after === undefined ? null : after.map((name) => String(name));
  const setChanged = comparable
    ? beforeCanonical.length !== afterCanonical.length
      || beforeCanonical.some((name, index) => name !== afterCanonical[index])
    : false;
  const orderChanged = rawBefore !== null && rawAfter !== null
    ? rawBefore.length !== rawAfter.length || rawBefore.some((name, index) => name !== rawAfter[index])
    : false;
  return {
    comparable,
    setChanged,
    orderChanged,
    orderOnlyChange: comparable && !setChanged && orderChanged,
    added: comparable ? multisetDelta(multisetCounts(beforeCanonical), multisetCounts(afterCanonical)) : [],
    removed: comparable ? multisetDelta(multisetCounts(afterCanonical), multisetCounts(beforeCanonical)) : [],
    beforeCanonical,
    afterCanonical,
    beforeSetHash: toolNamesHash(before),
    afterSetHash: toolNamesHash(after),
    beforeOrderHash: toolNamesOrderHash(before),
    afterOrderHash: toolNamesOrderHash(after),
  };
}

/**
 * Return a copy of `row` with the canonical fields filled in.
 *
 * Pure and additive: it touches nothing that is sent anywhere and never mutates
 * its input. Recording the canonical form alongside the raw one means a later
 * reader does not have to trust that it re-derived the same sort.
 */
export function withCanonicalToolNames<T extends TrajectoryRecord>(row: T): T {
  const next: T = { ...row };
  if (Array.isArray(row.toolNames)) {
    next.toolNamesCanonical = canonicalToolNames(row.toolNames) ?? [];
    next.toolNamesHash = toolNamesHash(row.toolNames) ?? undefined;
  }
  if (Array.isArray(row.toolSetNames)) {
    next.toolSetCanonical = canonicalToolNames(row.toolSetNames) ?? [];
    // Two identities, deliberately different questions: `toolSetHash` is the
    // multiset (order-free), `toolSetOrderHash` the actual byte order. A reader
    // asking "did the prefix change?" needs the second; one asking "was it the
    // same set of tools?" needs the first.
    next.toolSetHash = toolNamesHash(row.toolSetNames) ?? undefined;
    next.toolSetOrderHash = toolNamesOrderHash(row.toolSetNames) ?? undefined;
  }
  return next;
}

/**
 * The canonical name list for the *sent* tool surface of a round, whichever
 * layer the row happens to carry: the explicit sent-tool record when present,
 * otherwise the called-tools list (a coarser, activity-level answer).
 *
 * Exported so the ledger's fallback chain lives in one place instead of being
 * re-invented at every call site.
 */
export function recordedToolSurface(row: TrajectoryRecord): {
  layer: 'sent-tools' | 'called-tools' | 'none';
  raw: string[] | null;
  canonical: string[] | null;
  /**
   * Order-sensitive hash of the sent array — the prefix-equivalence witness.
   * Only the `sent-tools` layer has one: a called-tools list is recorded in
   * model emission order, which never reaches the provider, so hashing it would
   * invent an order that has no cache meaning.
   */
  orderHash: string | null;
} {
  /*
   * `toolSetNames: []` is a FACT — a turn that sent no tools at all — so it
   * stays on the sent-tools layer and hashes to sha256(""). It must NOT fall
   * back to `toolNames`: that would label an empty sent array as "which tools
   * the model called", i.e. invent evidence. Only an ABSENT field (legacy
   * rows, hand-written fixtures) takes the fallback below.
   */
  if (Array.isArray(row.toolSetNames)) {
    return {
      layer: 'sent-tools',
      raw: row.toolSetNames.map((name) => String(name)),
      /*
       * The cached canonical list is trusted only when it really is a list.
       * Trajectory files are JSONL on disk and a hand-edited (or truncated and
       * repaired) row can carry `"toolSetCanonical": "abc"`; `??` alone would
       * return that string through a field typed `string[]`, and every reader
       * downstream would compare a string with an array. Same for the hash:
       * a non-string cached value is recomputed.
       */
      canonical: Array.isArray(row.toolSetCanonical)
        ? row.toolSetCanonical.map((name) => String(name))
        : canonicalToolNames(row.toolSetNames),
      orderHash: typeof row.toolSetOrderHash === 'string'
        ? row.toolSetOrderHash
        : toolNamesOrderHash(row.toolSetNames),
    };
  }
  if (Array.isArray(row.toolNames)) {
    return {
      layer: 'called-tools',
      raw: row.toolNames.map((name) => String(name)),
      canonical: Array.isArray(row.toolNamesCanonical)
        ? row.toolNamesCanonical.map((name) => String(name))
        : canonicalToolNames(row.toolNames),
      orderHash: null,
    };
  }
  return { layer: 'none', raw: null, canonical: null, orderHash: null };
}

export function trajectoryPathFor(sessionPath: string): string {
  return sessionPath.replace(/\.json$/, '.trajectory.jsonl');
}

/**
 * Append one row. Never throws into the agent loop: a failed trace must not
 * take down a turn that is otherwise fine.
 *
 * The row is stored together with its canonical tool-name fields (see
 * `withCanonicalToolNames`) so the artifact itself is comparable: order-only
 * churn no longer makes two identical rounds look different to a reader that
 * does not know the normaliser. Purely additive — nothing here reaches a
 * provider, and the raw list is written unchanged beside the sorted one.
 */
export function recordTrajectoryRow(sessionPath: string, row: TrajectoryRecord): void {
  try {
    const file = trajectoryPathFor(sessionPath);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(withCanonicalToolNames(row))}\n`, 'utf-8');
  } catch {
    /* tracing is best-effort */
  }
}

/** Read the rows back, oldest first. Missing or corrupt file yields []. */
export function readTrajectoryRecords(sessionPath: string): TrajectoryRecord[] {
  const file = trajectoryPathFor(sessionPath);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf-8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as TrajectoryRecord);
  } catch {
    return [];
  }
}

/** Minimal runtime surface the recorder needs; keeps agent.ts decoupled. */
type RecorderRuntime = {
  session: { id: string };
  sessions: { filePath(id: string): string };
};

/**
 * Record one model call from the agent loop.
 *
 * Kept here so the loop needs a single call and the file naming lives in one
 * place. Best-effort by design: a broken trace must never fail a turn.
 */
export function recordTrajectory(runtime: RecorderRuntime, row: TrajectoryRecord): void {
  try {
    recordTrajectoryRow(runtime.sessions.filePath(runtime.session.id), row);
  } catch {
    /* tracing is diagnostics, never a turn-critical path */
  }
}
