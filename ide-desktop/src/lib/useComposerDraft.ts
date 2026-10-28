import { useEffect, useRef, useSyncExternalStore, type SetStateAction } from 'react';
import { createComposerDraftStore, type ComposerDraft, type ComposerDraftStore } from './composerDraft';
import { refreshAttachments } from './attachmentValidation';

export function useComposerDraft(scope: string, providedStore?: ComposerDraftStore) {
  const fallback = useRef<ComposerDraftStore | null>(null);
  if (!fallback.current) fallback.current = providedStore ?? createComposerDraftStore();
  const store = providedStore ?? fallback.current;
  const draft = useSyncExternalStore(store.subscribe, () => store.read(scope), () => store.read(scope));
  const attachmentPaths = JSON.stringify(draft.files.map(file => file.path));
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const files = store.read(scope).files;
      if (!files.length) return;
      const refreshed = await refreshAttachments(files);
      if (cancelled || refreshed === files) return;
      store.update(scope, current => current.files === files ? { ...current, files: refreshed } : current);
    };
    void check();
    window.addEventListener('focus', check);
    return () => { cancelled = true; window.removeEventListener('focus', check); };
  }, [attachmentPaths, scope, store]);

  function updateField<Field extends keyof ComposerDraft>(field: Field, update: SetStateAction<ComposerDraft[Field]>) {
    store.update(scope, previous => {
      const next = typeof update === 'function'
        ? (update as (value: ComposerDraft[Field]) => ComposerDraft[Field])(previous[field])
        : update;
      return Object.is(previous[field], next) ? previous : { ...previous, [field]: next };
    });
  }

  return {
    ...draft,
    read: () => store.read(scope),
    acknowledge: (submitted: ComposerDraft) => store.acknowledge(scope, submitted),
    async recheckFiles() {
      const files = store.read(scope).files;
      const refreshed = await refreshAttachments(files);
      if (refreshed !== files) store.update(scope, current => current.files === files ? { ...current, files: refreshed } : current);
      return refreshed;
    },
    setText: (update: SetStateAction<ComposerDraft['text']>) => updateField('text', update),
    setFiles: (update: SetStateAction<ComposerDraft['files']>) => updateField('files', update),
    setMentions: (update: SetStateAction<ComposerDraft['mentions']>) => updateField('mentions', update),
    clear: () => store.clear(scope),
  };
}
