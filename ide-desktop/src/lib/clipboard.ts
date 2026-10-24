/** Put text on the system clipboard.
 *
 *  Two paths exist and they are not equivalent. The renderer's
 *  `navigator.clipboard.writeText` rejects with "Document is not focused" when
 *  the window is not focused — which happens after a native menu, a dialog, or
 *  an OS window switch — while the Electron main-process bridge always works
 *  because it writes from the main process. Several copy buttons used only the
 *  navigator path and then reported success unconditionally, so the UI said
 *  "已复制" over an empty clipboard.
 *
 *  Returns whether the text actually reached the clipboard, so callers can
 *  decide whether to show confirmation. */
export async function copyText(text: string): Promise<boolean> {
  try {
    // Loaded lazily: lib/ipc.ts reads window.zcodeDesktop at module scope, and
    // this module is imported by components that a plain Node test may render
    // without a DOM.
    const { desktop } = await import('./ipc');
    const result = await desktop.clipboard.write(text);
    if (result?.ok) return true;
  } catch {
    // fall through to the in-renderer path
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  // Last resort for environments where neither API is available (a webview
  // without clipboard permission, an older Electron).
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
