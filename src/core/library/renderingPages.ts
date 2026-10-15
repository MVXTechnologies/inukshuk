import type { MapDocument } from '@core/models';
import { overlayStatusKey, type OverlayStatusMap } from './overlayStatus';

/**
 * The PDF pages the map is waiting on (#269, now busy tasks in the map's
 * busy chip, #721): one entry per active page that is inside the rasterizer
 * right now, in library and page order. A 200 MB sheet takes 15–20 s on a
 * mid-range phone; without this the map is simply blank for that long.
 */
export interface RenderingPage {
  /** The overlay status key (`${docId}:${pageIndex}`). */
  key: string;
  /** The map's name. */
  name: string;
  /** 1-based page number, as the user counts. */
  page: number;
}

export function renderingPages(
  maps: readonly Pick<MapDocument, 'id' | 'name' | 'activePages'>[],
  statuses: OverlayStatusMap,
): RenderingPage[] {
  const out: RenderingPage[] = [];
  for (const map of maps) {
    for (const page of [...new Set(map.activePages)].sort((a, b) => a - b)) {
      const key = overlayStatusKey(map.id, page);
      if (statuses[key]?.phase !== 'rendering') continue;
      out.push({ key, name: map.name, page: page + 1 });
    }
  }
  return out;
}
