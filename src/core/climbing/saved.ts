/**
 * Saved (downloaded) crags: the persisted record (`climbing.json`), its
 * migrations, and the GeoJSON the main map draws them from — no network: the
 * crag badge, its sector pins from z13, and the route-start dots from z17
 * where OSM gives them (DESIGN §6.4, mockup 05).
 *
 * "Attach my topo" files are local only (owner decision Q7-A): they live in
 * the app's documents directory, are listed here, and are never synced.
 */
import type { CragDetail } from './detail';
import { bandOf } from './grades';

export const CLIMBING_SCHEMA_VERSION = 1;

export interface CragAttachment {
  id: string;
  kind: 'image' | 'pdf';
  /** The file's name as picked ("Weir topo p.12.pdf"). */
  name: string;
  /** Path relative to the documents directory (`climbing/attachments/…`). */
  path: string;
  bytes: number;
  addedAt: number;
}

export interface SavedSector {
  name: string;
  pt: [number, number] | null;
  routes: number;
}

/** [lng, lat, number in its sector (0 = unordered), band (-1 = none)]. */
export type SavedStart = [number, number, number, number];

export interface SavedCrag {
  uid: string;
  /** The topo version saved (the tiles' `v`; differs = "Update available"). */
  version: string;
  name: string;
  region: string | null;
  lat: number;
  lng: number;
  routes: number;
  sectors: SavedSector[];
  starts: SavedStart[];
  savedAt: number;
  /** Bytes of the saved topo JSON. */
  topoBytes: number;
  /** The 2 km crag & approach map pack (`@data/offline`), when downloaded. */
  packId: string | null;
  packBytes: number;
  attachments: CragAttachment[];
}

export interface ClimbingDoc {
  schemaVersion: number;
  saved: SavedCrag[];
}

