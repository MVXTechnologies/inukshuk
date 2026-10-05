/**
 * The system picker's content (mockup 10): "Suggested here", chart datum,
 * ellipsoidal, global, and — when searching — everything else. A system is
 * listed only if the planner can build a validated plan for it at this point
 * (Q11a: unvalidated pairs are hidden, not shown red), so the picker and the
 * engine can never disagree.
 */
import { plan, stationHeights, type CdStation } from './graph';
import { inRegion, placeName } from './regions';
import { COORD_SYSTEMS, FRAMES, HEIGHT_SYSTEMS } from './systems';
import type { ConvertSpec, CoordSystem, HeightSystem, RefusalCode, SourcePoint } from './types';

export interface PickerItem {
  id: string;
  title: string;
  subtitle: string;
  /** Right-hand note: "in your region", "bundled", "pack", "CHS offset". */
  badge?: string;
}

export interface PickerSection {
  title: string;
  items: PickerItem[];
}

/** Refusals that mean "not for this point / not validated": the item is hidden. */
const HIDING: readonly RefusalCode[] = [
  'unvalidated-pair',
  'outside-region',
  'out-of-zone',
  'cd-too-far',
  'cd-cross-zone',
];

function usable(
  spec: ConvertSpec,
  near: { lon: number; lat: number },
  stations: readonly CdStation[],
): boolean {
  const pt: SourcePoint = { xy: [near.lon, near.lat], h: 0, lon: near.lon, lat: near.lat };
  const probe: ConvertSpec = {
    ...spec,
    ...(FRAMES[systemFrame(spec.from)]?.dynamic && spec.epoch === undefined ? { epoch: 2010 } : {}),
  };
  const r = plan(probe, pt, { stations });
  return r.ok || !HIDING.includes(r.refusal.code);
}

function systemFrame(id: string) {
  return (COORD_SYSTEMS.find((c) => c.id === id)?.frame ?? 'wgs84') as keyof typeof FRAMES;
}

function coordTitle(c: CoordSystem): string {
  const f = FRAMES[c.frame];
  return c.kind === 'geographic' ? `${f.name} · geographic` : `${f.name} / ${c.name}`;
}

function coordSubtitle(c: CoordSystem): string {
  const parts = [
    c.epsg ? `EPSG:${c.epsg}` : null,
    FRAMES[c.frame].dynamic ? 'coordinate epoch' : FRAMES[c.frame].note,
  ];
  return parts.filter(Boolean).join(' · ');
}

export function coordItem(c: CoordSystem): PickerItem {
  return { id: c.id, title: coordTitle(c), subtitle: coordSubtitle(c) };
}

/** A projection whose zone holds the point (UTM / MTM: the nearest central meridian only). */
function zoneHolds(c: CoordSystem, lon: number, lat: number): boolean {
  const d = c.domain;
  if (!d) return true;
  if (d.bbox && !inRegion(d.bbox, lon, lat)) return false;
  if (d.lon0 !== undefined) {
    const half = /MTM/.test(c.name) ? 1.5 : 3;
    return Math.abs(lon - d.lon0) <= half + 1e-9;
  }
  return true;
}

function matches(q: string, ...texts: (string | number | undefined)[]): boolean {
  const n = q.trim().toLowerCase();
  if (n === '') return true;
  return texts.some(
    (t) =>
      t !== undefined &&
      String(t)
        .toLowerCase()
        .includes(n.replace(/^epsg:?/, '')),
  );
}

/**
 * Coordinate systems for a role. `other` = the spec of the other side (the
 * target's when picking the source, and vice versa), used to keep only
 * combinations the planner accepts.
 */
