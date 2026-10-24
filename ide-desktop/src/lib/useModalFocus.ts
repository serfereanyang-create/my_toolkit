import { useLayoutEffect, useRef, type RefObject } from 'react';

const modalStack: HTMLElement[] = [];

type ModalOptions = {
  identity?: string;
  onEscape: () => void;
  shortcuts?: Record<string, () => void>;
};

export function useModalFocus(active: boolean, initialFocus: RefObject<HTMLElement>, options: ModalOptions) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const optionsRef = useRef(options);
  const restoreTarget = useRef<HTMLElement | null>(null);
  const focusRevision = useRef(0);
  optionsRef.current = options;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!active || !dialog) return;
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousFocus = activeElement && dialog.contains(activeElement) ? restoreTarget.current : activeElement;
    restoreTarget.current = previousFocus;
    const revision = ++focusRevision.current;
    modalStack.push(dialog);
    const priority = (element: HTMLElement) => Number(getComputedStyle(element.parentElement ?? element).zIndex) || 0;
    modalStack.sort((first, second) => priority(first) - priority(second));
    const isTop = () => modalStack.at(-1) === dialog;
    const focusInitial = () => {
      const target = initialFocus.current;
      if (target && !target.matches(':disabled')) target.focus();
      else dialog.focus();
    };
    if (isTop()) focusInitial();
    const onFocus = (event: FocusEvent) => {
      if (isTop() && event.target instanceof Node && !dialog.contains(event.target)) focusInitial();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === 'Tab') {
        const controls = [...dialog.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex]')]
          .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
        const index = controls.indexOf(document.activeElement as HTMLElement);
        const next = index < 0 ? (event.shiftKey ? controls.length - 1 : 0)
          : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        event.preventDefault();
        event.stopImmediatePropagation();
        (controls[next] ?? dialog).focus();
        return;
      }
      if (event.isComposing || event.keyCode === 229 || event.repeat) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        optionsRef.current.onEscape();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (event.ctrlKey || event.altKey || event.metaKey || target?.isContentEditable || target?.matches('input, textarea, select')) return;
      const shortcut = optionsRef.current.shortcuts?.[event.key.toLowerCase()];
      if (shortcut) {
        event.preventDefault();
        event.stopImmediatePropagation();
        shortcut();
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus, true);
    return () => {
      const wasTop = isTop();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus, true);
      const index = modalStack.lastIndexOf(dialog);
      if (index >= 0) modalStack.splice(index, 1);
      if (!wasTop) return;
      requestAnimationFrame(() => {
        if (revision !== focusRevision.current) return;
        const currentModal = modalStack.at(-1);
        if (previousFocus?.isConnected && (!currentModal || currentModal.contains(previousFocus))) previousFocus.focus();
        else if (currentModal && !currentModal.contains(document.activeElement)) currentModal.focus();
      });
    };
  }, [active, options.identity]);

  return dialogRef;
}
