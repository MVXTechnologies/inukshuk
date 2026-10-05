/**
 * Canadian tide stations, LIVE from the Canadian Hydrographic Service (owner
 * decision 2026-10-05): the phone fetches CHS IWLS itself — the station list
 * in one call, a station's datums and levels when its card opens — and keeps
 * its own copy for offline use. Nothing CHS ever passes through our tiles,
 * side files or Worker (PLAN Q1 = c).
 *
 * Endpoints (verified 2026-10-04/05, research/tide-sources-notes.md §1):
 *   GET /api/v1/stations                  all 1,575 stations (one call)
 *   GET /api/v1/stations/{id}/metadata    datums (CD offsets) + heights (levels above CD)
 *   GET /api/v1/height-types              level codes for `heights[].heightTypeId`
 * Rate limit 3 req/s and 30 req/min: {@link createRateLimiter}.
 *
 * Field rules kept here:
 * - every number is CHS's own, printed at CHS's stated precision
 *   (`valuePrecision`, `offsetPrecision`);
 * - offsets are CD in X (H_X = H_CD + CD_in_X), CHS's sign convention;
 * - the ellipsoidal CD is CHS's published NAD83(CSRS) offset only (no
 *   derivation on the device), labelled as CHS's;
 * - CHS's CGVD2013 offsets sit ~4 cm below NRCan's levelled CGVD2013 heights
 *   on shared benchmarks (validation, 20 marks): the card says so and never
 *   mixes CHS values with NRCan's;
 * - the CHS notice (licence) and "Not for navigation" are on every card.
 *
 * Pure: parsers are total (any JSON in, usable result or null/empty out).
 */
import type { TideSource } from './catalog';
import type { EllipsoidalCd, PublishedLevel, StationKind, TideStation } from './station';

export const CHS_API = 'https://api-iwls.dfo-mpo.gc.ca/api/v1';

/** Source index of CHS stations: outside the tile catalogue on purpose (never in our tiles). */
export const CHS_SOURCE_INDEX = 100;

/** The CHS notice the licence requires on any derivative product (verbatim, User filled in). */
export const CHS_NOTICE =
  'This product is not to be used for navigation. This product was made by or for the User ' +
  '[MVX Technologies (Inukshuk)] and contains intellectual property (Data) of the Canadian ' +
  'Hydrographic Service of the Department of Fisheries and Oceans. The copyrights in the Data are ' +
  'and remain the property of His Majesty the King in Right of Canada and shall not be sold, ' +
  'licensed, leased, assigned or given to a third party. The incorporation of the Data in this ' +
  'product does not constitute an endorsement or an approval of this product by the Canadian ' +
  'Hydrographic Service, the Department of Fisheries and Oceans or His Majesty the King in Right ' +
  'of Canada.';

export const CHS_SOURCE: TideSource = {
  key: 'ca-chs',
  name: 'CHS',
  network: 'Fisheries and Oceans Canada · IWLS (live)',
  licence: 'CHS Licence Agreement',
  attribution: 'Contains data of the Canadian Hydrographic Service (DFO), fetched live from IWLS',
  licenceUrl: 'https://www.tides.gc.ca/en/licence-agreement',
  page: 'https://www.tides.gc.ca/en/stations/{id}',
  disclaimer: CHS_NOTICE,
};

/** CHS datum codes the card understands (others — SD, ARBI, GEOD, DPWD… — are skipped). */
const NATIONAL_CODES = ['CGVD2013', 'CGVD28', 'IGLD85'] as const;
const ELLIPSOID_CODE = 'NAD83_CSRS';
/** Level codes shown in the table, high → low by value; recorded extremes go apart. */
const EXTREME_CODES: Record<string, string> = { HRWL: 'HOWL', LRWL: 'LOWL' };

export const CHS_CGVD2013_NOTE =
  'CHS CGVD2013 offsets sit about 4 cm below NRCan levelled CGVD2013 heights on shared benchmarks ' +
  '(20 marks, QC/NS/BC); this table uses CHS values only.';

export function chsStationsUrl(): string {
  return `${CHS_API}/stations`;
}
export function chsMetadataUrl(iwlsId: string): string {
  return `${CHS_API}/stations/${encodeURIComponent(iwlsId)}/metadata`;
}
export function chsHeightTypesUrl(): string {
  return `${CHS_API}/height-types`;
}

type Raw = Record<string, unknown>;
const rec = (v: unknown): Raw | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A CHS value at CHS's stated precision (default 2), e.g. (−1.5, 2) → "-1.50". */
export function chsText(value: number, precision: unknown): string {
  const p =
    typeof precision === 'number' && Number.isInteger(precision) && precision >= 0 && precision <= 4
      ? precision
      : 2;
  const t = value.toFixed(p);
  return /^-0(\.0*)?$/.test(t) ? t.slice(1) : t;
}

export interface ChsListFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  /** The tile schema's keys (`./station`), so one parser and one style serve both. */
  properties: Record<string, string | number>;
}

export interface ChsFeatureCollection {
  type: 'FeatureCollection';
  features: ChsListFeature[];
}

/**
 * /stations → map features (tile-schema keys + `ci`, the IWLS id). Kind:
 * a live gauge when operating with an observed series, a prediction station
 * when it has high/low predictions, historic otherwise (datums may remain —
 * Lauzon, the Québec City reference port, is discontinued).
 */