export function coordinateSections(
  role: 'from' | 'to',
  spec: ConvertSpec,
  near: { lon: number; lat: number },
  query = '',
  stations: readonly CdStation[] = [],
): PickerSection[] {
  const here = placeName(near.lon, near.lat);
  const suggested: PickerItem[] = [];
  const global: PickerItem[] = [];
  const elsewhere: PickerItem[] = [];
  for (const c of COORD_SYSTEMS) {
    if (!matches(query, coordTitle(c), c.epsg, c.name)) continue;
    const test: ConvertSpec =
      role === 'from'
        ? { ...spec, from: c.id, to: spec.to === 'same' ? 'same' : spec.to }
        : { ...spec, to: c.id };
    // A source system is judged on its own (the target follows it); a target against the source.
    const ok =
      role === 'from'
        ? usable({ ...test, to: c.id, toHeight: null, fromHeight: null }, near, stations)
        : usable({ ...test, toHeight: null, fromHeight: null }, near, stations);
    if (!ok) {
      if (query.trim() !== '' && role === 'from') elsewhere.push(coordItem(c));
      continue;
    }
    const regional =
      inRegion(FRAMES[c.frame].region, near.lon, near.lat) &&
      FRAMES[c.frame].region !== FRAMES.wgs84.region;
    if (c.frame === 'wgs84') {
      if (c.kind !== 'projected' || zoneHolds(c, near.lon, near.lat) || query.trim() !== '')
        global.push(coordItem(c));
    } else if (regional && (c.kind !== 'projected' || zoneHolds(c, near.lon, near.lat))) {
      suggested.push({ ...coordItem(c), badge: 'in your region' });
    } else if (query.trim() !== '') {
      elsewhere.push(coordItem(c));
    }
  }
  return [
    { title: here ? `Suggested here · ${here}` : 'Suggested here', items: suggested },
    { title: 'Global', items: global },
    { title: 'Elsewhere', items: elsewhere.slice(0, 40) },
  ].filter((s) => s.items.length > 0);
}

function heightItem(
  h: HeightSystem,
  available: (grid: string) => boolean,
  gridOf: (id: string) => string | undefined,
): PickerItem {
  let badge: string | undefined;
  if (h.kind === 'cd-station') badge = 'station offsets';
  else if (h.kind === 'station-offset') badge = 'station offset';
  else if (h.kind !== 'ellipsoidal') {
    const g = gridOf(h.id);
    badge =
      g === undefined
        ? undefined
        : available(g)
          ? g === 'us_nga_egm96_15.tif'
            ? 'bundled'
            : 'on this device'
          : 'needs a grid pack';
  }
  return {
    id: h.id,
    title: h.name,
    subtitle: `${h.note}${h.epsg ? ` · EPSG:${h.epsg}` : ''}`,
    ...(badge ? { badge } : {}),
  };
}

/** Height systems for a role, given the rest of the spec. */
export function heightSections(
  role: 'from' | 'to',
  spec: ConvertSpec,
  near: { lon: number; lat: number },
  opts: {
    query?: string;
    stations?: readonly CdStation[];
    available?: (grid: string) => boolean;
    gridOf?: (id: string) => string | undefined;
  } = {},
): PickerSection[] {
  const stations = opts.stations ?? [];
  const available = opts.available ?? (() => true);
  const gridOf = opts.gridOf ?? (() => undefined);
  const query = opts.query ?? '';
  const all: HeightSystem[] = [...HEIGHT_SYSTEMS, ...stations.flatMap(stationHeights)];
  const here = placeName(near.lon, near.lat);
  const sections: Record<string, PickerItem[]> = {
    suggested: [],
    chart: [],
    ellipsoidal: [],
    global: [],
  };
  for (const h of all) {
    if (!matches(query, h.name, h.epsg, h.note)) continue;
    const test: ConvertSpec =
      role === 'from'
        ? { ...spec, fromHeight: h.id, toHeight: h.id === 'ell' ? null : 'ell', to: spec.to }
        : { ...spec, toHeight: h.id, fromHeight: spec.fromHeight ?? 'ell' };
    if (role === 'from' && h.id !== 'ell' && !usable({ ...test, to: 'same' }, near, stations))
      continue;
    if (role === 'to' && !usable(test, near, stations)) continue;
    if (role === 'from' && h.id === 'ell' && !usable({ ...test, to: spec.from }, near, stations))
      continue;
    const item = heightItem(h, available, gridOf);
    if (h.kind === 'ellipsoidal') sections.ellipsoidal?.push(item);
    else if (h.chart || h.kind === 'station-offset') sections.chart?.push(item);
    else if (h.id === 'egm96' || h.id === 'egm2008') sections.global?.push(item);
    else sections.suggested?.push(item);
  }
  return [
    {
      title: here ? `Suggested here · ${here}` : 'Suggested here',
      items: sections.suggested ?? [],
    },
    { title: 'Chart datum', items: sections.chart ?? [] },
    { title: 'Ellipsoidal', items: sections.ellipsoidal ?? [] },
    { title: 'Global', items: sections.global ?? [] },
  ].filter((s) => s.items.length > 0);
}
