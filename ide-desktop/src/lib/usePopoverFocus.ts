import { useEffect, type RefObject } from 'react';

const FOCUSABLE = [
  'button:not([disabled])',
  '[role="menuitem"]:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Focus contract for a non-modal popover — the composer's model / effort /
 * approval / tool-scope / context menus, the rail's plugin and help menus.
 *
 * These open from a trigger button that keeps focus. That reads fine with a
 * mouse and is dead on the keyboard: the popovers are rendered *before* the
 * composer bar in DOM order, so a Tab from the trigger moves forward, away
 * from the menu it just opened, and the items are only reachable by tabbing
 * all the way around the app. So: move focus to the first item on open, and
 * hand it back to the trigger on close so Escape does not strand the caret
 * wherever the menu used to be.
 *
 * Deliberately not a trap. These are popovers, not modals: the component
 * already closes them on Escape, and pinning Tab inside a non-modal menu would
 * fight the rest of the shell.
 */
export function usePopoverFocus(containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    const container = containerRef.current;
    const first = container?.querySelector<HTMLElement>(FOCUSABLE);
    if (first) first.focus();
    else container?.focus();
    return () => {
      const current = document.activeElement;
      // `container` may already be detached here, in which case contains() is
      // false and the body check below is what notices the focus was lost.
      const lost = !current || current === document.body || container?.contains(current) === true;
      if (opener?.isConnected && lost) opener.focus();
    };
  }, [containerRef]);
}
