import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A small anchored popover menu.
 *
 * Rendered into `document.body` through a portal and positioned from the
 * anchor's viewport rect, because the Library scrolls: a menu positioned
 * `absolute` inside the panel is clipped by `overflow-y: auto` on the very rows
 * that most need it (the last card in a long list). Fixed + portal is the only
 * placement that survives a scroller.
 *
 * Closes on outside pointer-down, on Escape, and on any scroll or resize —
 * chasing the anchor during a scroll would need a rAF loop for no benefit.
 */

export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** Renders as a non-interactive caption (the app's "Move to folder" row). */
  caption?: boolean;
  /** Draws a hairline above this item. */
  divider?: boolean;
  danger?: boolean;
  /** Shows a check on the right — the currently-applied choice. */
  checked?: boolean;
  onSelect?: () => void;
}

const MENU_W = 224;
const MARGIN = 8;

export function Menu({
  anchor,
  items,
  onClose,
}: {
  anchor: HTMLElement;
  items: readonly MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Measured before paint: an unpositioned first frame would flash the menu at
  // the top-left corner of the window.
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 0;
    const left = Math.min(
      Math.max(MARGIN, rect.right - MENU_W),
      window.innerWidth - MENU_W - MARGIN,
    );
    const below = rect.bottom + 6;
    const top =
      below + h > window.innerHeight - MARGIN ? Math.max(MARGIN, rect.top - h - 6) : below;
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node) === true) return;
      if (anchor.contains(e.target as Node)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className="menu panel"
      role="menu"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width: MENU_W,
        visibility: pos === null ? 'hidden' : 'visible',
      }}
    >
      {items.map((item) =>
        item.caption === true ? (
          <div key={item.key} className="menu-caption micro">
            {item.label}
          </div>
        ) : (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={`menu-item${item.danger === true ? ' danger' : ''}${item.divider === true ? ' ruled' : ''}`}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
          >
            <span className="menu-icon">{item.icon}</span>
            <span className="menu-label">{item.label}</span>
            {item.checked === true ? <span className="menu-check" aria-hidden /> : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** Wiring for a `⋮`-style trigger: hold the anchor element, or null when shut. */
export function useMenuAnchor(): {
  anchor: HTMLElement | null;
  open: (e: { currentTarget: HTMLElement }) => void;
  close: () => void;
} {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return {
    anchor,
    open: (e) => setAnchor(e.currentTarget),
    close: () => setAnchor(null),
  };
}
