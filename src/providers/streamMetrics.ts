export type StreamMetrics = {
  transport: 'sse' | 'json';
  durationMs: number;
  timeToFirstEventMs: number | null;
  timeToFirstOutputMs: number | null;
  eventCount: number;
  outputDeltaCount: number;
  outputChars: number;
  interEventP50Ms: number | null;
  interEventP95Ms: number | null;
  maxInterEventMs: number | null;
};

export type StreamMetricsRecorder = {
  event(): void;
  output(chars: string): void;
  finish(): StreamMetrics;
};

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!);
}

export function createStreamMetrics(transport: 'sse' | 'json', now: () => number = () => performance.now()): StreamMetricsRecorder {
  const startedAt = now();
  let firstEventAt: number | undefined;
  let firstOutputAt: number | undefined;
  let lastEventAt: number | undefined;
  let eventCount = 0;
  let outputDeltaCount = 0;
  let outputChars = 0;
  const interEventMs: number[] = [];

  return {
    event() {
      const current = now();
      if (firstEventAt === undefined) firstEventAt = current;
      if (lastEventAt !== undefined) interEventMs.push(Math.max(0, current - lastEventAt));
      lastEventAt = current;
      eventCount += 1;
    },
    output(chars) {
      if (!chars) return;
      const current = now();
      if (firstOutputAt === undefined) firstOutputAt = current;
      outputDeltaCount += 1;
      outputChars += chars.length;
    },
    finish() {
      const endedAt = now();
      return {
        transport,
        durationMs: Math.max(0, Math.round(endedAt - startedAt)),
        timeToFirstEventMs: firstEventAt === undefined ? null : Math.max(0, Math.round(firstEventAt - startedAt)),
        timeToFirstOutputMs: firstOutputAt === undefined ? null : Math.max(0, Math.round(firstOutputAt - startedAt)),
        eventCount,
        outputDeltaCount,
        outputChars,
        interEventP50Ms: percentile(interEventMs, 0.5),
        interEventP95Ms: percentile(interEventMs, 0.95),
        maxInterEventMs: interEventMs.length > 0 ? Math.round(Math.max(...interEventMs)) : null,
      };
    },
  };
}
