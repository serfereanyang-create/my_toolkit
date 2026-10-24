import { describe, expect, it } from 'vitest';
import { appReducer, initialState, sessionToChat } from './state';
import { returnedQueueMessages } from './cancelledQueue';
import { decideQueuePump } from './queuePump';
import { turnStatusLabel } from './workProgress';
import { cueForEvent } from './notifySounds';

describe('cancelled conversation queue', () => {
  const event = { type: 'cancel_ack', cancelId: 'cancel-fixture', queued: [{ text: 'first', files: [{ path: 'C:/fixture/context.txt', name: 'context.txt', size: 12 }] }, { text: 'second' }] };
  it('returns messages with their attachments, stable ids and the original order', () => {
    const restored = returnedQueueMessages(event, 'session-a');
    expect(restored.map(message => message.text)).toEqual(['first', 'second']);
    expect(restored[0].files).toEqual([{ path: 'C:/fixture/context.txt', name: 'context.txt', size: 12 }]);
    expect(restored.every(message => message.sessionId === 'session-a')).toBe(true);
    const first = appReducer(initialState, { type: 'queue/restore', messages: restored });
    expect(appReducer(first, { type: 'queue/restore', messages: returnedQueueMessages(event, 'session-a') }).messageQueue).toHaveLength(2);
  });
  it('paused queues cannot run even after turn_done, but another session remains independent', () => {
    const queue = returnedQueueMessages(event, 'session-a');
    const input = { queue, sessionId: 'session-a', bridgeReady: true, sessionRunning: true, sendInFlight: false, justFinished: true };
    expect(decideQueuePump({ ...input, paused: true }).action).toBe('wait');
    expect(decideQueuePump({ ...input, paused: false }).action).toBe('send');
    const state = appReducer({ ...initialState, messageQueue: queue }, { type: 'queue/pause', sessionId: 'session-a' });
    expect(state.queuePausedSessions).toEqual(['session-a']);
    expect(state.queuePausedSessions?.includes('session-b')).toBe(false);
  });
  it('binding and resuming a cancelled startup does not leave an orphan pause flag', () => {
    const paused = appReducer(initialState, { type: 'queue/pause', sessionId: '' });
    const bound = appReducer(paused, { type: 'agent/bind', sessionId: 'session-a' });
    expect(bound.queuePausedSessions).toEqual(['session-a']);
    expect(appReducer(bound, { type: 'queue/resume', sessionId: 'session-a' }).queuePausedSessions).toEqual([]);
    const afterBind = appReducer(bound, { type: 'queue/pause', sessionId: '' });
    expect(afterBind.queuePausedSessions).toEqual(['session-a']);
  });
  it('rejects malformed returned payloads without losing valid text', () => {
    expect(returnedQueueMessages({ type: 'cancel_ack', cancelId: 'id', queued: [null, 'invalid', { text: 'valid', files: [{ path: '' }, { path: 'src/file.ts' }] }] }, 'session-a')[0].files).toEqual([{ path: 'src/file.ts', name: 'file.ts', size: 0 }]);
  });
  it('late hydration adopts draft ownership and preserves edits made while loading', () => {
    const restored = returnedQueueMessages(event, '');
    const live = { ...restored[0], text: 'edited while loading', sessionId: 'session-a' };
    const state = appReducer({ ...initialState, activeSessionId: 'session-a', messageQueue: [live] }, { type: 'queue/hydrate', messages: restored, pausedSessions: [''] });
    expect(state.messageQueue.map(message => message.text)).toEqual(['edited while loading', 'second']);
    expect(state.messageQueue.every(message => message.sessionId === 'session-a')).toBe(true);
    expect(state.queuePausedSessions).toEqual(['session-a']);
  });
});

describe('cancelled transcript', () => {
  it('restores a task label while preserving the separate model prompt field', () => {
    const message = { role: 'user', content: 'Internal board instructions and expert role', displayText: '执行任务：检查源码' };
    const chat = sessionToChat({ messages: [message] });
    expect(chat[0]).toMatchObject({ kind: 'user', text: '执行任务：检查源码' });
    expect(message.content).toBe('Internal board instructions and expert role');
    expect(sessionToChat({ messages: [{ role: 'user', content: 'legacy question' }] })[0]).toMatchObject({ text: 'legacy question' });
  });
  it('keeps the partial visible reply without appending a duplicate or an error', () => {
    let state = appReducer(initialState, { type: 'agent/bind', sessionId: 'session-a' });
    state = appReducer(state, { type: 'agent/event', event: { type: 'turn_start', sessionId: 'session-a' } });
    state = appReducer(state, { type: 'agent/event', event: { type: 'assistant_delta', text: 'partial reply', sessionId: 'session-a' } });
    state = appReducer(state, { type: 'agent/event', event: { type: 'turn_done', status: 'cancelled', cancelledReply: 'partial reply\n\n（本轮已停止。）', sessionId: 'session-a' } });
    expect(state.chat.filter(item => item.kind === 'assistant')).toHaveLength(1);
    expect(state.chat.some(item => item.kind === 'error')).toBe(false);
    expect(state.agentStatus).toBe('ready');
    expect(cueForEvent({ type: 'turn_done', status: 'cancelled', producedActivity: true })).toBeNull();
  });
  it('marks interrupted tool rounds as stopped after session restore', () => {
    const chat = sessionToChat({ messages: [{ role: 'user', content: 'task' }, { role: 'tool', name: 'run_command', content: 'partial output' }, { role: 'assistant', content: '本轮已停止', interrupted: true }], toolCalls: [{ tool: 'run_command', ok: false }] });
    const turn = chat.find(item => item.kind === 'turn');
    expect(turn?.kind === 'turn' && turn.cancelled).toBe(true);
    expect(turnStatusLabel([], false, true)).toBe('已停止');
  });
});
