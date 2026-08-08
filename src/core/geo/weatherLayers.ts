import type { LatLng } from '@core/models';

/**
 * ECCC GeoMet weather layers the map can drape as WMS overlays (meteo M1).
 * All served by Environment and Climate Change Canada's GeoMet WMS —
 * radar composites (1 km, 6-min updates, ~3 h window) and HRDPS model
 * fields (2.5 km, hourly) — free, commercial use allowed, attribution-only
 * (ECCC end-use licence v2.1). Usage policy: ~1 req/s sustained, meaningful
 * User-Agent, client-side caching — which is why radar animation is bounded
 * to a handful of pre-listed frames (see {@link animationFrames}).
 *
 * Same catalog discipline as `trailNetworks.ts`: a small const list, an id
 * type derived from it, and a sanitize helper for settings hydration.
 */

export const GEOMET_WMS_ENDPOINT = 'https://geo.weather.gc.ca/geomet';

/** Required credit line for anything rendered from GeoMet (licence v2.1). */
export const ECCC_ATTRIBUTION = 'Data Source: Environment and Climate Change Canada';

export const WEATHER_LAYERS = [
  // Labels double as Maestro/a11y match targets — keep them free of regex
  // metacharacters (Maestro treats text matchers as regexes).
  { id: 'radar-rain', label: 'Rain radar', wmsLayer: 'RADAR_1KM_RRAI', animatable: true },
  { id: 'radar-snow', label: 'Snow radar', wmsLayer: 'RADAR_1KM_RSNO', animatable: true },
  { id: 'wind', label: 'Wind', wmsLayer: 'HRDPS.CONTINENTAL_UU', animatable: false },
  { id: 'precip', label: 'Precipitation', wmsLayer: 'HRDPS.CONTINENTAL_PR', animatable: false },
] as const;

export type WeatherLayerId = (typeof WEATHER_LAYERS)[number]['id'];
export type WeatherLayer = (typeof WEATHER_LAYERS)[number];

export const WEATHER_LAYER_IDS: readonly WeatherLayerId[] = WEATHER_LAYERS.map((l) => l.id);

export function isWeatherLayerId(v: unknown): v is WeatherLayerId {
  return typeof v === 'string' && (WEATHER_LAYER_IDS as readonly string[]).includes(v);
}

/**
 * Drop junk from the persisted weather-layer choice (settings hydration).
 * The migration ladder only checks `typeof value === typeof fallback`, and the
 * default here is `null` (typeof 'object') — so any object-shaped junk would
 * slip through without this deep check.
 */
export function sanitizeWeatherLayer(v: unknown): WeatherLayerId | null {
  return isWeatherLayerId(v) ? v : null;
}

export function weatherLayerById(id: WeatherLayerId): WeatherLayer {
  // The ids are derived from the catalog, so the lookup can't actually miss;
  // the fallback keeps noUncheckedIndexedAccess honest without a cast.
  return WEATHER_LAYERS.find((l) => l.id === id) ?? WEATHER_LAYERS[0];
}

/**
 * GetMap tile-URL template for a weather layer, using MapLibre's
 * `{bbox-epsg-3857}` templating so a plain raster source fetches WMS tiles.
 * Without `time`, GeoMet serves the latest frame (static mode — zero extra
 * requests). With `time`, the URL pins one animation frame; changing frames
 * means swapping the source URL (WMS params aren't re-templated by `setUrl`),
 * which flows naturally through the MapScreen style-memo rebuild.
 */
export function weatherTileUrl(id: WeatherLayerId, time?: string): string {
  const layer = weatherLayerById(id);
  const params = [
    'service=WMS',
    'version=1.3.0',
    'request=GetMap',
    `layers=${encodeURIComponent(layer.wmsLayer)}`,
    'crs=EPSG:3857',
    'bbox={bbox-epsg-3857}',
    'width=256',
    'height=256',
    'format=image/png',
    'transparent=true',
    ...(time !== undefined ? [`time=${encodeURIComponent(time)}`] : []),
  ];
  return `${GEOMET_WMS_ENDPOINT}?${params.join('&')}`;
}

/** Layer-scoped GetCapabilities URL (GeoMet supports `layer=` to keep it small). */
export function weatherCapabilitiesUrl(id: WeatherLayerId): string {
  const layer = weatherLayerById(id);
  return `${GEOMET_WMS_ENDPOINT}?service=WMS&version=1.3.0&request=GetCapabilities&layer=${encodeURIComponent(layer.wmsLayer)}`;
}

/** A WMS time dimension: an ISO interval with a step and a server default. */
export interface WmsTimeDimension {
  /** Epoch ms of the first available frame. */
  startMs: number;
  /** Epoch ms of the latest available frame. */
  endMs: number;
  /** Frame step in ms (from the ISO 8601 duration, e.g. PT6M = 360000). */
  stepMs: number;
  /** The server's default TIME (usually the latest frame), verbatim. */
  defaultTime: string | null;
}

/**
 * Parse an ISO 8601 duration (the subset GeoMet uses: days/hours/minutes/
 * seconds) into milliseconds. Returns null for anything unrecognized.
 */
