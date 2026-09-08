import type { MapDocument } from '@core/models';

/**
 * Per-page render outcome of the PDF overlay pipeline, and the one line the
 * Library map card shows for it (#269).
 *
 * "Nothing draws" used to be the whole story: the overlay hook reported its
 * error to a snackbar on the map screen (gone in four seconds) and the card
 * kept saying "1 page(s) · 1/1 shown" over a page that never rendered. The
 * status line is the durable answer — pending while a page is in the
 * rasterizer, and the failure reason after, for as long as the page stays
 * active.
 */
export type OverlayRenderStatus =
  { phase: 'rendering' } | { phase: 'rendered' } | { phase: 'failed'; reason: string };

export type OverlayStatusMap = Readonly<Record<string, OverlayRenderStatus>>;

/** The status key for a page — the same `${docId}:${pageIndex}` the overlay id uses. */
export function overlayStatusKey(docId: string, pageIndex: number): string {
  return `${docId}:${pageIndex}`;
}

export interface RenderStatusLine {
  kind: 'rendering' | 'failed';
  text: string;
}

/**
 * The card's render-status line for a map, or `null` when every active page
 * is rendered (or nothing has been attempted). A failure wins over a page
 * still rendering: it is the one the user can act on. Pages are visited in
 * page order so the line is stable across re-renders.
 */
export function renderStatusLine(
  map: Pick<MapDocument, 'id' | 'activePages'>,
  statuses: OverlayStatusMap,
): RenderStatusLine | null {
  const pages = [...new Set(map.activePages)].sort((a, b) => a - b);
  for (const page of pages) {
    const status = statuses[overlayStatusKey(map.id, page)];
    if (status?.phase === 'failed') {
      return { kind: 'failed', text: `Couldn't render page ${page + 1}: ${status.reason}` };
    }
  }
  for (const page of pages) {
    if (statuses[overlayStatusKey(map.id, page)]?.phase === 'rendering') {
      return { kind: 'rendering', text: `Rendering page ${page + 1}…` };
    }
  }
  return null;
}

/**
 * Drop every status whose key is not in `live` — the active set changed and a
 * page that is no longer drawn must not keep reporting on the card.
 */
export function retainStatuses(
  statuses: OverlayStatusMap,
  live: Iterable<string>,
): OverlayStatusMap {
  const keep = new Set(live);
  const next: Record<string, OverlayRenderStatus> = {};
  let changed = false;
  for (const [key, status] of Object.entries(statuses)) {
    if (keep.has(key)) next[key] = status;
    else changed = true;
  }
  return changed ? next : statuses;
}
