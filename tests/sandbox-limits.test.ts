import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { isLimitEnforcementEnabled, resolveResourceLimits, shutdownLimitSupervisors, wrapWithUlimits } from '../src/safety/resourceLimits.js';
import { runSandboxedCommand } from '../src/safety/sandbox.js';

const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';

after(() => shutdownLimitSupervisors());

test('limits resolve from env with sane defaults and an off switch', () => {
  const defaults = resolveResourceLimits({} as NodeJS.ProcessEnv);
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.memoryMb, 2048);
  assert.equal(defaults.maxProcesses, 64);

  const tuned = resolveResourceLimits({ AICODE_SANDBOX_MEMORY_MB: '512', AICODE_SANDBOX_MAX_PROCS: '8' } as NodeJS.ProcessEnv);
  assert.equal(tuned.memoryMb, 512);
  assert.equal(tuned.maxProcesses, 8);

  for (const off of ['0', 'false', 'off']) {
    assert.equal(resolveResourceLimits({ AICODE_SANDBOX_LIMITS: off } as NodeJS.ProcessEnv).enabled, false, off);
  }

  // Garbage values must not become "no limit" by accident.
  const garbage = resolveResourceLimits({ AICODE_SANDBOX_MEMORY_MB: 'lots' } as NodeJS.ProcessEnv);
  assert.equal(garbage.memoryMb, 0);
});

test('unix commands get the ulimit prelude, and only when enabled', () => {
  const limits = { enabled: true, memoryMb: 1024, maxProcesses: 32 };
  const wrapped = wrapWithUlimits('npm test', limits);
  assert.match(wrapped, /ulimit -v 1048576/);
  assert.match(wrapped, /ulimit -u 32/);
  assert.ok(wrapped.trimEnd().endsWith('npm test'));
  assert.equal(wrapWithUlimits('npm test', { ...limits, enabled: false }), 'npm test');
});

test('a normal command keeps its exit code and output through the limits layer', async () => {
  const result = await runSandboxedCommand({
    command: 'node -e "console.log(123); console.error(456); process.exit(3)"',
    cwd: process.cwd(),
    timeoutMs: 60_000,
    env: process.env,
  });
  assert.equal(result.code, 3);
  assert.match(result.stdout, /123/);
  assert.match(result.stderr, /456/);
  assert.equal(result.timedOut, false);
});

test('the second command reuses the supervisor instead of paying startup again', async () => {
  const env = process.env;
  const first = await runSandboxedCommand({ command: 'echo warm', cwd: process.cwd(), timeoutMs: 60_000, env });
  assert.match(first.stdout, /warm/);
  const started = Date.now();
  const second = await runSandboxedCommand({ command: 'echo reuse', cwd: process.cwd(), timeoutMs: 60_000, env });
  const elapsed = Date.now() - started;
  assert.match(second.stdout, /reuse/);
  // 只做量级检查：复用命中时是一条 Start-Process 的钱，冷启动要 600ms 起。
  assert.ok(elapsed < 5_000, `reused supervisor took ${elapsed}ms`);
});

test('a memory bomb is refused instead of eating the machine', { skip: !(isWin || isLinux) || !isLimitEnforcementEnabled(process.env) }, async () => {
  const started = Date.now();
  const result = await runSandboxedCommand({
    // 每次 64MB，永不释放 —— 没有上限时会把开发机拖到无法响应。
    command: 'node -e "const a=[];for(;;)a.push(Buffer.alloc(64*1024*1024,1))"',
    cwd: process.cwd(),
    timeoutMs: 45_000,
    env: { ...process.env, AICODE_SANDBOX_MEMORY_MB: '256' },
  });
  const elapsed = Date.now() - started;
  assert.notEqual(result.code, 0);
  assert.equal(result.timedOut, false, 'the ceiling should bite before the timeout');
  assert.ok(elapsed < 40_000, `took ${elapsed}ms`);
  // Host still healthy: this assertion running at all is the real proof.
  assert.ok(process.memoryUsage().heapUsed > 0);
});

test('a process storm is capped', { skip: !isWin || !isLimitEnforcementEnabled(process.env) }, async () => {
  const result = await runSandboxedCommand({
    command: 'node -e "const{spawn}=require(\'child_process\');for(let i=0;i<80;i++)spawn(process.execPath,[\'-e\',\'setTimeout(()=>{},30000)\'],{stdio:\'ignore\'});setTimeout(()=>{},30000)"',
    cwd: process.cwd(),
    timeoutMs: 45_000,
    env: { ...process.env, AICODE_SANDBOX_MAX_PROCS: '12' },
  });
  assert.notEqual(result.code, 0);
  assert.equal(result.timedOut, false, 'the process cap should bite before the timeout');
});

test('the off switch restores the plain spawn path', async () => {
  const result = await runSandboxedCommand({
    command: 'node -e "console.log(process.env.AICODE_SANDBOX_LIMITS)"',
    cwd: process.cwd(),
    timeoutMs: 60_000,
    env: { ...process.env, AICODE_SANDBOX_LIMITS: '0' },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /0/);
});
