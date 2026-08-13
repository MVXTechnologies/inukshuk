import { GEOMET_WMS_ENDPOINT } from '@core/geo/weatherLayers';
import type { LngLat } from '@core/models';

/**
 * The weather drape as ONE georeferenced image per frame, instead of a WMS
 * tile grid (perf work 2026-08-11, owner: "can you find a method to reduce
 * the tile fetch time?").
 *
 * Measured against GeoMet (Quebec City viewport, warm connection, PNG):
 *
 * | per frame                     | requests | wall      | bytes  |
 * | 256 px `{bbox-epsg-3857}` grid|    15    | 1.5–2.1 s | 178 KB |
 * | 512 px grid                   |     6    | 0.86 s    | 288 KB |
 * | one viewport GetMap           |     1    | 0.48–0.8 s| 181 KB |
 *
 * The payloads are trivial (a radar tile is 334 B–2 KB); what costs is the
 * ROUND TRIP — GeoMet is HTTP/1.1 with no h2 multiplexing, sends no ETag or
 * Last-Modified, and renders every GetMap from scratch (a repeat of the same
 * URL is not faster). So the only levers that move the needle are "ask for
 * fewer things" and "ask before you need them", and one GetMap is both: it
 * cuts the request count 15× and it is a single URL a prefetcher can warm
 * (see `@data/weatherFrames`).
 *
 * An image source is anchored to fixed corners, so it does not follow a pan
 * the way a tile source does; the anchor is padded past the viewport
 * ({@link DRAPE_PAD}) and re-taken on camera settle, exactly like the marine
 * depth chart (`@features/map/marine`) which already ships this way.
 *
 * Pure: URL/box/pixel maths only, so the snapping and the re-anchor rule stay
 * unit-tested rather than eyeballed on a boat.
 */

