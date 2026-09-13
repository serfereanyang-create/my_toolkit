import { describe, expect, it } from 'vitest';
import { appReducer, initialState, sessionChangeTotals, activeTurnProgress } from './state';

describe('appReducer', () => {
  it('opens a workspace', () => {
    const state = appReducer(initialState, { type: 'workspace/opened', root: 'C:/work/app' });
    expect(state.workspaceRoot).toBe('C:/work/app');
    expect(state.agentStatus).toBe('offline');
  });

  it('appends assistant deltas to the active assistant message', () => {
    const one = appReducer(initialState, { type: 'agent/event', event: { type: 'assistant_delta', text: 'Hel' } });
    const two = appReducer(one, { type: 'agent/event', event: { type: 'assistant_delta', text: 'lo' } });
    expect(two.chat).toEqual([{ id: 'assistant-live', kind: 'assistant', text: 'Hello' }]);
  });

  it('finalizes a streamed reply in place instead of duplicating it', () => {
    // The CLI streams deltas into an `assistant-live` bubble, then emits one
    // complete `assistant_message`. The final event must promote the live
    // bubble in place — not append a second copy of the same text.
    let s = appReducer(initialState, { type: 'agent/event', event: { type: 'assistant_delta', text: 'Hel' } });
    s = appReducer(s, { type: 'agent/event', event: { type: 'assistant_delta', text: 'lo world' } });
    s = appReducer(s, { type: 'agent/event', event: { type: 'assistant_message', text: 'Hello world' } });
    const assistants = s.chat.filter((item) => item.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].text).toBe('Hello world');
    // The finalized bubble must lose the transient live id so it is stable.
    expect(assistants[0].id).not.toBe('assistant-live');
  });

  it('keeps the streamed text when the final message arrives empty', () => {
    let s = appReducer(initialState, { type: 'agent/event', event: { type: 'assistant_delta', text: 'streamed answer' } });
    s = appReducer(s, { type: 'agent/event', event: { type: 'assistant_message', text: '' } });
    const assistants = s.chat.filter((item) => item.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].text).toBe('streamed answer');
  });

  it('appends a non-streamed final message fresh', () => {
    // Non-streaming provider: no live bubble exists, so the message stands alone.
    const s = appReducer(initialState, { type: 'agent/event', event: { type: 'assistant_message', text: 'direct reply' } });
    const assistants = s.chat.filter((item) => item.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].text).toBe('direct reply');
  });

  it('creates approval chat items', () => {
    const state = appReducer(initialState, {
      type: 'agent/event',
      event: { type: 'approval_needed', requestId: 'approval_1', tool: 'shell', message: 'Approve shell?', input: { command: 'npm test' } },
    });
    expect(state.chat[0]).toMatchObject({ kind: 'approval', requestId: 'approval_1', tool: 'shell' });
  });

  it('loads a session into chat and tracks the active session id', () => {
    const chat = [
      { id: 'u1', kind: 'user' as const, text: 'hi' },
      { id: 'a1', kind: 'assistant' as const, text: 'hello' },
    ];
    const state = appReducer(initialState, { type: 'chat/load', sessionId: 'sess_x', chat });
    expect(state.activeSessionId).toBe('sess_x');
    expect(state.chat).toHaveLength(2);
    // Opening a past session must detach the running agent so the next prompt resumes it.
    expect(state.agentStatus).toBe('offline');
  });

  it('clears chat and drops the active session id + agent', () => {
    const loaded = appReducer(initialState, {
      type: 'chat/load',
      sessionId: 'sess_x',
      chat: [{ id: 'u1', kind: 'user', text: 'hi' }],
    });
    const cleared = appReducer(loaded, { type: 'chat/clear' });
    expect(cleared.activeSessionId).toBeNull();
    expect(cleared.chat).toEqual([]);
    expect(cleared.agentStatus).toBe('offline');
  });

  const emit = (state: ReturnType<typeof appReducer>, event: Record<string, unknown>) =>
    appReducer(state, { type: 'agent/event', event: event as never });

  it('groups tool steps into one turn and sums real diff line counts', () => {
    let s = emit(initialState, { type: 'turn_start' });
    expect(s.agentStatus).toBe('running');
    s = emit(s, { type: 'tool_start', tool: 'write_file', input: { path: 'a.ts' } });
    s = emit(s, { type: 'tool_result', tool: 'write_file', ok: true, output: 'Wrote a.ts', data: { added: 10, removed: 2 } });
    s = emit(s, { type: 'tool_start', tool: 'apply_patch', input: { path: 'b.ts' } });
    s = emit(s, { type: 'tool_result', tool: 'apply_patch', ok: true, output: 'Patched b.ts', data: { added: 5, removed: 1 } });
    s = emit(s, { type: 'turn_done' });

    expect(s.agentStatus).toBe('ready');
    const turns = s.chat.filter((item) => item.kind === 'turn');
    expect(turns).toHaveLength(1);
    const turn = turns[0];
    if (turn.kind !== 'turn') throw new Error('expected a turn');
    expect(turn.steps).toHaveLength(2);
    expect(turn.added).toBe(15);
    expect(turn.removed).toBe(3);
    expect(turn.endedAt).toBeGreaterThanOrEqual(turn.startedAt);
    expect(turn.steps.every((step) => step.status === 'done')).toBe(true);
  });

  it('drops an empty turn that ran no tools (pure chat reply)', () => {
    let s = emit(initialState, { type: 'turn_start' });
    s = emit(s, { type: 'assistant_message', text: 'hi there' });
    s = emit(s, { type: 'turn_done' });
    expect(s.chat.some((item) => item.kind === 'turn')).toBe(false);
    expect(s.chat.filter((item) => item.kind === 'assistant')).toHaveLength(1);
  });

  it('marks an approval card as decided so its buttons disable', () => {
    let s = emit(initialState, { type: 'approval_needed', requestId: 'approval_1', tool: 'write_file', message: 'Approve write?', input: { path: 'note.md' } });
    s = appReducer(s, { type: 'approval/decided', requestId: 'approval_1', decision: 'allow_once' });
    const card = s.chat.find((item) => item.kind === 'approval');
    if (card?.kind !== 'approval') throw new Error('expected approval card');
    expect(card.decided).toBe('allow_once');
  });

  it('sandbox auto-decided approvals arrive already decided with their reason', () => {
    const s = emit(initialState, {
      type: 'approval_needed', requestId: 'auto-1', tool: 'write_file', risk: 'write',
      message: 'allow?', input: { path: 'C:/Windows/x.dll' },
      autoDecision: 'deny', autoReason: '沙箱拦截：写入目标在工作区之外',
      diff: { path: 'C:/Windows/x.dll', originalContent: '', modifiedContent: 'x' },
    });
    const card = s.chat.find((item) => item.kind === 'approval');
    if (card?.kind !== 'approval') throw new Error('expected approval card');
    expect(card.decided).toBe('deny');
    expect(card.autoReason).toBe('沙箱拦截：写入目标在工作区之外');
    expect(card.diff?.status).toBe('rejected');
    expect(s.pendingDiffs.find((d) => d.id === 'auto-1')?.status).toBe('rejected');
  });

  it('sandbox auto-allow folds without a diff and stays decided', () => {
    const s = emit(initialState, {
      type: 'approval_needed', requestId: 'auto-2', tool: 'read_file', risk: 'read',
      message: 'allow?', input: { path: 'a.ts' },
      autoDecision: 'allow_once', autoReason: '沙箱 strict 模式：自动批准只读操作',
    });
    const card = s.chat.find((item) => item.kind === 'approval');
    if (card?.kind !== 'approval') throw new Error('expected approval card');
    expect(card.decided).toBe('allow_once');
    expect(card.diff).toBeUndefined();
  });

  it('compaction started appends a running divider, completed flips it in place', () => {
    let s = emit(initialState, { type: 'context_compaction', phase: 'started', auto: true, before: 42 });
    const rows = s.chat.filter((item) => item.kind === 'compaction');
    expect(rows).toHaveLength(1);
    expect(rows[0].kind === 'compaction' && rows[0].phase).toBe('running');
    s = emit(s, { type: 'context_compaction', phase: 'completed', auto: true, before: 42, after: 3 });
    const after = s.chat.filter((item) => item.kind === 'compaction');
    expect(after).toHaveLength(1);
    expect(after[0].kind === 'compaction' && after[0].phase).toBe('done');
    expect(after[0].kind === 'compaction' && after[0].after).toBe(3);
    // The work log records the outcome for the details panel.
    expect(s.workLog.some((e) => e.title === '上下文已自动压缩')).toBe(true);
  });

  it('manual /compact divider says 已压缩 (not 自动), and failure flips to failed', () => {
    let s = emit(initialState, { type: 'context_compaction', phase: 'started', auto: false, before: 30 });
    s = emit(s, { type: 'context_compaction', phase: 'failed', auto: false, reason: 'provider exploded' });
    const row = s.chat.find((item) => item.kind === 'compaction');
    expect(row?.kind === 'compaction' && row.phase).toBe('failed');
    expect(row?.kind === 'compaction' && row.reason).toBe('provider exploded');
    expect(s.workLog.some((e) => e.title === '上下文压缩失败')).toBe(true);
  });

  it('a completed event without a prior started still appends a done row', () => {
    const s = emit(initialState, { type: 'context_compaction', phase: 'completed', auto: true, before: 40, after: 3 });
    const row = s.chat.find((item) => item.kind === 'compaction');
    expect(row?.kind === 'compaction' && row.phase).toBe('done');
  });

  const statsEvent = (inputTokens: number, cacheRead: number, reported = true) => ({
    type: 'context_stats', provider: 'p', model: 'm',
    inputTokens, outputTokens: 800,
    providerCacheReported: reported, cacheReadTokens: cacheRead, cacheCreationTokens: 0,
    predictedPromptCacheRate: null,
    categories: { messages: 1, systemTools: 1, mcpTools: 0, skills: 0, systemPrompt: 1, other: 0 },
    localCache: { totalHits: 0, totalMisses: 0, totalLookups: 0, hitRate: null, buckets: [] },
  });

  it('stamps per-turn ctx/cache numbers onto the running turn (Codex footer)', () => {
    let s = emit(initialState, { type: 'turn_start' });
    s = emit(s, { type: 'tool_start', tool: 'read_file', input: { path: 'a.ts' } });
    s = emit(s, statsEvent(14200, 13206));
    const turn = s.chat.find((item) => item.kind === 'turn');
    if (!turn || turn.kind !== 'turn') throw new Error('expected a turn');
    expect(turn.ctxTokens).toBe(14200);
    expect(turn.cacheRate).toBe(93);
    expect(s.contextStats?.inputTokens).toBe(14200);
  });

  it('omits cache rate when the provider never reported cache metrics', () => {
    let s = emit(initialState, { type: 'turn_start' });
    s = emit(s, statsEvent(900, 0, false));
    const turn = s.chat.find((item) => item.kind === 'turn');
    if (!turn || turn.kind !== 'turn') throw new Error('expected a turn');
    expect(turn.ctxTokens).toBe(900);
    expect(turn.cacheRate).toBeNull();
  });

  it('never stamps a finished turn with a later snapshot', () => {
    let s = emit(initialState, { type: 'turn_start' });
    s = emit(s, { type: 'tool_start', tool: 'read_file', input: { path: 'a.ts' } });
    s = emit(s, statsEvent(1000, 900));
    s = emit(s, { type: 'turn_done' });
    s = emit(s, statsEvent(9999, 0));
    const turn = s.chat.find((item) => item.kind === 'turn');
    if (!turn || turn.kind !== 'turn') throw new Error('expected a turn');
    expect(turn.ctxTokens).toBe(1000);
    expect(s.contextStats?.inputTokens).toBe(9999);
  });

  it('sums session-wide change totals across turns for the topbar badge', () => {
    let s = emit(initialState, { type: 'turn_start' });
    s = emit(s, { type: 'tool_start', tool: 'write_file', input: { path: 'a.ts' } });
    s = emit(s, { type: 'tool_result', tool: 'write_file', ok: true, output: 'ok', data: { added: 10, removed: 2 } });
    s = emit(s, { type: 'turn_done' });
    s = emit(s, { type: 'turn_start' });
    s = emit(s, { type: 'tool_start', tool: 'apply_patch', input: { path: 'b.ts' } });
    s = emit(s, { type: 'tool_result', tool: 'apply_patch', ok: true, output: 'ok', data: { added: 5, removed: 3 } });
    s = emit(s, { type: 'turn_done' });
    expect(sessionChangeTotals(s.chat)).toEqual({ added: 15, removed: 5 });
  });

  it('returns null session change totals when nothing was written', () => {
    let s = emit(initialState, { type: 'turn_start' });
    s = emit(s, { type: 'assistant_message', text: 'hi' });
    s = emit(s, { type: 'turn_done' });
    expect(sessionChangeTotals(s.chat)).toBeNull();
  });

  it('matches a tool_result to its running step without diff data', () => {
    let s = emit(initialState, { type: 'turn_start' });
    s = emit(s, { type: 'tool_start', tool: 'shell', input: { command: 'ls' } });
    s = emit(s, { type: 'tool_result', tool: 'shell', ok: true, output: 'files' });
    s = emit(s, { type: 'turn_done' });
    const turn = s.chat.find((item) => item.kind === 'turn');
    if (turn?.kind !== 'turn') throw new Error('expected a turn');
    expect(turn.added).toBe(0);
    expect(turn.removed).toBe(0);
    expect(turn.steps[0]).toMatchObject({ tool: 'shell', status: 'done', output: 'files' });
  });

  it('collects distinct changed files with checkpoint ids, merging repeat writes', () => {
    let s = emit(initialState, { type: 'turn_start' });
    // Two writes to the same file plus one to another: the summary shows 2
    // distinct files, and the repeated file merges its line counts + ids.
    s = emit(s, { type: 'tool_start', tool: 'write_file', input: { path: 'a.ts' } });
    s = emit(s, { type: 'tool_result', tool: 'write_file', ok: true, data: { path: 'a.ts', added: 10, removed: 2, checkpointId: 'cp_a1' } });
    s = emit(s, { type: 'tool_start', tool: 'write_file', input: { path: 'a.ts' } });
    s = emit(s, { type: 'tool_result', tool: 'write_file', ok: true, data: { path: 'a.ts', added: 3, removed: 1, checkpointId: 'cp_a2' } });
    s = emit(s, { type: 'tool_start', tool: 'write_file', input: { path: 'b.ts' } });
    s = emit(s, { type: 'tool_result', tool: 'write_file', ok: true, data: { path: 'b.ts', added: 5, removed: 0, checkpointId: 'cp_b1' } });
    s = emit(s, { type: 'turn_done' });
    const turn = s.chat.find((item) => item.kind === 'turn');
    if (turn?.kind !== 'turn') throw new Error('expected a turn');
    expect(turn.files).toHaveLength(2);
    const a = turn.files.find((f) => f.path === 'a.ts')!;
    expect(a.added).toBe(13);
    expect(a.removed).toBe(3);
    expect(a.checkpointIds).toEqual(['cp_a1', 'cp_a2']);
    expect(turn.added).toBe(18);
    expect(turn.removed).toBe(3);
  });

  it('reflects the undo lifecycle on the matching turn', () => {
    let s = emit(initialState, { type: 'turn_start' });
    s = emit(s, { type: 'tool_start', tool: 'write_file', input: { path: 'a.ts' } });
    s = emit(s, { type: 'tool_result', tool: 'write_file', ok: true, data: { path: 'a.ts', added: 4, removed: 0, checkpointId: 'cp_1' } });
    s = emit(s, { type: 'turn_done' });
    const turnId = s.chat.find((item) => item.kind === 'turn')!.id;

    s = appReducer(s, { type: 'turn/undo-state', turnId, undo: 'undoing' });
    let turn = s.chat.find((item) => item.id === turnId);
    if (turn?.kind !== 'turn') throw new Error('expected a turn');
    expect(turn.undo).toBe('undoing');

    s = appReducer(s, { type: 'turn/undo-state', turnId, undo: 'undone' });
    turn = s.chat.find((item) => item.id === turnId);
    if (turn?.kind !== 'turn') throw new Error('expected a turn');
    expect(turn.undo).toBe('undone');
  });
});

