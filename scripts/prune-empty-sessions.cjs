/*
 * Delete EMPTY sessions (the ones the desktop shows as 未命名会话).
 *
 * An empty session is one that was created but never used: no user message, no
 * tool call, no final answer. They accumulate because a session file is written
 * at runtime startup whether or not the user ever types anything.
 *
 * Safety rules, in order of importance:
 *   1. A session with ANY non-empty user message is NEVER deleted. That is the
 *      same test workspace.cjs uses to derive a title, so "keeps its title"
 *      and "is kept" are the same condition by construction.
 *   2. A session holding other state (taskRuntime, goal, guard) is kept, even
 *      with no user text — deleting it would orphan a task-board reference.
 *   3. A session that does not parse is kept. A corrupt file is a question, not
 *      a licence to delete.
 *
 * Run with --apply to delete; without it, this only reports.
 */
const fs = require('fs');
const path = require('path');

const ROOTS = [
  'C:/Users/34516/ZCodeProject/cli',
  'C:/Users/34516/ZCodeProject/ide-desktop',
  'C:/Users/34516',
];
const APPLY = process.argv.includes('--apply');

function classify(filePath) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return 'unparseable';
  }
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const hasUserText = messages.some(
    (m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim(),
  );
  if (hasUserText) return 'used';
  // Other recorded state means the session is referenced by something.
  if (Array.isArray(record?.toolCalls) && record.toolCalls.length > 0) return 'has-state';
  if (Array.isArray(record?.finalAnswers) && record.finalAnswers.length > 0) return 'has-state';
  if (record?.taskRuntime) return 'has-state';
  if (record?.goal) return 'has-state';
  if (record?.guard) return 'has-state';
  return 'empty';
}

let grandDeleted = 0;
let grandBytes = 0;

for (const root of ROOTS) {
  const dir = path.join(root, '.aicode', 'sessions');
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '.desktop-meta.json');
  const buckets = { used: 0, 'has-state': 0, unparseable: 0, empty: 0 };
  const deletable = [];
  let bytes = 0;

  for (const f of files) {
    const full = path.join(dir, f);
    const kind = classify(full);
    buckets[kind] += 1;
    if (kind === 'empty') {
      deletable.push(full);
      try { bytes += fs.statSync(full).size; } catch { /* size is only for the report */ }
    }
  }

  const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
  console.log(`${root}`);
  console.log(`  total        ${files.length}`);
  console.log(`  keep  used   ${buckets.used}   (has user text)`);
  console.log(`  keep  state  ${buckets['has-state']}   (taskRuntime / goal / guard / toolCalls)`);
  console.log(`  keep  bad    ${buckets.unparseable}`);
  console.log(`  DELETE empty ${buckets.empty}   ${mb(bytes)}`);

  if (APPLY && deletable.length > 0) {
    let removed = 0;
    for (const full of deletable) {
      try { fs.rmSync(full, { force: true }); removed += 1; } catch { /* report below */ }
    }
    console.log(`  -> deleted ${removed}/${deletable.length}`);
    grandDeleted += removed;
    grandBytes += bytes;
  }
  console.log('');
}

if (!APPLY) {
  console.log('DRY RUN — nothing deleted. Re-run with --apply to delete the "empty" bucket.');
} else {
  console.log(`Deleted ${grandDeleted} empty session files (${(grandBytes / 1048576).toFixed(2)} MB).`);
}
