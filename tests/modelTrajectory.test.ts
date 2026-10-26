import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  trajectoryPathFor,
  recordTrajectoryRow,
  readTrajectoryRecords,
  TRAJECTORY_TAIL,
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
    recordTrajectoryRow(sessionPath, { requestId: 'r1', step: 1 } as never);
    recordTrajectoryRow(sessionPath, { requestId: 'r2', step: 2 } as never);
    const rows = readTrajectoryRecords(sessionPath);
    assert.deepEqual(rows.map((r) => r.step), [1, 2]);
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
