import { describe, expect, it, vi } from 'vitest';
import { composerDraftScope, createComposerDraftStore, type ComposerDraftRecord } from './composerDraft';

describe('composer draft ownership', () => {
  it('acknowledges only the sent snapshot and never clears edits typed during delivery', () => {
    const store = createComposerDraftStore();
    store.update('scope', draft => ({ ...draft, text: 'sent text' }));
    const submitted = store.read('scope');
    store.update('scope', draft => ({ ...draft, text: 'new unsent text' }));
    expect(store.acknowledge('scope', submitted)).toBe(false);
    expect(store.read('scope').text).toBe('new unsent text');
    expect(store.acknowledge('scope', store.read('scope'))).toBe(true);
    expect(store.read('scope').text).toBe('');
  });

  it('recovers an unaccepted new chat to its assigned conversation with files and references', () => {
    const store = createComposerDraftStore();
    const origin = composerDraftScope('C:\\project', null);
    const assigned = composerDraftScope('C:\\project', 'assigned-session');
    store.update(origin, draft => ({ ...draft, text: 'not delivered', mentions: [{ id: 'url:example', label: 'example', type: 'url', path: 'https://example.invalid' }] }));
    const submitted = store.read(origin);
    expect(store.recover(origin, assigned, submitted)).toBe(true);
    expect(store.read(assigned)).toMatchObject({ ...submitted, recoverySource: origin });
    expect(store.read(origin).text).toBe('not delivered');
    expect(store.acknowledge(assigned, store.read(assigned))).toBe(true);
    expect(store.read(origin).text).toBe('');
    expect(store.read(assigned).text).toBe('');
  });

  it('refuses to overwrite a newer draft and leaves the failed snapshot available for paused queue recovery', () => {
    const store = createComposerDraftStore();
    store.update('origin', draft => ({ ...draft, text: 'failed submission' }));
    const submitted = store.read('origin');
    store.update('assigned', draft => ({ ...draft, text: 'newer input' }));
    expect(store.recover('origin', 'assigned', submitted)).toBe(false);
    expect(store.read('assigned').text).toBe('newer input');
    expect(store.read('origin').text).toBe('failed submission');
    store.update('origin', draft => ({ ...draft, text: 'edited original' }));
    expect(store.recover('origin', 'origin', submitted)).toBe(false);
  });

  it('ignores regenerated thumbnails when acknowledging delivery', () => {
    const store = createComposerDraftStore();
    store.update('scope', draft => ({ ...draft, text: 'sent', files: [{ path: 'shot.png', name: 'shot.png', size: 71, category: 'image', icon: 'image' }] }));
    const submitted = store.read('scope');
    store.update('scope', draft => ({ ...draft, files: draft.files.map(file => ({ ...file, preview: 'data:image/png;base64,generated', mtimeMs: 100 })) }));
    expect(store.acknowledge('scope', submitted)).toBe(true);
  });

  it('acknowledges a restarted new-chat recovery without leaving an orphaned duplicate', async () => {
    const root = 'C:\\project';
    const origin = composerDraftScope(root, null);
    const assigned = composerDraftScope(root, 'unaccepted-session');
    const original = createComposerDraftStore();
    original.update(origin, draft => ({ ...draft, text: 'retry this draft' }));
    original.recover(origin, assigned, original.read(origin));
    const restored = createComposerDraftStore({
      load: async () => [
        { sessionId: null, ...original.read(origin) },
        { sessionId: 'unaccepted-session', ...original.read(assigned) },
      ],
      save: async () => undefined,
    });
    await restored.load(root);
    expect(restored.acknowledge(origin, restored.read(origin))).toBe(true);
    expect(restored.read(origin).text).toBe('');
    expect(restored.read(assigned).text).toBe('');
  });
  it('keeps text, attachments and reference snapshots together across navigation', () => {
    const store = createComposerDraftStore();
    const scope = composerDraftScope('C:\\project', 'session-a');
    store.update(scope, () => ({
      text: '请检查 @终端输出',
      files: [{ path: 'src/a.ts', name: 'a.ts', size: 12, category: 'code', icon: 'code' }],
      mentions: [{ id: 'terminal:current', type: 'terminal', label: '终端输出', content: 'captured output' }],
    }));
    const snapshot = store.read(scope);
    expect(store.read(composerDraftScope('C:\\project', 'session-a'))).toBe(snapshot);
    expect(snapshot.files[0]?.path).toBe('src/a.ts');
    expect(snapshot.mentions[0]?.content).toBe('captured output');
  });

  it('separates workspaces, conversations and unsent new conversations', () => {
    const store = createComposerDraftStore();
    const scopes = [
      composerDraftScope('C:\\first', 'same-session'),
      composerDraftScope('C:\\second', 'same-session'),
      composerDraftScope('C:\\first', 'other-session'),
      composerDraftScope('C:\\first', null),
    ];
    scopes.forEach((scope, index) => store.update(scope, draft => ({ ...draft, text: `draft-${index}` })));
    expect(scopes.map(scope => store.read(scope).text)).toEqual(['draft-0', 'draft-1', 'draft-2', 'draft-3']);
  });

  it('accepts a late asynchronous attachment only in its original scope', async () => {
    const store = createComposerDraftStore();
    const original = composerDraftScope('C:\\project', 'original');
    const current = composerDraftScope('C:\\project', 'current');
    const pending = Promise.resolve().then(() => store.update(original, draft => ({
      ...draft,
      files: [{ path: 'late.txt', name: 'late.txt', size: 1, category: 'document', icon: 'file' }],
    })));
    store.update(current, draft => ({ ...draft, text: 'current draft' }));
    await pending;
    expect(store.read(current).files).toEqual([]);
    expect(store.read(current).text).toBe('current draft');
    expect(store.read(original).files[0]?.name).toBe('late.txt');
  });

  it('clears only the submitted draft and stops notifying detached subscribers', () => {
    const store = createComposerDraftStore();
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);
    store.update('first', draft => ({ ...draft, text: 'first' }));
    store.update('second', draft => ({ ...draft, text: 'second' }));
    store.clear('first');
    expect(store.read('first')).toMatchObject({ text: '', files: [], mentions: [] });
    expect(store.read('second').text).toBe('second');
    expect(notify).toHaveBeenCalledTimes(3);
    unsubscribe();
    store.clear('second');
    expect(notify).toHaveBeenCalledTimes(3);
  });
});

