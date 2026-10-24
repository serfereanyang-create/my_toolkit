/**
 * quality-gateway.cjs
 * Typed bridge between the renderer's quality panels and read-only CLI
 * analysis tools. Each invocation spawns a headless `--invoke-tool` CLI run
 * (ELECTRON_RUN_AS_NODE) with a fixed allowlist, timeout, and output cap.
 * Write-risk tools are refused here AND in the CLI; refactors must go through
 * the interactive approval flow instead.
 */
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { atomicWriteText } = require('./atomic-file.cjs');
const { serialize } = require('./json-store.cjs');


// Read-only analysis tools the quality panels may call. The CLI enforces the
// same read-only boundary independently, so this list is convenience, not the
// only gate.
const ALLOWED_TOOLS = new Set([
  'project_status',
  'review_code',
  'analyze_coverage',
  'analyze_performance',
  'analyze_complexity',
  'detect_code_smells',
  'analyze_dependencies',
  'refactor_preview',
  'audit_code_quality',
  'quality_gate_list',
  'quality_gate_run',
  'health_report',
  'query_call_graph',
  'impact_analysis',
  'query_type_relations',
  'dependency_tree',
  'semantic_search',
  'semantic_index_stats',
  // 技能与反思是只读展示数据（CLI 侧 risk:'read'），供桌面面板消费。
  'skill_list',
  'skill_show',
  'reflection_list',
  'structure_audit',
]);

const TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_STDERR_CHARS = 4_000;
const HISTORY_LIMIT = 50;

/**
 * 把成功/失败的分析结果持久化到工作区 .aicode/quality/：
 *  - <tool>/latest.json   最新一条（面板展示与对比）
 *  - <tool>/history.jsonl 最近 HISTORY_LIMIT 条（agent 可用 quality_history 查询）
 * 记录带 schemaVersion、capturedAt、可选 revision（分支@HEAD@脏文件数），
 * 失败的运行同样记录——失败历史与成功历史同样有诊断价值。
 */
async function persistQualityRecord(fsPromises, pathModule, workspaceRoot, toolName, input, revision, result) {
  if (!workspaceRoot || typeof result?.ok !== 'boolean') return;
  const record = {
    schemaVersion: 1,
    tool: toolName,
    capturedAt: new Date().toISOString(),
    ...(revision ? { revision } : {}),
    input: input ?? {},
    result: { ok: result.ok, output: String(result.output ?? '').slice(0, 20_000), data: result.data },
  };
  const dir = pathModule.join(workspaceRoot, '.aicode', 'quality', toolName);
  await fsPromises.mkdir(dir, { recursive: true });
  // Both files are replaced atomically: a torn history line is skipped by
  // readers and a torn latest.json is exactly what the panel tries to open.
  await atomicWriteText(pathModule.join(dir, 'latest.json'), JSON.stringify(record, null, 2));
  const historyPath = pathModule.join(dir, 'history.jsonl');
  // Read-modify-write, serialised per file: two gates finishing in the same
  // tick both read the old history and the later write drops the earlier one.
  await serialize(historyPath, async () => {
    let lines = [];
    try {
      const raw = await fsPromises.readFile(historyPath, 'utf8');
      lines = raw.split('\n').filter((line) => line.trim());
    } catch { /* first record */ }
    lines.push(JSON.stringify(record));
    if (lines.length > HISTORY_LIMIT) lines = lines.slice(-HISTORY_LIMIT);
    await atomicWriteText(historyPath, lines.join('\n') + '\n');
  });
}

function createQualityGateway({ cliRoot }) {
  const entry = path.join(cliRoot, 'dist', 'src', 'index.js');
  const fsPromises = require('node:fs/promises');

  async function invoke(toolName, input, workspaceRoot, revision) {
    if (typeof toolName !== 'string' || !ALLOWED_TOOLS.has(toolName)) {
      return {
        ok: false,
        error: 'Tool "' + String(toolName) + '" is not exposed by the quality gateway. ' +
          'Write tools (tests, refactors) must run through the interactive agent approval flow.',
      };
    }
    let payload;
    try { payload = JSON.stringify(input ?? {}); } catch {
      return { ok: false, error: 'Quality tool input must be JSON-serializable' };
    }

    const args = [entry, '--invoke-tool', toolName, '--tool-input', payload, '--quiet'];
    if (workspaceRoot) args.push('--workspace', workspaceRoot);

    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: cliRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ ok: false, error: 'Quality tool "' + toolName + '" timed out after ' + (TIMEOUT_MS / 1000) + 's' });
      }, TIMEOUT_MS);

      child.stdout.on('data', (chunk) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => finish({ ok: false, error: 'Failed to start the CLI tool process: ' + error.message }));
      child.on('close', (code) => {
        // The headless mode prints exactly one JSON line on stdout.
        const line = stdout.trim().split('\n').filter(Boolean).pop();
        if (!line) {
          finish({ ok: false, error: stderr.trim().slice(-MAX_STDERR_CHARS) || ('Quality tool "' + toolName + '" produced no output (exit ' + code + ')') });
          return;
        }
        try {
          const parsed = JSON.parse(line);
          finish(parsed);
        } catch {
          finish({ ok: false, error: 'Unparseable tool output (exit ' + code + '): ' + line.slice(0, 200) });
        }
      });
    });

    // 持久化到 .aicode/quality（best-effort：写失败不影响本次结果返回）。
    try {
      await persistQualityRecord(fsPromises, path, workspaceRoot, toolName, input, revision, result);
    } catch { /* persistence is best-effort */ }
    return result;
  }

  /** 读取某工具最近一次记录；无记录返回 null。 */
  async function latest(toolName, workspaceRoot) {
    if (!workspaceRoot) return null;
    try {
      const raw = await fsPromises.readFile(
        path.join(workspaceRoot, '.aicode', 'quality', String(toolName), 'latest.json'),
        'utf8',
      );
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** 读取某工具最近 limit 条历史（新→旧）。 */
  async function history(toolName, workspaceRoot, limit = 20) {
    if (!workspaceRoot) return [];
    try {
      const raw = await fsPromises.readFile(
        path.join(workspaceRoot, '.aicode', 'quality', String(toolName), 'history.jsonl'),
        'utf8',
      );
      const lines = raw.split('\n').filter((line) => line.trim()).slice(-(Number.isFinite(limit) ? limit : 20));
      const records = [];
      for (const line of lines.reverse()) {
        try { records.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
      }
      return records;
    } catch {
      return [];
    }
  }

  return {
    invoke,
    latest,
    history,
    listTools: () => [...ALLOWED_TOOLS].sort(),
  };
}

module.exports = { createQualityGateway, ALLOWED_TOOLS, persistQualityRecord };
