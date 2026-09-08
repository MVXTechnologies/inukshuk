import {
  retainStatuses,
  type OverlayRenderStatus,
  type OverlayStatusMap,
} from '@core/library/overlayStatus';
import { create } from 'zustand';

/**
 * Transient per-page outcome of the PDF overlay pipeline (#269). Written by
 * `usePdfOverlays` on the map screen as each active page is rasterized; read
 * by the Library map card, which turns it into "Rendering page N…" /
 * "Couldn't render page N: <reason>" (`@core/library/overlayStatus`). Not
 * persisted — a fresh launch re-renders (or re-fails) and rewrites it.
 */
interface OverlayStatusState {
  statuses: OverlayStatusMap;
  setStatus: (key: string, status: OverlayRenderStatus) => void;
  /** Keep only the given keys — the active set changed. */
  retain: (live: Iterable<string>) => void;
}

export const useOverlayStatusStore = create<OverlayStatusState>((set) => ({
  statuses: {},
  setStatus: (key, status) => set((s) => ({ statuses: { ...s.statuses, [key]: status } })),
  retain: (live) =>
    set((s) => {
      const next = retainStatuses(s.statuses, live);
      return next === s.statuses ? s : { statuses: next };
    }),
}));