describe('composer durable recovery', () => {
  const root = 'C:\\project';
  const record = (sessionId: string | null, text: string): ComposerDraftRecord => ({ sessionId, text, files: [], mentions: [] });

  it('merges delayed disk data while preserving new typing and explicit local clearing', async () => {
    let finish!: (records: ComposerDraftRecord[]) => void;
    const delayed = new Promise<ComposerDraftRecord[]>(resolve => { finish = resolve; });
    const save = vi.fn(async (_root: string, _records: ComposerDraftRecord[]) => undefined);
    const store = createComposerDraftStore({ load: () => delayed, save });
    const loading = store.load(root);
    const edited = composerDraftScope(root, 'edited');
    const cleared = composerDraftScope(root, 'cleared');
    store.update(edited, draft => ({ ...draft, text: 'new typing before disk returns' }));
    store.clear(cleared);
    finish([record('edited', 'stale disk text'), record('cleared', 'must not reappear'), record('untouched', 'restored disk draft')]);
    await loading;
    await store.flush();
    expect(store.read(edited).text).toBe('new typing before disk returns');
    expect(store.read(cleared).text).toBe('');
    expect(store.read(composerDraftScope(root, 'untouched')).text).toBe('restored disk draft');
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1].map(draft => draft.text)).toEqual(['new typing before disk returns', 'restored disk draft']);
  });

  it('does not write over a failed load and keeps local editing usable', async () => {
    const onError = vi.fn();
    const save = vi.fn(async () => undefined);
    const load = vi.fn(async (): Promise<ComposerDraftRecord[]> => { throw new Error('corrupt file'); });
    const store = createComposerDraftStore({ load, save, onError });
    const scope = composerDraftScope(root, null);
    await store.load(root);
    store.update(scope, draft => ({ ...draft, text: 'retained in this window' }));
    await store.flush();
    expect(store.read(scope).text).toBe('retained in this window');
    expect(save).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('writes a complete workspace snapshot without thumbnail bytes and deletes submitted drafts', async () => {
    const save = vi.fn(async (_root: string, _records: ComposerDraftRecord[]) => undefined);
    const store = createComposerDraftStore({ load: async () => [], save });
    await store.load(root);
    const scope = composerDraftScope(root, null);
    store.update(scope, draft => ({
      ...draft, text: 'persist me',
      files: [{ path: 'shot.png', name: 'shot.png', size: 71, category: 'image', icon: 'image', preview: 'data:image/png;base64,transient' }],
    }));
    await store.flush();
    expect(save.mock.calls[0]?.[1][0]?.files[0]?.preview).toBeUndefined();
    expect(store.read(scope).files[0]?.preview).toContain('data:image/png');
    store.clear(scope);
    await store.flush();
    expect(save.mock.calls.at(-1)?.[1]).toEqual([]);
  });

  it('workspace switching cannot mix snapshots even when saves are concurrent', async () => {
    const save = vi.fn(async (_root: string, _records: ComposerDraftRecord[]) => undefined);
    const store = createComposerDraftStore({ load: async () => [], save });
    const other = 'D:\\other';
    await Promise.all([store.load(root), store.load(other)]);
    store.update(composerDraftScope(root, 'session'), draft => ({ ...draft, text: 'first workspace' }));
    store.update(composerDraftScope(other, 'session'), draft => ({ ...draft, text: 'second workspace' }));
    await store.flush();
    expect(save.mock.calls.map(([workspace, records]) => [workspace, records.map(draft => draft.text)])).toEqual([
      [root, ['first workspace']], [other, ['second workspace']],
    ]);
  });
});
