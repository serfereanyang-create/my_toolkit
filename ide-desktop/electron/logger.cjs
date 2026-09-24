/*
 * Structured service logger — ported from zcode's serviceLogger with a
 * desktop-specific addition: JSONL file output with size-based rotation.
 *
 * Every line is one JSON object {t, level, scope, traceId, pid, msg}; the
 * active file is <name>.log and rotations become <name>-<timestamp>.log, of
 * which the newest <keep> are retained. Console output mirrors the upstream
 * `[scope][trace:id] [pid]` prefix format.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

function formatPrefix(scope, traceId, pid) {
  const source = traceId ? `${scope}][trace:${traceId}` : scope;
  return `[${source}] [${pid}]`;
}

function formatArgs(args) {
  return args.map((arg) => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return `${arg.stack ?? `${arg.name}: ${arg.message}`}`;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(' ');
}

function createFileLogger(options) {
  const dir = options.dir;
  const name = options.name ?? 'main';
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const keep = options.keep ?? 7;
  const pid = options.pid ?? process.pid;
  const mirrorToConsole = options.mirrorToConsole !== false;
  let activePath = path.join(dir, `${name}.log`);
  let writeChain = Promise.resolve();

  async function rotateIfNeeded() {
    let stat;
    try {
      stat = await fs.stat(activePath);
    } catch {
      return;
    }
    if (stat.size < maxBytes) return;
    const rotated = path.join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    await fs.rename(activePath, rotated).catch(() => {});
    const files = (await fs.readdir(dir).catch(() => []))
      .filter((file) => file.startsWith(`${name}-`) && file.endsWith('.log'))
      .sort()
      .reverse();
    for (const stale of files.slice(keep)) {
      await fs.rm(path.join(dir, stale), { force: true }).catch(() => {});
    }
  }

  async function write(level, traceId, ...args) {
    const line = `${JSON.stringify({
      t: new Date().toISOString(),
      level,
      scope: options.scope ?? 'app',
      traceId: traceId ?? undefined,
      pid,
      msg: formatArgs(args),
    })}\n`;
    // Serialize through a chain so concurrent callers cannot interleave lines
    // or race the rotation rename.
    const operation = writeChain.then(async () => {
      try {
        await fs.mkdir(dir, { recursive: true });
        await rotateIfNeeded();
        await fs.appendFile(activePath, line, 'utf-8');
      } catch {
        // Logging must never break the caller; drop the line on fs failure.
      }
    });
    writeChain = operation.catch(() => {});
    await operation;
    if (mirrorToConsole) {
      const prefix = formatPrefix(options.scope ?? 'app', traceId, pid);
      if (level === 'error') console.error(prefix, ...args);
      else if (level === 'warn') console.warn(prefix, ...args);
      else console.log(prefix, ...args);
    }
  }

  return {
    debug: (traceId, ...args) => { if (options.debug !== false) void write('debug', traceId, ...args); },
    info: (traceId, ...args) => void write('info', traceId, ...args),
    warn: (traceId, ...args) => void write('warn', traceId, ...args),
    error: (traceId, ...args) => void write('error', traceId, ...args),
    /** Newest lines last, capped at `lines` entries. */
    async tail(lines = 200) {
      let content;
      try {
        content = await fs.readFile(activePath, 'utf-8');
      } catch {
        return [];
      }
      return content.trimEnd().split('\n').slice(-lines);
    },
    activePath: () => activePath,
  };
}

module.exports = { createFileLogger, formatPrefix, formatArgs };
