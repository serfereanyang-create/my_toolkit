import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

export function ModalPortal({ children }: { children: ReactNode }) {
  return typeof document === 'undefined' ? null : createPortal(children, document.body);
}
