import { formatMapScale } from '@core/catalog/exploreFacets';
import type { CatalogBbox, CatalogItem, CatalogSource } from '@core/catalog/schema';
import type { LngLat } from '@core/models';

import { bboxOfLine } from './geometry';

/**
 * "Topo maps along this trail" (#467): the catalog's topographic sheets whose
 * footprint the trail actually crosses — not merely its bbox, which for a
 * diagonal trail would add every sheet in the rectangle — summarised per
 * publisher ("3 NRCan sheets · 1:50 000").
 */

/** Does segment a–b touch the rectangle? (Liang–Barsky clip.) */
export function segmentHitsBox(a: LngLat, b: LngLat, box: CatalogBbox): boolean {
  const [w, s, e, n] = box;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, a[0] - w) && clip(dx, e - a[0]) && clip(-dy, a[1] - s) && clip(dy, n - a[1]);
}

export function lineHitsBox(parts: readonly (readonly LngLat[])[], box: CatalogBbox): boolean {
  for (const part of parts) {
    if (part.length === 1) {
      const p = part[0];
      if (p !== undefined && segmentHitsBox(p, p, box)) return true;
    }
    for (let i = 1; i < part.length; i++) {
      const a = part[i - 1];
      const b = part[i];
      if (a !== undefined && b !== undefined && segmentHitsBox(a, b, box)) return true;
    }
  }
  return false;
}

const overlaps = (a: CatalogBbox, b: CatalogBbox) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Topographic catalog items the trail crosses, in trail order of their first hit. */
export function topoMapsAlong(
  items: readonly CatalogItem[],
  parts: readonly (readonly LngLat[])[],
): CatalogItem[] {
  const bbox = bboxOfLine(parts);
  if (bbox === null) return [];
  const candidates = items.filter(
    (item) =>
      item.bbox !== undefined &&
      (item.kind === 'topo' || (item.kind === undefined && item.category === 'topo')) &&
      overlaps(item.bbox, bbox),
  );
  return candidates.filter((item) => item.bbox !== undefined && lineHitsBox(parts, item.bbox));
}

export interface TopoGroup {
  sourceId: string;
  sourceName: string;
  licence: string | undefined;
  items: CatalogItem[];
  /** The group's most common scale denominator, when the items state one. */
  scale: number | null;
}

/** One group per publisher, biggest first. */
export function groupBySource(
  items: readonly CatalogItem[],
  sources: readonly CatalogSource[],
): TopoGroup[] {
  const groups = new Map<string, TopoGroup>();
  for (const item of items) {
    const source = sources.find((s) => s.id === item.sourceId);
    const group = groups.get(item.sourceId) ?? {
      sourceId: item.sourceId,
      sourceName: source?.name ?? item.sourceId,
      licence: source?.licence,
      items: [],
      scale: null,
    };
    group.items.push(item);
    groups.set(item.sourceId, group);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, scale: commonScale(g.items) }))
    .sort((a, b) => b.items.length - a.items.length || a.sourceName.localeCompare(b.sourceName));
}

function commonScale(items: readonly CatalogItem[]): number | null {
  const counts = new Map<number, number>();
  for (const item of items) {
    if (typeof item.scale === 'number' && item.scale > 1) {
      counts.set(item.scale, (counts.get(item.scale) ?? 0) + 1);
    }
  }
  let best: number | null = null;
  let bestN = 0;
  for (const [scale, n] of counts) {
    if (n > bestN) {
      best = scale;
      bestN = n;
    }
  }
  return best;
}

/** "3 NRCan sheets · 1:50 000" */
export function topoGroupTitle(group: TopoGroup, sourceAbbrev: string): string {
  const n = group.items.length;
  const noun = n === 1 ? 'sheet' : 'sheets';
  const scale = group.scale !== null ? ` · ${formatMapScale(group.scale)}` : '';
  return `${n} ${sourceAbbrev} ${noun}${scale}`;
}
