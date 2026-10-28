import { describe, expect, it } from 'vitest';
import { createStreamMetrics } from './streamMetrics.js';

describe('stream metrics', () => {
  it('records first event/output and interval percentiles deterministically', () => {
    const times = [100, 100, 112, 132, 172, 180, 180];
    const metrics = createStreamMetrics('sse', () => times.shift() ?? 180);
    metrics.event();
    metrics.output('hi');
    metrics.event();
    metrics.output('there');
    metrics.event();
    expect(metrics.finish()).toEqual({
      transport: 'sse',
      durationMs: 80,
      timeToFirstEventMs: 0,
      timeToFirstOutputMs: 12,
      eventCount: 3,
      outputDeltaCount: 2,
      outputChars: 7,
      interEventP50Ms: 32,
      interEventP95Ms: 48,
      maxInterEventMs: 48,
    });
  });

  it('uses nulls when a response has no events or output', () => {
    const metrics = createStreamMetrics('json', () => 50);
    expect(metrics.finish()).toMatchObject({
      transport: 'json',
      timeToFirstEventMs: null,
      timeToFirstOutputMs: null,
      eventCount: 0,
      outputDeltaCount: 0,
      outputChars: 0,
      interEventP50Ms: null,
      interEventP95Ms: null,
      maxInterEventMs: null,
    });
  });
});