describe('activeTurnProgress', () => {
  it('returns null when agent is ready but not running', () => {
    const state = { ...initialState, agentStatus: 'ready' as const };
    expect(activeTurnProgress(state)).toBeNull();
  });

  it('returns null when agent is running but no active turn', () => {
    const state = { ...initialState, agentStatus: 'running' as const };
    expect(activeTurnProgress(state)).toBeNull();
  });

  it('returns progress data when agent is running with an active turn', () => {
    let s = appReducer(initialState, { type: 'agent/event', event: { type: 'turn_start' } });
    s = { ...s, agentStatus: 'running' as const };
    s = appReducer(s, { type: 'agent/event', event: { type: 'tool_start', tool: 'write_file', input: { path: 'a.ts' } } });
    s = { ...s, agentStatus: 'running' as const };
    s = appReducer(s, { type: 'agent/event', event: { type: 'tool_result', tool: 'write_file', ok: true, data: { added: 10, removed: 2 } } });
    s = { ...s, agentStatus: 'running' as const };
    
    const progress = activeTurnProgress(s);
    expect(progress).not.toBeNull();
    expect(progress?.stepCount).toBe(1);
    expect(progress?.added).toBe(10);
    expect(progress?.removed).toBe(2);
    expect(progress?.lastTool).toBe('write_file');
    expect(progress?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('tracks cumulative changes across multiple tools', () => {
    let s = appReducer(initialState, { type: 'agent/event', event: { type: 'turn_start' } });
    s = { ...s, agentStatus: 'running' as const };
    s = appReducer(s, { type: 'agent/event', event: { type: 'tool_start', tool: 'write_file', input: { path: 'a.ts' } } });
    s = { ...s, agentStatus: 'running' as const };
    s = appReducer(s, { type: 'agent/event', event: { type: 'tool_result', tool: 'write_file', ok: true, data: { added: 5, removed: 1 } } });
    s = { ...s, agentStatus: 'running' as const };
    s = appReducer(s, { type: 'agent/event', event: { type: 'tool_start', tool: 'edit_file', input: { path: 'b.ts' } } });
    s = { ...s, agentStatus: 'running' as const };
    s = appReducer(s, { type: 'agent/event', event: { type: 'tool_result', tool: 'edit_file', ok: true, data: { added: 3, removed: 2 } } });
    s = { ...s, agentStatus: 'running' as const };
    
    const progress = activeTurnProgress(s);
    expect(progress?.stepCount).toBe(2);
    expect(progress?.added).toBe(8);
    expect(progress?.removed).toBe(3);
    expect(progress?.lastTool).toBe('edit_file');
  });
});

// ─── P0 execution-overhaul: lifecycle reducer guarantees ─────────────────────

describe('agent event lifecycle (P0)', () => {
  it('duplicate turn_start for an open turn keeps the workLog', () => {
    let s = appReducer(initialState, { type: 'agent/event', event: { type: 'turn_start' } });
    s = appReducer(s, { type: 'agent/event', event: { type: 'info', message: 'step one happened' } });
    const logLen = s.workLog.length;
    expect(logLen).toBeGreaterThan(0);

    // The CLI emits a second turn_start from inside runAgentTurn for the same
    // bridge turn; it must not wipe the log the first one started filling.
    s = appReducer(s, { type: 'agent/event', event: { type: 'turn_start' } });
    expect(s.workLog.length).toBe(logLen);
    expect(s.chat.filter((item) => item.kind === 'turn')).toHaveLength(1);
  });

  it('agent_offline closes the open turn, denies undecided approvals and clears pendingDiffs', () => {
    let s = appReducer(initialState, { type: 'agent/event', event: { type: 'turn_start' } });
    s = appReducer(s, { type: 'agent/event', event: { type: 'tool_start', tool: 'write_file', input: { path: 'a.ts' } } });
    s = appReducer(s, {
      type: 'agent/event',
      event: { type: 'approval_needed', requestId: 'req-1', tool: 'write_file', message: 'allow?', diff: { path: 'a.ts', originalContent: '', modifiedContent: 'new' } },
    });
    expect(s.pendingDiffs).toHaveLength(1);

    s = appReducer(s, { type: 'agent/event', event: { type: 'agent_offline', code: 1 } });
    // The dead bridge can never answer approvals; undecided ones are denied.
    const approvals = s.chat.filter((item) => item.kind === 'approval');
    expect(approvals).toHaveLength(1);
    expect(approvals[0].decided).toBe('deny');
    expect(approvals[0].diff?.status).toBe('rejected');
    expect(s.pendingDiffs).toHaveLength(0);
    // Zombie turn closed, status offline.
    expect(s.chat.filter((item) => item.kind === 'turn' && item.endedAt === undefined)).toHaveLength(0);
    expect(s.agentStatus).toBe('offline');
  });

  it('undo_done flips the requesting turn card by undoId', () => {
    let s = appReducer(initialState, { type: 'agent/event', event: { type: 'turn_start' } });
    s = appReducer(s, { type: 'agent/event', event: { type: 'tool_result', tool: 'write_file', ok: true, data: { path: 'a.ts', added: 3, removed: 0, checkpointId: 'cp-1' } } });
    s = appReducer(s, { type: 'agent/event', event: { type: 'turn_done', status: 'ok' } });
    const turn = s.chat.find((item) => item.kind === 'turn');
    expect(turn).toBeDefined();

    s = appReducer(s, { type: 'turn/undo-state', turnId: turn!.id, undo: 'undoing' });
    // IPC ack already said ok — but the authoritative undo_done says failed.
    s = appReducer(s, { type: 'agent/event', event: { type: 'undo_done', undoId: turn!.id, ok: false, reverted: 0 } });
    expect(s.chat.find((item) => item.kind === 'turn')?.undo).toBe('failed');

    s = appReducer(s, { type: 'agent/event', event: { type: 'undo_done', undoId: 'does-not-match', ok: true } });
    expect(s.chat.find((item) => item.kind === 'turn')?.undo).toBe('failed');
  });

  it('bridge_ready transitions a starting bridge to ready and records its session', () => {
    let s = appReducer(initialState, { type: 'agent/status', status: 'starting' });
    s = appReducer(s, { type: 'agent/event', event: { type: 'bridge_ready', sessionId: 'sess-1', provider: 'mock', model: 'm' } });
    expect(s.agentStatus).toBe('ready');
    expect(s.activeSessionId).toBe('sess-1');
  });

  it('error events do not force agentStatus back to ready', () => {
    let s = appReducer(initialState, { type: 'agent/status', status: 'running' });
    s = appReducer(s, { type: 'agent/event', event: { type: 'error', message: 'provider exploded' } });
    // A mid-turn error must not claim the bridge is ready; the turn lifecycle
    // (turn_done / agent_offline) owns the status transitions.
    expect(s.agentStatus).toBe('running');
  });
});
