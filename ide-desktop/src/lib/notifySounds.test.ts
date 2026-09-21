import { describe, expect, it } from 'vitest';
import { clampVolume, cueForEvent, soundVolume } from './notifySounds';

describe('clampVolume', () => {
  it('clamps into 0..1 and defaults non-numeric to 0.5', () => {
    expect(clampVolume(0.3)).toBe(0.3);
    expect(clampVolume(-2)).toBe(0);
    expect(clampVolume(5)).toBe(1);
    expect(clampVolume('0.8')).toBe(0.8);
    expect(clampVolume('loud')).toBe(0.5);
    expect(clampVolume(undefined)).toBe(0.5);
    expect(clampVolume(Number.NaN)).toBe(0.5);
  });
});

describe('soundVolume', () => {
  it('returns 0 when sounds are disabled regardless of stored volume', () => {
    expect(soundVolume({ 'gen.sounds': false, 'gen.soundVolume': 0.9 })).toBe(0);
  });
  it('defaults to 0.5 when unset', () => {
    expect(soundVolume({})).toBe(0.5);
    expect(soundVolume(null)).toBe(0.5);
    expect(soundVolume(undefined)).toBe(0.5);
  });
  it('honours stored volume and clamps it', () => {
    expect(soundVolume({ 'gen.soundVolume': 0.2 })).toBe(0.2);
    expect(soundVolume({ 'gen.soundVolume': 3 })).toBe(1);
  });
});

describe('cueForEvent', () => {
  it('maps approval/turn/error events to cues', () => {
    expect(cueForEvent({ type: 'approval_needed' })).toBe('approval');
    expect(cueForEvent({ type: 'turn_done' })).toBe('done');
    expect(cueForEvent({ type: 'error' })).toBe('error');
  });
  it('cues error rather than done when the turn failed', () => {
    // The CLI reports failure on turn_done itself (status: 'error'), so keying
    // the success chime off the event type alone announced success on failure.
    expect(cueForEvent({ type: 'turn_done', status: 'error' })).toBe('error');
    expect(cueForEvent({ type: 'turn_done', status: 'ok' })).toBe('done');
    // A missing status (older bridge) must keep the previous behaviour.
    expect(cueForEvent({ type: 'turn_done', status: undefined })).toBe('done');
  });
  it('stays silent for sandbox auto-decided approvals', () => {
    expect(cueForEvent({ type: 'approval_needed', autoDecision: 'deny' })).toBeNull();
    expect(cueForEvent({ type: 'approval_needed', autoDecision: 'allow_once' })).toBeNull();
    // An unexpected annotation value must not silence a real user prompt.
    expect(cueForEvent({ type: 'approval_needed', autoDecision: 'maybe' })).toBe('approval');
  });
  it('ignores other events', () => {
    expect(cueForEvent({ type: 'tool_start' })).toBeNull();
    expect(cueForEvent({})).toBeNull();
  });
});

describe('cueForEvent activity awareness', () => {
  it('plays no success chime for a turn that ran no tools', () => {
    // `ok` means the loop ended cleanly, not that work happened. The success
    // chime would announce work that did not occur.
    expect(cueForEvent({ type: 'turn_done', status: 'ok', producedActivity: false })).toBeNull();
  });

  it('plays the success chime when the turn did work', () => {
    expect(cueForEvent({ type: 'turn_done', status: 'ok', producedActivity: true })).toBe('done');
  });

  it('plays the success chime when the flag is absent (older CLI)', () => {
    // Absent must not be read as "no activity": that would silence every
    // successful turn against an older bridge.
    expect(cueForEvent({ type: 'turn_done', status: 'ok' })).toBe('done');
  });

  it('still plays the error chime for a failed turn regardless of activity', () => {
    expect(cueForEvent({ type: 'turn_done', status: 'error', producedActivity: true })).toBe('error');
    expect(cueForEvent({ type: 'turn_done', status: 'error', producedActivity: false })).toBe('error');
  });
});
