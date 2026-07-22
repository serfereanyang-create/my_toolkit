#!/usr/bin/env node
import { runLiveSmoke } from './liveSmoke.js';

async function main() {
  const result = await runLiveSmoke(process.env);
  const prefix = result.status === 'passed' ? 'PASS' : result.status === 'skipped' ? 'SKIP' : 'FAIL';
  process.stdout.write(`${prefix} live-smoke: ${result.detail}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