export function parseChsStationList(json: unknown): ChsFeatureCollection {
  const features: ChsListFeature[] = [];
  if (Array.isArray(json)) {
    for (const raw of json) {
      const s = rec(raw);
      if (!s) continue;
      const id = str(s.id);
      const code = str(s.code);
      const name = str(s.officialName);
      const lat = fin(s.latitude);
      const lng = fin(s.longitude);
      if (!id || !code || !name || lat === null || lng === null) continue;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      const series = Array.isArray(s.timeSeries)
        ? s.timeSeries.map((t) => str(rec(t)?.code)).filter((c): c is string => c !== null)
        : [];
      const live = s.operating === true && series.includes('wlo');
      const kind: StationKind = live ? 'gauge' : series.includes('wlp-hilo') ? 'ref' : 'hist';
      const properties: Record<string, string | number> = {
        i: code,
        ci: id,
        s: CHS_SOURCE_INDEX,
        n: name.slice(0, 60),
        k: kind,
        cn: 'cd-ca',
        y: lat,
        x: lng,
      };
      if (live) properties.lv = 'chs';
      if (series.includes('wlp-hilo')) properties.hl = 1;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties,
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** /height-types → id → code. */
export function parseChsHeightTypes(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(json)) return out;
  for (const raw of json) {
    const h = rec(raw);
    const id = str(h?.id);
    const code = str(h?.code);
    if (id && code) out.set(id, code);
  }
  return out;
}

export interface ChsDetail {
  levels: PublishedLevel[];
  extremes: PublishedLevel[];
  national: { datum: string; text: string }[];
  ellipsoid?: EllipsoidalCd;
  referencePortId?: string;
  isReferencePort: boolean;
}

/** /stations/{id}/metadata → CHS's published levels and CD offsets, verbatim. */
export function parseChsMetadata(
  json: unknown,
  heightTypes: ReadonlyMap<string, string>,
): ChsDetail {
  const m = rec(json);
  const detail: ChsDetail = { levels: [], extremes: [], national: [], isReferencePort: false };
  if (!m) return detail;
  const levels: { code: string; text: string; value: number; date?: string }[] = [];
  for (const raw of Array.isArray(m.heights) ? m.heights : []) {
    const h = rec(raw);
    const code = heightTypes.get(str(h?.heightTypeId) ?? '');
    const value = fin(h?.value);
    if (!code || value === null) continue;
    const date = str(h?.date);
    const entry = {
      code,
      value,
      text: chsText(value, h?.valuePrecision),
      ...(date ? { date: date.slice(0, 10) } : {}),
    };
    if (code in EXTREME_CODES) {
      detail.extremes.push({
        code: EXTREME_CODES[code] ?? code,
        text: entry.text,
        ...(entry.date ? { date: entry.date } : {}),
      });
    } else if (!date) {
      levels.push(entry);
    }
  }
  levels.sort((a, b) => b.value - a.value);
  detail.levels = levels.map(({ code, text }) => ({ code, text }));
  detail.extremes.sort((a, b) => (a.code === b.code ? 0 : a.code === 'HOWL' ? -1 : 1));
  const datums = Array.isArray(m.datums)
    ? m.datums.map(rec).filter((d): d is Raw => d !== null)
    : [];
  for (const code of NATIONAL_CODES) {
    const d = datums.find((x) => x.code === code);
    const v = fin(d?.offset);
    if (d && v !== null) detail.national.push({ datum: code, text: chsText(v, d.offsetPrecision) });
  }
  const ell = datums.find((x) => x.code === ELLIPSOID_CODE);
  const ev = fin(ell?.offset);
  if (ell && ev !== null) {
    detail.ellipsoid = {
      text: chsText(ev, ell.offsetPrecision),
      frame: 'NAD83(CSRS)',
      how: 'published',
      checkedBy: '',
      deltaM: Number.NaN,
      basis: 'CHS IWLS NAD83_CSRS offset (epoch not stated by CHS)',
    };
  }
  const rp = str(m.referencePortStationId);
  if (rp && rp !== str(m.id)) detail.referencePortId = rp;
  detail.isReferencePort = m.isTideTableReferencePort === true;
  return detail;
}

/** A tapped CHS stub + its metadata (+ its reference port's levels) → the card's station. */
export function chsStation(
  stub: TideStation,
  detail: ChsDetail,
  refPort?: { id: string; name: string; detail: ChsDetail },
): TideStation {
  const s: TideStation = {
    ...stub,
    levels: detail.levels,
    extremes: detail.extremes,
    national: detail.national,
    flags: [...stub.flags, 'chs'],
  };
  if (detail.ellipsoid) s.ellipsoid = detail.ellipsoid;
  else delete s.ellipsoid;
  if (refPort && refPort.detail.levels.length > 0) {
    s.refPort = { id: refPort.id, name: refPort.name, levels: refPort.detail.levels };
  }
  return s;
}

/** A sliding-window limiter for CHS's 30 requests/min (and 3/s). Pure: the caller passes `now`. */
export function createRateLimiter(perMinute = 30, perSecond = 3) {
  const stamps: number[] = [];
  return {
    /** True (and the request is counted) when it may go now. */
    take(now: number): boolean {
      while (stamps.length > 0 && now - (stamps[0] ?? 0) >= 60_000) stamps.shift();
      const lastSecond = stamps.filter((t) => now - t < 1_000).length;
      if (stamps.length >= perMinute || lastSecond >= perSecond) return false;
      stamps.push(now);
      return true;
    },
    /** Milliseconds until the next request may go. */
    waitMs(now: number): number {
      while (stamps.length > 0 && now - (stamps[0] ?? 0) >= 60_000) stamps.shift();
      if (stamps.length >= perMinute) return 60_000 - (now - (stamps[0] ?? now));
      const recent = stamps.filter((t) => now - t < 1_000);
      if (recent.length >= perSecond) return 1_000 - (now - (recent[0] ?? now));
      return 0;
    },
  };
}

/** The cached list is refreshed after this long (when online). */
export const CHS_LIST_MAX_AGE_MS = 7 * 24 * 3_600_000;
