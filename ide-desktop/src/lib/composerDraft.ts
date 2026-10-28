import type { DetectedFile } from './fileDetection';
import type { MentionItem } from '../components/MentionPicker';

export type ComposerDraft = { text: string; files: DetectedFile[]; mentions: MentionItem[]; recoverySource?: string };
export type ComposerSubmission = { scope: string; draft: ComposerDraft };
export type ComposerDraftRecord = ComposerDraft & { sessionId: string | null };
export type ComposerDraftPersistence = {
  load: (root: string) => Promise<ComposerDraftRecord[]>;
  save: (root: string, drafts: ComposerDraftRecord[]) => Promise<unknown>;
  onError?: (root: string, error: unknown) => void;
};
export type ComposerDraftStore = ReturnType<typeof createComposerDraftStore>;

const EMPTY_DRAFT: ComposerDraft = { text: '', files: [], mentions: [] };

function sameSubmission(current: ComposerDraft, submitted: ComposerDraft): boolean {
  const files = (draft: ComposerDraft) => draft.files.map(({ path, name, size, category, mediaType }) => ({ path, name, size, category, mediaType }));
  return current.text === submitted.text && JSON.stringify(files(current)) === JSON.stringify(files(submitted)) && JSON.stringify(current.mentions) === JSON.stringify(submitted.mentions);
}

export function composerDraftScope(workspace: string | undefined, session: string | null): string {
  return JSON.stringify([workspace ?? '', session]);
}

export function createComposerDraftStore(persistence?: ComposerDraftPersistence) {
  const drafts = new Map<string, ComposerDraft>();
  const listeners = new Set<() => void>();
  type RootState = { loaded: boolean; loading: Promise<void>; touched: Set<string>; saveQueued: boolean; error?: string };
  const roots = new Map<string, RootState>();
  const pendingWrites = new Set<Promise<unknown>>();
  const notify = () => { for (const listener of listeners) listener(); };

  function report(root: string, state: RootState, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (state.error !== message) persistence?.onError?.(root, error);
    state.error = message;
  }

  function parseScope(scope: string): [string, string | null] | null {
    try {
      const parsed: unknown = JSON.parse(scope);
      return Array.isArray(parsed) && typeof parsed[0] === 'string' && (parsed[1] === null || typeof parsed[1] === 'string')
        ? [parsed[0], parsed[1]] : null;
    } catch { return null; }
  }

  function snapshot(root: string): ComposerDraftRecord[] {
    const records: ComposerDraftRecord[] = [];
    for (const [scope, draft] of drafts) {
      const owner = parseScope(scope);
      if (!owner || owner[0] !== root) continue;
      records.push({
        sessionId: owner[1], text: draft.text,
        ...(draft.recoverySource ? { recoverySource: draft.recoverySource } : {}),
        files: draft.files.map(({ path, name, size, category, icon, mediaType }) => ({ path, name, size, category, icon, mediaType })),
        mentions: draft.mentions.map(mention => ({ ...mention, ...(mention.content === undefined ? {} : { content: mention.content.slice(-6000) }) })),
      });
    }
    return records;
  }

  function queueSave(root: string, state: RootState) {
    if (!persistence || !state.loaded || state.saveQueued) return;
    state.saveQueued = true;
    queueMicrotask(() => {
      state.saveQueued = false;
      try {
        const saving = persistence.save(root, snapshot(root)).then(() => { state.error = undefined; })
          .catch(error => report(root, state, error)).finally(() => pendingWrites.delete(saving));
        pendingWrites.add(saving);
      } catch (error) { report(root, state, error); }
    });
  }

  function load(root: string): Promise<void> {
    if (!persistence || !root) return Promise.resolve();
    const existing = roots.get(root);
    if (existing) return existing.loading;
    const state: RootState = { loaded: false, loading: Promise.resolve(), touched: new Set(), saveQueued: false };
    roots.set(root, state);
    state.loading = Promise.resolve().then(() => persistence.load(root)).then(records => {
      for (const record of records) {
        const scope = composerDraftScope(root, record.sessionId);
        if (!state.touched.has(scope)) drafts.set(scope, { text: record.text, files: record.files, mentions: record.mentions, ...(record.recoverySource ? { recoverySource: record.recoverySource } : {}) });
      }
      state.loaded = true;
      notify();
      if (state.touched.size) queueSave(root, state);
    }).catch(error => report(root, state, error));
    return state.loading;
  }

  function changed(scope: string) {
    if (!persistence) return;
    const owner = parseScope(scope);
    if (!owner?.[0]) return;
    void load(owner[0]);
    const state = roots.get(owner[0])!;
    state.touched.add(scope);
    queueSave(owner[0], state);
  }

  return {
    load,
    acknowledge(scope: string, submitted: ComposerDraft) {
      if (!sameSubmission(drafts.get(scope) ?? EMPTY_DRAFT, submitted)) return false;
      drafts.delete(scope);
      changed(scope);
      const root = parseScope(scope)?.[0];
      if (submitted.recoverySource && root === parseScope(submitted.recoverySource)?.[0] && sameSubmission(drafts.get(submitted.recoverySource) ?? EMPTY_DRAFT, submitted)) {
        drafts.delete(submitted.recoverySource);
        changed(submitted.recoverySource);
      }
      for (const [key, draft] of drafts) {
        if (draft.recoverySource === scope && sameSubmission(draft, submitted)) {
          drafts.delete(key);
          changed(key);
        }
      }
      notify();
      return true;
    },
    recover(scope: string, destination: string, submitted: ComposerDraft) {
      const original = drafts.get(scope) ?? EMPTY_DRAFT;
      const current = drafts.get(destination) ?? EMPTY_DRAFT;
      if (scope === destination) return sameSubmission(original, submitted);
      if ((current.text || current.files.length || current.mentions.length) && !sameSubmission(current, submitted)) return false;
      const unsentNewChat = parseScope(scope)?.[1] === null;
      drafts.set(destination, unsentNewChat ? { ...submitted, recoverySource: scope } : submitted);
      if (!unsentNewChat && sameSubmission(original, submitted)) drafts.delete(scope);
      notify();
      changed(scope);
      changed(destination);
      return true;
    },
    async flush() {
      await Promise.all([...roots.values()].map(state => state.loading));
      await Promise.resolve();
      while (pendingWrites.size) await Promise.all([...pendingWrites]);
    },
    read(scope: string): ComposerDraft {
      return drafts.get(scope) ?? EMPTY_DRAFT;
    },
    update(scope: string, update: (previous: ComposerDraft) => ComposerDraft) {
      const previous = drafts.get(scope) ?? EMPTY_DRAFT;
      const next = update(previous);
      if (next === previous) return;
      if (next.text || next.files.length || next.mentions.length) drafts.set(scope, next);
      else drafts.delete(scope);
      notify();
      changed(scope);
    },
    clear(scope: string) {
      if (drafts.delete(scope)) notify();
      changed(scope);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
