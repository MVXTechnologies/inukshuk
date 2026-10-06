import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { IconClose } from './Icons';

/**
 * A centred dialog over a scrim.
 *
 * Used sparingly — the aesthetic gate is "nothing ever boxes the map in with
 * opaque furniture", and a modal is furniture. It earns its place only where
 * the app also uses one and there is no in-place alternative: picking a
 * category, naming a folder, confirming a destructive edit.
 *
 * Outside-click and Escape both dismiss, which for these three is always the
 * safe outcome (the category picker applies on select, the others cancel).
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 340,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  return createPortal(
    <div className="scrim" onPointerDown={onClose}>
      <div
        className="dialog panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <span className="drawer-title">{title}</span>
          <button type="button" className="row-action" onClick={onClose} aria-label="Close">
            <IconClose size={14} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer === undefined ? null : <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