export function parseIsoDuration(v: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  if (d === undefined && h === undefined && min === undefined && s === undefined) return null;
  const ms =
    Number(d ?? 0) * 86_400_000 +
    Number(h ?? 0) * 3_600_000 +
    Number(min ?? 0) * 60_000 +
    Number(s ?? 0) * 1_000;
  return ms > 0 ? ms : null;
}

/**
 * Extract the `time` dimension from a WMS GetCapabilities document. Pure
 * string parsing (no DOM — `src/core` runs in plain Node under Jest): finds
 * `<Dimension name="time" ...>start/end/period</Dimension>` and reads the
 * interval. When the content lists several comma-separated intervals, the
 * last (most recent) one wins. Returns null on any malformed input — callers
 * degrade to the static latest frame.
 */
export function parseTimeDimension(xml: string): WmsTimeDimension | null {
  const tagRe = /<Dimension\b([^>]*)>([^<]*)<\/Dimension>/g;
  for (let m = tagRe.exec(xml); m !== null; m = tagRe.exec(xml)) {
    const [, attrs = '', content = ''] = m;
    if (!/name\s*=\s*"time"/.test(attrs)) continue;
    const defaultMatch = /default\s*=\s*"([^"]*)"/.exec(attrs);
    const intervals = content.trim().split(',');
    const last = intervals[intervals.length - 1]?.trim();
    if (last === undefined) return null;
    const parts = last.split('/');
    if (parts.length !== 3) return null;
    const [startIso, endIso, period] = parts;
    const startMs = Date.parse(startIso ?? '');
    const endMs = Date.parse(endIso ?? '');
    const stepMs = parseIsoDuration(period ?? '');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || stepMs === null) return null;
    if (endMs < startMs) return null;
    return { startMs, endMs, stepMs, defaultTime: defaultMatch?.[1] ?? null };
  }
  return null;
}

/** Format an epoch-ms timestamp the way GeoMet's TIME parameter expects. */
export function formatWmsTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('.000Z', 'Z');
}

/**
 * The bounded animation frame list: the last `maxFrames` available frames,
 * oldest first, always ending on the latest frame. Bounded by design — the
 * GeoMet usage policy (~1 req/s) rules out open-ended scrubbing.
 */
export function animationFrames(dim: WmsTimeDimension, maxFrames: number): string[] {
  if (maxFrames <= 0 || dim.stepMs <= 0) return [];
  const available = Math.floor((dim.endMs - dim.startMs) / dim.stepMs) + 1;
  const count = Math.min(maxFrames, available);
  const frames: string[] = [];
  for (let i = count - 1; i >= 0; i--) frames.push(formatWmsTime(dim.endMs - i * dim.stepMs));
  return frames;
}

/** Spherical-mercator (EPSG:3857) projection of a lat/lng, in metres. */
export function toWebMercator(p: LatLng): { x: number; y: number } {
  const R = 6378137;
  const x = (p.longitude * Math.PI * R) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (p.latitude * Math.PI) / 360));
  return { x, y };
}

/**
 * WMS GetFeatureInfo URL for the gridded value under a point (the forecast
 * tap-card's "value at this spot" line). A small square query window centred
 * on the point, JSON info format.
 */
export function getFeatureInfoUrl(id: WeatherLayerId, at: LatLng): string {
  const layer = weatherLayerById(id);
  const { x, y } = toWebMercator(at);
  const half = 10_000; // metres — ~1 grid cell margin around the point
  const size = 101;
  const bbox = [x - half, y - half, x + half, y + half].map((v) => v.toFixed(1)).join(',');
  const params = [
    'service=WMS',
    'version=1.3.0',
    'request=GetFeatureInfo',
    `layers=${encodeURIComponent(layer.wmsLayer)}`,
    `query_layers=${encodeURIComponent(layer.wmsLayer)}`,
    'crs=EPSG:3857',
    `bbox=${bbox}`,
    `width=${size}`,
    `height=${size}`,
    `i=${(size - 1) / 2}`,
    `j=${(size - 1) / 2}`,
    'info_format=application/json',
  ];
  return `${GEOMET_WMS_ENDPOINT}?${params.join('&')}`;
}

/** A gridded value read back from GetFeatureInfo. */
export interface FeatureInfoValue {
  /** The raw numeric value at the point. */
  value: number;
  /** Human label, e.g. "Air temperature at 2m above ground [°C]". */
  label: string | null;
  /** Valid time of the value, verbatim ISO string when present. */
  time: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse a GeoMet GetFeatureInfo JSON response (a FeatureCollection with one
 * point feature carrying `value` / `title_en` / `time` properties). Null when
 * the shape is unexpected — the tap-card just omits the value line.
 */
export function parseFeatureInfo(json: unknown): FeatureInfoValue | null {
  if (!isRecord(json) || !Array.isArray(json.features)) return null;
  const feature = json.features[0];
  if (!isRecord(feature) || !isRecord(feature.properties)) return null;
  const props = feature.properties;
  if (typeof props.value !== 'number' || !Number.isFinite(props.value)) return null;
  // title_en reads "LAYER.NAME - Human label [units]" — drop the layer prefix.
  let label: string | null = null;
  if (typeof props.title_en === 'string') {
    const sep = props.title_en.indexOf(' - ');
    label = sep >= 0 ? props.title_en.slice(sep + 3) : props.title_en;
  }
  return {
    value: props.value,
    label,
    time: typeof props.time === 'string' ? props.time : null,
  };
}
