export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Operation cancelled', 'AbortError');
}

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw abortReason(signal);
}

export async function abortable<T>(work: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) { void work.catch(() => undefined); throw abortReason(signal); }
  let onAbort: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort!); }
}

export async function abortableDelay(milliseconds: number, signal?: AbortSignal | null): Promise<void> {
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await abortable(new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds); }), signal); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