export function emptyClimbingDoc(): ClimbingDoc {
  return { schemaVersion: CLIMBING_SCHEMA_VERSION, saved: [] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sanitizeSaved(raw: unknown): SavedCrag | null {
  if (!isRecord(raw)) return null;
  const { uid, name, lat, lng } = raw;
  if (typeof uid !== 'string' || typeof name !== 'string') return null;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  const n = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    uid,
    version: typeof raw.version === 'string' ? raw.version : '',
    name,
    region: typeof raw.region === 'string' ? raw.region : null,
    lat,
    lng,
    routes: n(raw.routes),
    sectors: Array.isArray(raw.sectors) ? (raw.sectors as SavedSector[]).filter(isRecord) : [],
    starts: Array.isArray(raw.starts)
      ? (raw.starts as unknown[]).filter(
          (s): s is SavedStart => Array.isArray(s) && s.length === 4 && s.every(Number.isFinite),
        )
      : [],
    savedAt: n(raw.savedAt),
    topoBytes: n(raw.topoBytes),
    packId: typeof raw.packId === 'string' ? raw.packId : null,
    packBytes: n(raw.packBytes),
    attachments: Array.isArray(raw.attachments)
      ? (raw.attachments as CragAttachment[]).filter(
          (a) => isRecord(a) && typeof a.path === 'string' && typeof a.id === 'string',
        )
      : [],
  };
}

/** Any persisted shape → the current one (unknown future versions are kept as read). */
export function migrateClimbingDoc(raw: unknown): ClimbingDoc {
  if (!isRecord(raw)) return emptyClimbingDoc();
  const saved = (Array.isArray(raw.saved) ? raw.saved : [])
    .map(sanitizeSaved)
    .filter((s): s is SavedCrag => s !== null);
  const seen = new Set<string>();
  return {
    schemaVersion: CLIMBING_SCHEMA_VERSION,
    saved: saved.filter((s) => (seen.has(s.uid) ? false : (seen.add(s.uid), true))),
  };
}

/** The saved record of a freshly downloaded topo. */
export function savedFromDetail(
  d: CragDetail,
  extra: { savedAt: number; topoBytes: number; packId: string | null; packBytes: number },
  previous?: SavedCrag,
): SavedCrag {
  const starts: SavedStart[] = [];
  for (const s of d.sectors) {
    s.routes.forEach((r, i) => {
      if (!r.pos) return;
      const band = r.k !== undefined && r.x !== undefined ? bandOf(r.k, r.x) : -1;
      starts.push([r.pos[0], r.pos[1], s.ordered ? i + 1 : 0, band]);
    });
  }
  return {
    uid: d.uid,
    version: d.v,
    name: d.name,
    region: d.region ?? d.admin1 ?? null,
    lat: d.lat,
    lng: d.lng,
    routes: d.routeCount,
    sectors: d.sectors.map((s) => ({ name: s.name, pt: s.pt ?? null, routes: s.routes.length })),
    starts,
    savedAt: extra.savedAt,
    topoBytes: extra.topoBytes,
    packId: extra.packId,
    packBytes: extra.packBytes,
    attachments: previous?.attachments ?? [],
  };
}

export interface SavedFeatureProps {
  kind: 'crag' | 'sector' | 'start';
  uid: string;
  /** Label: the crag's name, "Ionescu · 26 routes", or the route's number. */
  n?: string;
  o?: number;
  bd?: number;
}

/** Everything the base map draws for the saved crags, as one GeoJSON source. */
export function savedCragsGeoJSON(
  saved: readonly SavedCrag[],
): GeoJSON.FeatureCollection<GeoJSON.Point, SavedFeatureProps> {
  const features: GeoJSON.Feature<GeoJSON.Point, SavedFeatureProps>[] = [];
  const point = (c: [number, number], p: SavedFeatureProps) =>
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: p });
  for (const c of saved) {
    point([c.lng, c.lat], { kind: 'crag', uid: c.uid, n: c.name });
    // One sector is the crag itself: no pin on top of its badge.
    if (c.sectors.length > 1) {
      for (const s of c.sectors) {
        if (s.pt === null) continue;
        point(s.pt, {
          kind: 'sector',
          uid: c.uid,
          n:
            s.routes > 0
              ? `${s.name} · ${s.routes} ${s.routes === 1 ? 'route' : 'routes'}`
              : s.name,
        });
      }
    }
    for (const [lng, lat, o, bd] of c.starts) {
      point([lng, lat], { kind: 'start', uid: c.uid, ...(o > 0 ? { o } : {}), bd });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Saved crags whose topo has a newer version in the tiles. */
export function updateAvailable(saved: SavedCrag, tileVersion: string | null | undefined): boolean {
  return !!tileVersion && saved.version !== '' && tileVersion !== saved.version;
}

/** The crag & approach map (owner decision Q1-A): 2 km around the crag and its sectors. */
export const CRAG_MAP_MARGIN_M = 2000;
export const CRAG_MAP_ZOOMS = { min: 12, max: 16 } as const;

export function cragMapBounds(
  points: readonly [number, number][],
  marginM = CRAG_MAP_MARGIN_M,
): { minLng: number; minLat: number; maxLng: number; maxLat: number } {
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const dLat = marginM / 111_320;
  const mid = ((minLat + maxLat) / 2) * (Math.PI / 180);
  const dLng = marginM / (111_320 * Math.max(0.05, Math.cos(mid)));
  return {
    minLng: Math.min(...lngs) - dLng,
    minLat: minLat - dLat,
    maxLng: Math.max(...lngs) + dLng,
    maxLat: maxLat + dLat,
  };
}

/** Every point a crag's map pack must cover: the crag and its sectors. */
export function cragPoints(d: Pick<CragDetail, 'lat' | 'lng' | 'sectors'>): [number, number][] {
  return [[d.lng, d.lat], ...d.sectors.flatMap((s) => (s.pt ? [s.pt] : []))];
}

export function savedBytes(c: SavedCrag): number {
  return c.topoBytes + c.packBytes + c.attachments.reduce((n, a) => n + a.bytes, 0);
}