/** A geographic box in degrees — the shape MapLibre's settled bounds give. */
export interface DrapeView {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Where one drape image is pinned, and how many pixels to ask GeoMet for. */
export interface DrapeAnchor {
  /** EPSG:3857 GetMap bbox: [minX, minY, maxX, maxY] in metres. */
  merc: readonly [number, number, number, number];
  /** GetMap WIDTH — square pixels in mercator, so no aspect distortion. */
  widthPx: number;
  /** GetMap HEIGHT. */
  heightPx: number;
  /** The same box in degrees (the re-anchor check works in lat/lng). */
  bbox: DrapeView;
  /** ImageSource corners: top-left, top-right, bottom-right, bottom-left. */
  coordinates: [LngLat, LngLat, LngLat, LngLat];
}

/** Fetch this much more than the viewport, so short pans stay covered. */
export const DRAPE_PAD = 1.2;
/**
 * Image pixels per viewport POINT. The fields are smooth and coarse (HRDPS
 * is 2.5 km, radar 1 km — a phone viewport at z9 spans ~50 km, i.e. ~50
 * radar cells across), so asking for more than ~1.5 device-independent
 * pixels per point buys bytes, not detail: the 768x1280 and 384x640 renders
 * of the same box measured within noise of each other in time (0.48 s vs
 * 0.65 s) but 181 KB vs 80 KB.
 */
export const DRAPE_PX_PER_PT = 1.5;
/**
 * Long-axis cap. It has to stay above what the tile grid used to give: a
 * 256 px tile source renders one tile pixel per CSS point, so the drape must
 * clear ~1 px/pt AFTER the padding is accounted for (a 844 pt screen needs
 * ~1100 px just to break even). 1280 keeps a comfortable margin, and the
 * measurements say the size is nearly free in time — 768x1280 and 384x640
 * of the same box came back within noise of each other.
 */
export const DRAPE_MAX_PX = 1280;
/** Long-axis floor — a degenerate GetMap is not worth a round trip. */
export const DRAPE_MIN_PX = 256;
/** Total-pixel cap (a very wide viewport must not ask for a huge raster). */
export const DRAPE_MAX_AREA_PX = 1_600_000;
/** GetMap WIDTH/HEIGHT snap, so camera jitter cannot churn the URL. */
const PX_QUANT = 32;
/** Mercator blows up at the poles; every anchor stays inside this. */
const LAT_LIMIT = 84;
/** Earth radius used by EPSG:3857 (a sphere, by definition of the CRS). */
const R = 6378137;

const mercX = (lng: number): number => (lng * Math.PI * R) / 180;
const mercY = (lat: number): number => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/**
 * Snap a span UP to a quarter-octave ladder. Zooming inside one rung leaves
 * the anchor (and therefore every frame URL, and therefore the whole warmed
 * cache) untouched; crossing a rung costs one re-anchor.
 */
function snapSpan(span: number): number {
  return 2 ** (Math.ceil(Math.log2(span) * 4) / 4);
}

/** Snap a centre to a grid — a pan under 1/8 of the box is free. */
function snapCentre(v: number, span: number): number {
  const grid = span / 8;
  return Math.round(v / grid) * grid;
}

function quantPx(v: number): number {
  return Math.max(DRAPE_MIN_PX, Math.round(v / PX_QUANT) * PX_QUANT);
}

/**
 * The padded, snapped anchor for a viewport, or null when the viewport is
 * degenerate (zero span, NaN bounds, an antimeridian wrap MapLibre reports
 * as west > east). Callers keep whatever frame is already on screen — the
 * silent-degrade rule.
 */
export function weatherDrapeAnchor(
  view: DrapeView,
  viewportPt: { width: number; height: number },
): DrapeAnchor | null {
  const lonSpan = view.east - view.west;
  const latSpan = view.north - view.south;
  if (!Number.isFinite(lonSpan) || !Number.isFinite(latSpan)) return null;
  if (!(lonSpan > 0) || !(latSpan > 0)) return null;
  if (!(viewportPt.width > 0) || !(viewportPt.height > 0)) return null;

  const lonSnap = Math.min(360, snapSpan(lonSpan * DRAPE_PAD));
  const latSnap = Math.min(2 * LAT_LIMIT, snapSpan(latSpan * DRAPE_PAD));
  const cx = snapCentre((view.west + view.east) / 2, lonSnap);
  const cy = snapCentre((view.south + view.north) / 2, latSnap);

  const west = Math.max(-180, cx - lonSnap / 2);
  const east = Math.min(180, cx + lonSnap / 2);
  const south = Math.max(-LAT_LIMIT, cy - latSnap / 2);
  const north = Math.min(LAT_LIMIT, cy + latSnap / 2);
  if (!(east > west) || !(north > south)) return null;

  const merc: [number, number, number, number] = [
    mercX(west),
    mercY(south),
    mercX(east),
    mercY(north),
  ];
  const mercW = merc[2] - merc[0];
  const mercH = merc[3] - merc[1];
  // What the VIEWPORT occupies of that box, so the on-screen resolution is
  // the thing being targeted rather than the padded box's.
  const viewMercW = mercX(view.east) - mercX(view.west);
  if (!(mercW > 0) || !(mercH > 0) || !(viewMercW > 0)) return null;

  let widthPx = viewportPt.width * DRAPE_PX_PER_PT * (mercW / viewMercW);
  let heightPx = (widthPx * mercH) / mercW;
  const longest = Math.max(widthPx, heightPx);
  if (longest > DRAPE_MAX_PX) {
    const k = DRAPE_MAX_PX / longest;
    widthPx *= k;
    heightPx *= k;
  }
  const area = widthPx * heightPx;
  if (area > DRAPE_MAX_AREA_PX) {
    const k = Math.sqrt(DRAPE_MAX_AREA_PX / area);
    widthPx *= k;
    heightPx *= k;
  }

  return {
    merc,
    widthPx: quantPx(widthPx),
    heightPx: quantPx(heightPx),
    bbox: { west, south, east, north },
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
  };
}

/**
 * Should the drape re-anchor? Either the viewport escaped the padded box
 * (a pan past the padding, or a zoom-out), or it shrank far inside it (a
 * zoom-in, where a tighter GetMap buys real resolution).
 */
export function drapeNeedsReanchor(anchor: DrapeAnchor, view: DrapeView): boolean {
  const b = anchor.bbox;
  if (view.west < b.west || view.east > b.east) return true;
  if (view.south < b.south || view.north > b.north) return true;
  const anchorSpan = Math.max(b.east - b.west, b.north - b.south);
  const viewSpan = Math.max(view.east - view.west, view.north - view.south);
  return viewSpan > 0 && anchorSpan / viewSpan > 3 * DRAPE_PAD;
}

/**
 * The single-GetMap URL for one frame of a WMS layer at an anchor. Without
 * `time` GeoMet serves its latest frame (the static path), exactly as the
 * tile template did.
 */
export function weatherDrapeUrl(wmsLayer: string, anchor: DrapeAnchor, time?: string): string {
  const bbox = anchor.merc.map((v) => v.toFixed(1)).join(',');
  const params = [
    'service=WMS',
    'version=1.3.0',
    'request=GetMap',
    `layers=${encodeURIComponent(wmsLayer)}`,
    'crs=EPSG:3857',
    `bbox=${bbox}`,
    `width=${anchor.widthPx}`,
    `height=${anchor.heightPx}`,
    // PNG, not WebP: GeoMet offers image/webp, and it does shrink a radar
    // frame 4x (1.6 KB vs 7.4 KB) — but the server-side encode costs it. On
    // the continuous fields it measured 0.95–1.3 s per frame against 0.48–0.8 s
    // for PNG, i.e. it trades the exact thing being optimised for bytes that
    // were never the bottleneck. Rejected.
    'format=image/png',
    'transparent=true',
    ...(time !== undefined ? [`time=${encodeURIComponent(time)}`] : []),
  ];
  return `${GEOMET_WMS_ENDPOINT}?${params.join('&')}`;
}
