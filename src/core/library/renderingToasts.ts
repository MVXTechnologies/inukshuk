import type { MapDocument } from '@core/models';
import { overlayStatusKey, type OverlayRenderStatus, type OverlayStatusMap } from './overlayStatus';

/**
 * The map screen's "currently rendering" toast list (#269): one row per
 * active page that is inside the rasterizer right now, in library order,
 * minus the rows the user hid. A 200 MB sheet takes 15–20 s on a mid-range
 * phone; without this the map is simply blank for that long.
 */
export interface RenderingToast {
  /** The overlay status key — also what the user hides. */
  key: string;
  text: string;
}

/**
 * What the user hid: the key AND the status object that was showing. A hide
 * lasts exactly as long as that object is the page's current status — when
 * the page finishes and later renders again (after a cache purge, say) the
 * store holds a new object, so the row announces itself again. No timers,
 * no pruning effect.
 */
export type HiddenToasts = ReadonlyMap<string, OverlayRenderStatus>;

export function renderingToasts(
  maps: readonly Pick<MapDocument, 'id' | 'name' | 'activePages'>[],
  statuses: OverlayStatusMap,
  hidden: HiddenToasts,
): RenderingToast[] {
  const out: RenderingToast[] = [];
  for (const map of maps) {
    for (const page of [...new Set(map.activePages)].sort((a, b) => a - b)) {
      const key = overlayStatusKey(map.id, page);
      const status = statuses[key];
      if (status?.phase !== 'rendering' || hidden.get(key) === status) continue;
      out.push({ key, text: `Rendering ${map.name} — page ${page + 1}…` });
    }
  }
  return out;
}
