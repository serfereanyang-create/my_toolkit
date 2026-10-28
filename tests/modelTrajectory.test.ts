import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalToolNames,
  compareToolNames,
  diffToolNames,
  recordTrajectoryRow,
  recordedToolSurface,
  readTrajectoryRecords,
  toolNamesHash,
  toolNamesOrderHash,
  trajectoryPathFor,
  withCanonicalToolNames,
  TRAJECTORY_TAIL,
  type TrajectoryRecord,
} from '../src/session/modelTrajectory.js';

function tempSession() {
  const dir = mkdtempSync(join(tmpdir(), 'trajectory-'));
  const sessionPath = join(dir, 'sess_test.json');
  return {
    sessionPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('trajectoryPathFor puts the trace next to the session file', () => {
  assert.equal(trajectoryPathFor('C:/ws/.aicode/sessions/sess_a.json'), 'C:/ws/.aicode/sessions/sess_a.trajectory.jsonl');
});

test('rows append and read back in order', () => {
  const { sessionPath, cleanup } = tempSession();
  try {
    assert.equal(readTrajectoryRecords(sessionPath).length, 0, 'missing file reads as empty');
    recordTrajectoryRow(sessionPath, { requestId: 'r1', step: 1, streamMetrics: { transport: 'sse', durationMs: 80, timeToFirstEventMs: 10, timeToFirstOutputMs: 20, eventCount: 2, outputDeltaCount: 1, outputChars: 4, interEventP50Ms: 70, interEventP95Ms: 70, maxInterEventMs: 70 } } as never);
    recordTrajectoryRow(sessionPath, { requestId: 'r2', step: 2 } as never);
    const rows = readTrajectoryRecords(sessionPath);
    assert.deepEqual(rows.map((r) => r.step), [1, 2]);
    assert.equal(rows[0]?.streamMetrics?.timeToFirstOutputMs, 20);
    assert.equal(TRAJECTORY_TAIL, 6);
  } finally {
    cleanup();
  }
});

test('a corrupt line does not take the whole trace down', () => {
  const { sessionPath, cleanup } = tempSession();
  try {
    recordTrajectoryRow(sessionPath, { step: 1 } as never);
    const file = trajectoryPathFor(sessionPath);
    appendFileSync(file, 'not json\n', 'utf-8');
    assert.deepEqual(readTrajectoryRecords(sessionPath), [], 'unparseable trace reads as empty rather than throwing');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 规范表示（比较用，绝不进入请求）
// ---------------------------------------------------------------------------

test('canonicalToolNames sorts by code unit, keeps repeats, and leaves the input alone', () => {
  const raw = ['write_file', 'read_file', 'read_file', 'apply_patch'];
  const canonical = canonicalToolNames(raw);
  assert.deepEqual(canonical, ['apply_patch', 'read_file', 'read_file', 'write_file']);
  assert.deepEqual(raw, ['write_file', 'read_file', 'read_file', 'apply_patch'], 'input order is the recorded order and must not be edited');
});

test('canonicalToolNames distinguishes absent from empty', () => {
  assert.equal(canonicalToolNames(undefined), null);
  assert.equal(canonicalToolNames(null), null);
  assert.deepEqual(canonicalToolNames([]), [], 'a request with no tools is a fact, not a missing field');
});

test('compareToolNames is code-unit order, not locale order', () => {
  // localeCompare would put these in a different order under some locales; the
  // canonical form must be identical on every machine and ICU build.
  assert.deepEqual(['a_b', 'aZ', 'A'].sort(compareToolNames), ['A', 'aZ', 'a_b']);
});

test('the canonical hash ignores order but not multiplicity', () => {
  assert.equal(toolNamesHash(['b', 'a']), toolNamesHash(['a', 'b']));
  assert.notEqual(toolNamesHash(['a']), toolNamesHash(['a', 'a']));
  assert.notEqual(toolNamesHash(['ab']), toolNamesHash(['a', 'b']), 'the join must be unambiguous');
  assert.equal(toolNamesHash(undefined), null);
  assert.notEqual(toolNamesOrderHash(['b', 'a']), toolNamesOrderHash(['a', 'b']));
});

test('diffToolNames separates "only the order changed" from "the set changed"', () => {
  const reordered = diffToolNames(['read_file', 'write_file'], ['write_file', 'read_file']);
  assert.equal(reordered.comparable, true);
  assert.equal(reordered.setChanged, false);
  assert.equal(reordered.orderChanged, true);
  assert.equal(reordered.orderOnlyChange, true, 'the biased case: identical set, different sequence');
  assert.deepEqual(reordered.added, []);
  assert.deepEqual(reordered.removed, []);

  const added = diffToolNames(['read_file'], ['read_file', 'write_file']);
  assert.equal(added.setChanged, true);
  assert.equal(added.orderOnlyChange, false);
  assert.deepEqual(added.added, ['write_file']);
  assert.deepEqual(added.removed, []);

  const removed = diffToolNames(['read_file', 'write_file'], ['read_file']);
  assert.deepEqual(removed.removed, ['write_file']);
  assert.deepEqual(removed.added, []);
});

test('diffToolNames counts multiplicity as a set change, not a reorder', () => {
  const diff = diffToolNames(['read_file'], ['read_file', 'read_file']);
  assert.equal(diff.setChanged, true);
  assert.equal(diff.orderOnlyChange, false, 'a name called twice is not a reorder of a name called once');
  assert.deepEqual(diff.added, ['read_file']);
});

test('diffToolNames says nothing when a side is missing', () => {
  const diff = diffToolNames(undefined, ['a']);
  assert.equal(diff.comparable, false);
  assert.equal(diff.setChanged, false);
  assert.equal(diff.orderOnlyChange, false);
  assert.deepEqual(diff.added, []);
  assert.equal(diff.afterSetHash, toolNamesHash(['a']));
  assert.equal(diff.beforeSetHash, null);
});

test('withCanonicalToolNames is pure and additive', () => {
  const row = {
    requestId: 'r1',
    step: 1,
    toolNames: ['write_file', 'read_file'],
    toolSetNames: ['write_file', 'read_file', 'apply_patch'],
  } as unknown as TrajectoryRecord;
  const enriched = withCanonicalToolNames(row);
  assert.deepEqual(row.toolNames, ['write_file', 'read_file'], 'the input row is not mutated');
  assert.equal(row.toolNamesCanonical, undefined);
  assert.deepEqual(enriched.toolNamesCanonical, ['read_file', 'write_file']);
  assert.equal(enriched.toolNamesHash, toolNamesHash(['write_file', 'read_file']));
  assert.deepEqual(enriched.toolSetCanonical, ['apply_patch', 'read_file', 'write_file']);
  assert.equal(enriched.toolSetHash, toolNamesHash(['write_file', 'read_file', 'apply_patch']));
  assert.deepEqual(enriched.toolNames, ['write_file', 'read_file'], 'the recorded order is kept as it was emitted');
});

test('withCanonicalToolNames leaves rows without tool arrays untouched', () => {
  const row = { requestId: 'r1', step: 1 } as unknown as TrajectoryRecord;
  const enriched = withCanonicalToolNames(row);
  assert.equal(enriched.toolNamesCanonical, undefined);
  assert.equal(enriched.toolSetHash, undefined);
});

test('recordTrajectoryRow stores the canonical list beside the raw one', () => {
  const { sessionPath, cleanup } = tempSession();
  try {
    recordTrajectoryRow(sessionPath, {
      requestId: 'r1',
      step: 1,
      toolNames: ['write_file', 'read_file', 'read_file'],
    } as unknown as TrajectoryRecord);
    const [row] = readTrajectoryRecords(sessionPath);
    assert.deepEqual(row?.toolNames, ['write_file', 'read_file', 'read_file'], 'raw emission order survives verbatim');
    assert.deepEqual(row?.toolNamesCanonical, ['read_file', 'read_file', 'write_file']);
    assert.equal(row?.toolNamesHash, toolNamesHash(['write_file', 'read_file', 'read_file']));
    assert.equal(row?.toolSetNames, undefined, 'a sent-tools record is not invented where the writer gave none');
  } finally {
    cleanup();
  }
});

test('recordedToolSurface prefers the sent array and recomputes canonical for legacy rows', () => {
  const withSent = recordedToolSurface({
    toolNames: ['read_file'],
    toolSetNames: ['write_file', 'read_file'],
  } as unknown as TrajectoryRecord);
  assert.equal(withSent.layer, 'sent-tools');
  assert.deepEqual(withSent.canonical, ['read_file', 'write_file']);

  // Legacy row: no canonical fields on disk (written before this change).
  const legacy = recordedToolSurface({ toolNames: ['write_file', 'read_file'] } as unknown as TrajectoryRecord);
  assert.equal(legacy.layer, 'called-tools');
  assert.deepEqual(legacy.canonical, ['read_file', 'write_file'], 'the normaliser is deterministic, so read-side recomputation matches write-side');

  // A row that stored the canonical list is trusted over recomputation.
  const cached = recordedToolSurface({
    toolNames: ['write_file', 'read_file'],
    toolNamesCanonical: ['read_file', 'write_file'],
  } as unknown as TrajectoryRecord);
  assert.deepEqual(cached.canonical, ['read_file', 'write_file']);

  assert.equal(recordedToolSurface({} as unknown as TrajectoryRecord).layer, 'none');
});
