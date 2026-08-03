import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from './state';

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

  it('creates approval chat items', () => {
    const state = appReducer(initialState, {
      type: 'agent/event',
      event: { type: 'approval_needed', requestId: 'approval_1', tool: 'shell', message: 'Approve shell?', input: { command: 'npm test' } },
    });
    expect(state.chat[0]).toMatchObject({ kind: 'approval', requestId: 'approval_1', tool: 'shell' });
  });
});
