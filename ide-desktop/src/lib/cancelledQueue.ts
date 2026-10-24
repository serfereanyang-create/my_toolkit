import type { AgentEvent, QueuedMessage } from '../types';

export function returnedQueueMessages(event: AgentEvent, sessionId: string): QueuedMessage[] {
  if (event.type !== 'cancel_ack' || !Array.isArray(event.queued)) return [];
  const cancelId = typeof event.cancelId === 'string' ? event.cancelId : crypto.randomUUID();
  return event.queued.flatMap((raw: unknown, index: number) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const message = raw as Record<string, unknown>;
    if (typeof message.text !== 'string') return [];
    const files = Array.isArray(message.files) ? message.files.flatMap((rawFile: unknown) => {
      if (!rawFile || typeof rawFile !== 'object' || Array.isArray(rawFile)) return [];
      const file = rawFile as Record<string, unknown>;
      if (typeof file.path !== 'string' || !file.path) return [];
      return [{ path: file.path, name: typeof file.name === 'string' ? file.name : file.path.split(/[\\/]/).at(-1) ?? file.path, size: typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0 ? file.size : 0 }];
    }) : undefined;
    return [{ id: `returned-${cancelId}-${index}`, sessionId, text: message.text, createdAt: Date.now(), ...(files?.length ? { files } : {}) }];
  });
}
