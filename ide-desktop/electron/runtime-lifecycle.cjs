/*
 * Runtime process supervisor — inspired by zcode's runtimeProcessLifecycle
 * event contract (spawn/ready/exit with termination kinds and diagnostics).
 *
 * Wraps a long-lived helper process (bridge, language server, FIM server):
 *   - ready detection from stdout activity or an explicit predicate
 *   - stderr ring buffer for diagnostics
 *   - exit classification: expected (we stopped it) / unexpected /
 *     watchdog_recycle (crash loop protection kicked in)
 *   - automatic restart with backoff, bounded by maxRestarts
 */

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { terminateProcessTree } = require('./process-tree.cjs');

const STDERR_RING_LIMIT = 100;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_RESTART_BACKOFF_MS = 500;
const DEFAULT_MAX_RESTARTS = 3;
/** Exits faster than this repeatedly count as crashes for the watchdog. */
const WATCHDOG_MIN_UPTIME_MS = 1_000;

function createRuntimeSupervisor(options) {
  const {
    provider,
    command,
    args = [],
    cwd,
    workspacePath = '',
    lane,
    isReady,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    restartBackoffMs = DEFAULT_RESTART_BACKOFF_MS,
    maxRestarts = DEFAULT_MAX_RESTARTS,
  } = options;

  const emitter = new EventEmitter();
  const state = {
    child: null,
    generation: 0,
    instanceId: null,
    startedAt: 0,
    stopping: false,
    restarts: 0,
    restartTimer: null,
    readyTimer: null,
    stderrRing: [],
  };

  function emit(type, payload) {
    emitter.emit(type, payload);
  }

  function pushStderrLine(line) {
    state.stderrRing.push(line);
    if (state.stderrRing.length > STDERR_RING_LIMIT) state.stderrRing.shift();
  }

  function markReady(child) {
    if (state.readyTimer) {
      clearTimeout(state.readyTimer);
      state.readyTimer = null;
    }
    if (state.child !== child || child.__ready) return;
    child.__ready = true;
    emit('ready', {
      lane, pid: child.pid, provider, workspacePath,
      readyAt: Date.now(), startupDurationMs: Date.now() - state.startedAt,
      runtimeGeneration: state.generation, runtimeInstanceId: state.instanceId,
    });
  }

  function scheduleRestart(reason) {
    if (state.stopping) return;
    if (state.restarts >= maxRestarts) {
      // Crash-loop bound reached: surface watchdog_recycle with diagnostics.
      emit('exit', {
        lane, pid: null, provider, workspacePath,
        exitCode: null, signal: null, endedAt: Date.now(),
        terminationKind: 'watchdog_recycle', terminationReason: reason,
        runtimeReady: false, runtimeGeneration: state.generation,
        runtimeInstanceId: state.instanceId, uptimeMs: 0,
        stderrLineCount: state.stderrRing.length, stderrTail: state.stderrRing.slice(-10),
      });
      return;
    }
    state.restarts += 1;
    const delay = restartBackoffMs * state.restarts;
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      spawnInstance();
    }, delay);
  }

  function spawnInstance() {
    state.generation += 1;
    state.instanceId = randomUUID();
    state.stderrRing = [];
    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide: true });
    } catch (error) {
      emit('error', {
        lane, pid: null, provider, workspacePath, command, args,
        errorName: error?.name ?? 'Error', errorCode: error?.code,
        errorMessage: error?.message ?? String(error), errorStack: error?.stack,
        runtimeGeneration: state.generation, runtimeInstanceId: state.instanceId,
        occurredAt: Date.now(),
      });
      scheduleRestart('spawn-failed');
      return;
    }
    state.child = child;
    state.startedAt = Date.now();
    child.__uptimeMs = 0;
    emit('spawn', {
      lane, pid: child.pid, provider, workspacePath, command, args,
      startedAt: state.startedAt, runtimeGeneration: state.generation,
      runtimeInstanceId: state.instanceId,
    });

    state.readyTimer = setTimeout(() => {
      // Not stdout-ready yet — treat as ready anyway so slow starters work,
      // but only once; the flag keeps events single-shot.
      markReady(child);
    }, readyTimeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      if (typeof chunk === 'string' && chunk.trim().length > 0) markReady(child);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) pushStderrLine(line);
      }
    });
    child.on('error', (error) => {
      emit('error', {
        lane, pid: child.pid ?? null, provider, workspacePath, command, args,
        errorName: error?.name ?? 'Error', errorCode: error?.code,
        errorMessage: error?.message ?? String(error), errorStack: error?.stack,
        runtimeGeneration: state.generation, runtimeInstanceId: state.instanceId,
        occurredAt: Date.now(),
      });
    });
    child.on('exit', (exitCode, signal) => {
      child.__uptimeMs = Date.now() - state.startedAt;
      if (state.readyTimer) { clearTimeout(state.readyTimer); state.readyTimer = null; }
      if (state.child === child) state.child = null;
      const ready = child.__ready === true;
      const uptimeMs = child.__uptimeMs;
      emit('exit', {
        lane, pid: child.pid, provider, workspacePath,
        exitCode, signal, endedAt: Date.now(),
        terminationKind: state.stopping ? 'expected' : 'unexpected',
        runtimeReady: ready, runtimeGeneration: state.generation,
        runtimeInstanceId: state.instanceId, uptimeMs,
        stderrLineCount: state.stderrRing.length, stderrTail: state.stderrRing.slice(-10),
      });
      // Exits younger than the watchdog window count the same as failures for
      // the restart bound; ready runs that die later still consume a restart.
      const reason = uptimeMs < WATCHDOG_MIN_UPTIME_MS && !ready
        ? `crash loop (fast exit, code ${exitCode ?? 'signal ' + signal})`
        : `runtime exited (code ${exitCode ?? 'signal ' + signal})`;
      scheduleRestart(reason);
    });
  }

  return {
    emitter,
    start() {
      state.stopping = false;
      state.restarts = 0;
      spawnInstance();
    },
    /** Stop the runtime and disable auto-restart. */
    async stop() {
      state.stopping = true;
      if (state.restartTimer) { clearTimeout(state.restartTimer); state.restartTimer = null; }
      if (state.readyTimer) { clearTimeout(state.readyTimer); state.readyTimer = null; }
      const child = state.child;
      state.child = null;
      if (child && child.exitCode === null && child.signalCode === null) {
        const result = await terminateProcessTree(child, { forceAfterMs: 1500 }).catch(() => ({ killed: false }));
        return { ok: result.killed, forced: result.forced };
      }
      return { ok: true, forced: false };
    },
    isRunning() {
      return state.child !== null && state.child.exitCode === null && state.child.signalCode === null;
    },
    diagnostics() {
      return {
        provider, command, args, lane, workspacePath,
        generation: state.generation, instanceId: state.instanceId,
        restarts: state.restarts,
        running: this.isRunning(),
        stderrTail: state.stderrRing.slice(-10),
      };
    },
  };
}

module.exports = { createRuntimeSupervisor, STDERR_RING_LIMIT };
