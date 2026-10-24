import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// The module imports the Electron bridge at load time; stand it in before the
// import so the module sees a controllable clipboard.
const written: string[] = [];
const bridge = { write: vi.fn(async (text: string) => { written.push(text); return { ok: true }; }) };
vi.mock('./ipc', () => ({ desktop: { clipboard: bridge } }));

const { copyText } = await import('./clipboard');

describe('copyText', () => {
  beforeEach(() => {
    written.length = 0;
    bridge.write.mockClear();
    bridge.write.mockImplementation(async (text: string) => { written.push(text); return { ok: true }; });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers the main-process bridge', async () => {
    const ok = await copyText('hello');
    expect(ok).toBe(true);
    expect(written).toEqual(['hello']);
  });

  it('falls back to navigator.clipboard when the bridge throws', async () => {
    bridge.write.mockRejectedValueOnce(new Error('no bridge'));
    const navWrite = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: navWrite }, configurable: true });
    const ok = await copyText('fallback');
    expect(ok).toBe(true);
    expect(navWrite).toHaveBeenCalledWith('fallback');
  });

  it('reports failure when both paths reject', async () => {
    bridge.write.mockRejectedValueOnce(new Error('bridge down'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => { throw new Error('Document is not focused'); }) },
      configurable: true,
    });
    const ok = await copyText('nope');
    // jsdom has no execCommand, so the legacy path fails too.
    expect(ok).toBe(false);
  });

  it('does not report success when the bridge returns ok:false and navigator is gone', async () => {
    bridge.write.mockResolvedValueOnce({ ok: false });
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const ok = await copyText('x');
    expect(ok).toBe(false);
  });
});
