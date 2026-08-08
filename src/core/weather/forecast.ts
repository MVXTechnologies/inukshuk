import { haversineMeters } from '@core/geo/geomath';
import type { LatLng } from '@core/models';

/**
 * ECCC citypage forecast parsing (meteo M1 tap-card). The GeoMet OGC API
 * (`api.weather.gc.ca`, collection `citypageweather-realtime`) serves the
 * official Environment Canada city-page forecasts as GeoJSON features — no
 * key, EN/FR. Every leaf value is bilingual (`{ en, fr }` records), hence the
 * unwrap helpers below. Parsers are total: any JSON in, a usable view model
 * (or null) out — network junk must never crash the card.
 */

export const CITYPAGE_COLLECTION_URL =
  'https://api.weather.gc.ca/collections/citypageweather-realtime/items';

/** How many forecast periods the tap-card shows (Tonight / Sunday / ...). */
export const MAX_FORECAST_PERIODS = 4;

/**
 * Items query for the citypage sites around a tapped point: a bbox big enough
 * to always catch a few sites (citypages blanket populated Canada; ±1° covers
 * ~100 km), nearest-site selection happens client-side in
 * {@link parseCitypageCollection}.
 */
export function citypageItemsUrl(at: LatLng, radiusDeg = 1): string {
  const minLat = Math.max(-90, at.latitude - radiusDeg);
  const maxLat = Math.min(90, at.latitude + radiusDeg);
  const bbox = [at.longitude - radiusDeg, minLat, at.longitude + radiusDeg, maxLat].join(',');
  return `${CITYPAGE_COLLECTION_URL}?f=json&lang=en&limit=20&bbox=${bbox}`;
}

export interface ForecastCurrent {
  /** Observed air temperature, °C (the API is metric). */
  temperatureC: number | null;
  /** Text condition ("Light Rainshower") — often absent for smaller sites. */
  condition: string | null;
  relativeHumidityPct: number | null;
  /** One-line wind summary, e.g. "SW 4 km/h, gusts 32". */
  windSummary: string | null;
  /** Observation timestamp, epoch ms. */
  observedAtMs: number | null;
}

export interface ForecastPeriod {
  /** Period name as ECCC words it: "Tonight", "Sunday", ... */
  name: string;
  /** Abbreviated summary ("Chance of showers"). */
  summary: string | null;
  /** Temperature sentence ("Low 19."). */
  temperatureSummary: string | null;
}

export interface PointForecast {
  /** Site (citypage) name, e.g. "Vanier". */
  site: string;
  /** Forecast region ("Québec area"). */
  region: string | null;
  /** Distance from the queried point to the site, metres. */
  distanceM: number;
  /** When ECCC last refreshed the page, epoch ms — the card's "as of". */
  updatedAtMs: number | null;
  current: ForecastCurrent | null;
  periods: ForecastPeriod[];
}

type Raw = Record<string, unknown>;

function isRecord(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Unwrap ECCC's bilingual `{ en, fr }` leaves; pass primitives through. */
function en(v: unknown): unknown {
  return isRecord(v) && 'en' in v ? v.en : v;
}

function str(v: unknown): string | null {
  const u = en(v);
  return typeof u === 'string' && u.trim() !== '' ? u : null;
}

function num(v: unknown): number | null {
  const u = en(v);
  return typeof u === 'number' && Number.isFinite(u) ? u : null;
}

function parseWindSummary(wind: unknown): string | null {
  if (!isRecord(wind)) return null;
  const speedRec = isRecord(wind.speed) ? wind.speed : {};
  const speed = num(speedRec.value);
  if (speed === null) return null;
  const units = str(speedRec.units) ?? 'km/h';
  const direction = isRecord(wind.direction) ? str(wind.direction.value) : null;
  const gust = isRecord(wind.gust) ? num(wind.gust.value) : null;
  const head = direction !== null ? `${direction} ${speed} ${units}` : `${speed} ${units}`;
  return gust !== null && gust > speed ? `${head}, gusts ${gust}` : head;
}

function parseCurrent(cc: unknown): ForecastCurrent | null {
  if (!isRecord(cc)) return null;
  const temperatureC = isRecord(cc.temperature) ? num(cc.temperature.value) : null;
  const condition = str(cc.condition);
  const relativeHumidityPct = isRecord(cc.relativeHumidity) ? num(cc.relativeHumidity.value) : null;
  const windSummary = parseWindSummary(cc.wind);
  const observedAtIso = str(cc.timestamp);
  const observedAtMs = observedAtIso !== null ? Date.parse(observedAtIso) : NaN;
  if (temperatureC === null && condition === null && windSummary === null) return null;
  return {
    temperatureC,
    condition,
    relativeHumidityPct,
    windSummary,
    observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : null,
  };
}

function parsePeriods(group: unknown): ForecastPeriod[] {
  if (!isRecord(group) || !Array.isArray(group.forecasts)) return [];
  const out: ForecastPeriod[] = [];
  for (const fc of group.forecasts) {
    if (out.length >= MAX_FORECAST_PERIODS) break;
    if (!isRecord(fc)) continue;
    const name = isRecord(fc.period) ? str(fc.period.textForecastName) : null;
    if (name === null) continue;
    const summary = isRecord(fc.abbreviatedForecast) ? str(fc.abbreviatedForecast.textSummary) : null;
    const temperatureSummary = isRecord(fc.temperatures) ? str(fc.temperatures.textSummary) : null;
    out.push({ name, summary, temperatureSummary });
  }
  return out;
}

/** Parse one citypage feature into the card's view model (null = unusable). */
export function parseCitypageFeature(feature: unknown, at: LatLng): PointForecast | null {
  if (!isRecord(feature) || !isRecord(feature.properties)) return null;
  const props = feature.properties;
  const site = str(props.name);
  if (site === null) return null;
  const coords = isRecord(feature.geometry) ? feature.geometry.coordinates : null;
  if (!Array.isArray(coords) || typeof coords[0] !== 'number' || typeof coords[1] !== 'number') {
    return null;
  }
  const sitePos: LatLng = { longitude: coords[0], latitude: coords[1] };
  const updatedIso = str(props.lastUpdated);
  const updatedAtMs = updatedIso !== null ? Date.parse(updatedIso) : NaN;
  return {
    site,
    region: str(props.region),
    distanceM: haversineMeters(at, sitePos),
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : null,
    current: parseCurrent(props.currentConditions),
    periods: parsePeriods(props.forecastGroup),
  };
}

/**
 * Parse a citypage items response and return the forecast of the site
 * nearest to the tapped point (null when the response holds no usable site).
 */
export function parseCitypageCollection(json: unknown, at: LatLng): PointForecast | null {
  if (!isRecord(json) || !Array.isArray(json.features)) return null;
  let best: PointForecast | null = null;
  for (const feature of json.features) {
    const parsed = parseCitypageFeature(feature, at);
    if (parsed !== null && (best === null || parsed.distanceM < best.distanceM)) best = parsed;
  }
  return best;
}
