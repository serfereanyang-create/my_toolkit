/*
 * notifySounds — WebAudio notification cues for key task states.
 *
 * Three cues, synthesized (no asset files, no credentials, works offline):
 *   approval — two rising notes: "a decision is needed" (attention, not alarm)
 *   done     — bright two-note up-chime: task finished
 *   error    — low double buzz: something failed
 *
 * The AudioContext is created lazily on first play (browser autoplay policy:
 * a user gesture will already have happened by the time the agent runs).
 * Every failure path is swallowed — notification sounds must never break the
 * conversation flow. Volume 0..1; 0 disables.
 */

export type Cue = 'approval' | 'done' | 'error';

// [frequency Hz, start offset s, duration s, gain multiplier, wave]
type Note = [number, number, number, number, OscillatorType];

const CUES: Record<Cue, Note[]> = {
  approval: [
    [660, 0.00, 0.16, 0.9, 'sine'],
    [880, 0.18, 0.22, 1.0, 'sine'],
  ],
  done: [
    [784, 0.00, 0.12, 0.8, 'triangle'],
    [1046, 0.13, 0.26, 1.0, 'triangle'],
  ],
  error: [
    [220, 0.00, 0.14, 1.0, 'square'],
    [220, 0.20, 0.20, 0.8, 'square'],
  ],
};

let ctx: AudioContext | null = null;
let lastCueAt: Partial<Record<Cue, number>> = {};

function ensureContext(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext
        || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Clamp an untrusted stored preference into 0..1. Anything non-numeric or
 * out of range falls back to the default 0.5 (sounds on, moderate).
 */
export function clampVolume(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/** Same cue within this window is ignored (event bursts shouldn't machine-gun). */
const REPEAT_GUARD_MS = 600;

/**
 * Play one cue. `volume` 0 disables silently. Never throws.
 */
export function playCue(cue: Cue, volume: number): void {
  const v = clampVolume(volume);
  if (v <= 0) return;
  const notes = CUES[cue];
  if (!notes) return;
  const now = Date.now();
  if (now - (lastCueAt[cue] ?? 0) < REPEAT_GUARD_MS) return;
  lastCueAt[cue] = now;
  const ac = ensureContext();
  if (!ac) return;
  try {
    const t0 = ac.currentTime + 0.01;
    for (const [freq, start, dur, gainMul, wave] of notes) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = wave;
      osc.frequency.value = freq;
      const peak = Math.min(0.35, 0.22 * v * gainMul);
      // Short attack + exponential decay: soft on the ears, no clicks.
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.linearRampToValueAtTime(peak, t0 + start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(gain).connect(ac.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.05);
    }
  } catch {
    // Audio subsystem hiccup — notifications are best-effort by design.
  }
}

/** Test-only hook to reset the repeat guard between rapid plays. */
export function _resetCueGuardForTests(): void {
  lastCueAt = {};
}

/**
 * Resolve the effective volume from stored preferences: 0 when sounds are
 * disabled, otherwise the clamped gen.soundVolume (default 0.5).
 */
export function soundVolume(prefs: Record<string, unknown> | undefined | null): number {
  if (prefs && prefs['gen.sounds'] === false) return 0;
  return clampVolume(prefs?.['gen.soundVolume']);
}

/**
 * Map an agent event to its notification cue, or null for silent events.
 * Auto-decided approvals (sandbox answered for the user) stay silent — no
 * cue for a prompt the user never sees.
 */
export function cueForEvent(event: { type?: unknown; autoDecision?: unknown }): Cue | null {
  switch (event.type) {
    case 'approval_needed':
      return event.autoDecision === 'allow_once' || event.autoDecision === 'deny' ? null : 'approval';
    case 'turn_done':
      return 'done';
    case 'error':
      return 'error';
    default:
      return null;
  }
}
