/**
 * What opens Convert: a survey mark's published values (its datum, epoch,
 * coordinates and heights, verbatim), a tide station's chart datum, a point
 * tapped on the map, or a deep link. Pure: the feature layer only routes.
 *
 * A mark in a datum Convert has no validated operation for opens with no
 * coordinates and says so — we never substitute the drawn (≈ WGS 84)
 * position for a published coordinate.
 */
import { datumAt, vdatumAt } from '@core/geodetic/catalog';
import type { GeodeticMark, MarkGrid } from '@core/geodetic/record';
import { parseAngle } from './format';
import { ellipsoidalHeightOn, type CdStation, type StationDatum } from './graph';
import { inBox, inRegion, BOX } from './regions';
import { coordSystem } from './systems';
import type { ConvertSpec, FrameId } from './types';

/** The Convert screen's input, as text fields (the agency's digits stay verbatim). */
export interface ConvertRequest {
  spec: ConvertSpec;
  /** Geographic: a = latitude, b = longitude. Projected: a = easting, b = northing. Geocentric: a, b, c = X, Y, Z. */
  a: string;
  b: string;
  c?: string;
  /** Height text, in `spec.fromHeight`. */
  h?: string;
  /** Coordinate epoch text. */
  epoch?: string;
  /** Target epoch text (dynamic target frames). */
  toEpoch?: string;
  /** "From mark 81KM003", "From benchmark 19L760B", "Point on the map". */
  origin?: { kind: 'mark' | 'station' | 'point' | 'link'; label: string; id?: string };
  /** Published heights to show next to a computed one ("published 24.488"). */
  published?: { heightId: string; text: string }[];
  stations?: CdStation[];
  /** Where the request comes from, for suggestions before anything is parsed. */
  near: { lon: number; lat: number };
  /** A reason the source couldn't be prefilled (unsupported datum…). */
  notice?: string;
  /**
   * The source position is only approximate (a benchmark the agency never
   * positioned precisely, a 10 m grid square): the result can't be better
   * than this, whatever digits the fields carry. Dropped as soon as the
   * coordinates are edited.
   */
  approxPosition?: { accM: number; why: string };
}

const VDATUM_TO_HEIGHT: Record<string, string> = {
  CGVD2013: 'cgvd2013a',
  CGVD28: 'cgvd28',
  NAVD88: 'navd88',
  'NGF-IGN69': 'ngf-ign69',
  LN02: 'ln02',
  LHN95: 'lhn95',
  ODN: 'odn',
  NAP: 'nap',
  NN2000: 'nn2000',
};

/** The Convert frame of a mark's catalogue datum, at its position (null = not supported). */
export function frameOfDatum(
  key: string,
  lon: number,
  lat: number,
): { frame: FrameId; epoch?: string } | null {
  switch (key) {
    case 'nad83csrs-qc':
      return { frame: 'csrs', epoch: '1997.0' };
    case 'nad83csrs':
      return { frame: 'csrs' };
    case 'nad83-2011':
      return inRegion('conus', lon, lat) ? { frame: 'nad83-2011' } : null;
    case 'nad83-1986':
      return inRegion('conus', lon, lat) ? { frame: 'nad83-1986-us' } : null;
    case 'nad27':
      if (inRegion('conus', lon, lat)) return { frame: 'nad27-us' };
      if (inBox(BOX.qc, lon, lat)) return { frame: 'nad27-qc' };
      if (inBox(BOX.nb, lon, lat)) return { frame: 'nad27-nb' };
      if (inBox(BOX.on, lon, lat)) return { frame: 'nad27-on' };
      if (inBox(BOX.sk, lon, lat)) return { frame: 'nad27-sk' };
      if (inBox(BOX.bc, lon, lat)) return { frame: 'nad27-bc' };
      return inBox(BOX.canada, lon, lat) ? { frame: 'nad27-ca' } : null;
    case 'wgs84':
      return { frame: 'wgs84' };
    case 'rgf93':
      return inBox(BOX.france, lon, lat) ? { frame: 'rgf93v2b' } : null;
    case 'osgb36':
      return { frame: 'osgb36' };
    case 'lv95':
      return { frame: 'ch1903p' };
    case 'rd-bessel':
      return { frame: 'amersfoort' };
    case 'etrs89-rd':
      return { frame: 'etrs89-nl' };
    case 'etrs89':
      if (inBox(BOX.switzerland, lon, lat)) return { frame: 'etrs89-ch' };
      if (inBox(BOX.netherlands, lon, lat)) return { frame: 'etrs89-nl' };
      if (inBox(BOX.norway, lon, lat)) return { frame: 'euref89-no' };
      if (inBox(BOX.france, lon, lat)) return { frame: 'rgf93v2b' };
      if (inBox(BOX.uk, lon, lat)) return { frame: 'etrs89-uk' };
      return null;
    default:
      return null;
  }
}

/** A published grid label ("MTM zone 7 (SCOPQ)", "UTM zone 19N") → our system id. */
export function systemOfGrid(frame: FrameId, label: string): string | null {
  const mtm = /^MTM zone (\d+)/i.exec(label);
  if (mtm && frame === 'csrs') return coordSystem(`csrs:mtm${mtm[1]}`) ? `csrs:mtm${mtm[1]}` : null;
  const utm = /^UTM zone (\d+)\s*([NS])?/i.exec(label);
  if (utm) {
    const id = `${frame}:utm${utm[1]}${(utm[2] ?? 'N').toLowerCase()}`;
    return coordSystem(id) ? id : null;
  }
  // MRNF's open-data layer: NAD83(CSRS) / Québec Lambert, EPSG:6622 (its .prj).
  if (/^Qu[ée]bec Lambert/i.test(label) && frame === 'csrs') return 'csrs:qclambert';
  if (/LV95/i.test(label) && frame === 'ch1903p') return 'ch1903p:lv95';
  if (/Lambert-?93/i.test(label) && frame === 'rgf93v2b') return 'rgf93v2b:l93';
  // Full-digit BNG only: a lettered 100 km square ref is not an E/N (gridSource).
  if (/British National Grid|OSGB/i.test(label) && frame === 'osgb36' && !BNG_SQUARE.test(label))
    return 'osgb36:bng';
  if (/^RD/i.test(label) && frame === 'amersfoort') return 'amersfoort:rd';
  return null;
}

/** "British National Grid TQ (10 m)": a 100 km square + E/N digits inside it. */
const BNG_SQUARE = /^British National Grid ([A-HJ-Z]{2}) \((\d+) m\)$/i;
const BNG_LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';

/** A 100 km square's two letters → its south-west corner, metres (OS lettering, no I). */
export function bngSquareOrigin(letters: string): { e: number; n: number } | null {
  const up = letters.toUpperCase();
  if (up.length !== 2) return null;
  const l1 = BNG_LETTERS.indexOf(up[0] ?? '');
  const l2 = BNG_LETTERS.indexOf(up[1] ?? '');
  if (l1 < 0 || l2 < 0) return null;
  const e = (((l1 + 3) % 5) * 5 + (l2 % 5)) * 100000;
  const n = (19 - Math.floor(l1 / 5) * 5 - Math.floor(l2 / 5)) * 100000;
  return e < 700000 && n >= 0 && n < 1300000 ? { e, n } : null;
}

/**
 * A published grid coordinate as Convert reads it: the system and the E / N
 * fields, plus how approximate the position is when the label says so. A
 * lettered BNG square ref (OS benchmarks: "TQ 3005 8054", 10 m) is written
 * out in full at the centre of its square — where the map draws it — and is
 * approximate by the square's half-diagonal. Read as full digits, it put a
 * London benchmark 600 km away, off the Scilly Isles.
 */
export function gridSource(
  frame: FrameId,
  g: MarkGrid,
): { system: string; e: string; n: string; accM?: number } | null {
  const sq = BNG_SQUARE.exec(g.system);
  if (sq) {
    const origin = frame === 'osgb36' ? bngSquareOrigin(sq[1] ?? '') : null;
    const res = Number(sq[2]);
    if (!origin || !(res > 0) || !/^\d{1,5}$/.test(g.e) || !/^\d{1,5}$/.test(g.n)) return null;
    return {
      system: 'osgb36:bng',
      e: String(origin.e + Number(g.e) * res + res / 2),
      n: String(origin.n + Number(g.n) * res + res / 2),
      accM: Math.round((res / 2) * Math.SQRT2 * 10) / 10,
    };
  }
  const system = systemOfGrid(frame, g.system);
  return system ? { system, e: g.e, n: g.n } : null;
}

/** "lat, lon" published text → the two halves, or null. */
export function splitGeo(geo: string): [string, string] | null {
  const parts = geo.split(/,\s+|;\s*/);
  if (parts.length !== 2) return null;
  const [a = '', b = ''] = parts;
  return parseAngle(a, 'lat') && parseAngle(b, 'lon') ? [a.trim(), b.trim()] : null;
}

/** The usual target for a frame at a point: its regional grid and national height. */
export function defaultTarget(
  frame: FrameId,
  lon: number,
  lat: number,
): { to: string; toHeight: string | null } {
  const utmZone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  switch (frame) {
    case 'csrs': {
      if (inBox(BOX.qc, lon, lat)) {
        const z = 3 + Math.floor((-lon - 57) / 3);
        if (z >= 3 && z <= 10) return { to: `csrs:mtm${z}`, toHeight: 'cgvd2013a' };
      }
      return {
        to: coordSystem(`csrs:utm${utmZone}n`) ? `csrs:utm${utmZone}n` : 'csrs:geo',
        toHeight: 'cgvd2013a',
      };
    }
    case 'nad83-2011':
      return {
        to: coordSystem(`nad83-2011:utm${utmZone}n`)
          ? `nad83-2011:utm${utmZone}n`
          : 'nad83-2011:geo',
        toHeight: 'navd88',
      };
    case 'wgs84':
      return { to: `wgs84:utm${utmZone}${lat < 0 ? 's' : 'n'}`, toHeight: 'egm96' };
    case 'rgf93v2b':
      return { to: 'rgf93v2b:l93', toHeight: 'ngf-ign69' };
    case 'etrs89-uk':
      return { to: 'osgb36:bng', toHeight: inBox(BOX.ni, lon, lat) ? 'belfast' : 'odn' };
    case 'etrs89-ch':
      return { to: 'ch1903p:lv95', toHeight: 'ln02' };
    case 'euref89-no':
      return { to: `euref89-no:utm${Math.min(35, Math.max(32, utmZone))}n`, toHeight: 'nn2000' };
    case 'etrs89-nl':
      return { to: 'amersfoort:rd', toHeight: 'nap' };
    default: {
      // A classical frame (no ellipsoidal heights, often no geographic
      // system of its own): its GNSS-era counterpart, where h exists.
      const modern = MODERN_FRAME[frame];
      if (modern) return { to: `${modern}:geo`, toHeight: 'ell' };
      return { to: coordSystem(`${frame}:geo`) ? `${frame}:geo` : 'wgs84:geo', toHeight: null };
    }
  }
}

/** A classical frame → the modern one its agency publishes GNSS (h) values in. */
const MODERN_FRAME: Partial<Record<FrameId, FrameId>> = {
  osgb36: 'etrs89-uk',
  ch1903p: 'etrs89-ch',
  amersfoort: 'etrs89-nl',
  'nad83-1986-us': 'nad83-2011',
};

/** Open Convert from a survey mark (geodetic card → Convert). */
export function prefillFromMark(mark: GeodeticMark): ConvertRequest {
  const datum = datumAt(mark.datum);
  const near = { lon: mark.lng, lat: mark.lat };
  const origin = { kind: 'mark' as const, label: `From mark ${mark.id}`, id: mark.id };
  const fr = datum ? frameOfDatum(datum.key, mark.lng, mark.lat) : null;
  if (!datum || !fr) {
    return {
      spec: { from: 'wgs84:geo', fromHeight: null, to: 'wgs84:geo', toHeight: null },
      a: '',
      b: '',
      origin,
      near,
      notice: `${mark.id} is published in ${datum?.name ?? 'a datum'} that Convert can’t transform with a validated operation yet; enter coordinates yourself.`,
    };
  }
  const published: NonNullable<ConvertRequest['published']> = [];
  for (const h of mark.heights) {
    const vd = vdatumAt(h.vdatum);
    const id = vd ? VDATUM_TO_HEIGHT[vd.name] : undefined;
    if (id) published.push({ heightId: id, text: h.text });
  }
  if (mark.hEll !== undefined) published.push({ heightId: 'ell', text: mark.hEll });

  // Coordinates: the published geographic text, else a published grid.
  let from = `${fr.frame}:geo`;
  let a = '';
  let b = '';
  let gridAccM: number | undefined;
  const geo = mark.geo ? splitGeo(mark.geo) : null;
  if (geo && coordSystem(from)) {
    [a, b] = geo;
  } else {
    for (const g of mark.grids) {
      const read = gridSource(fr.frame, g);
      if (read) {
        from = read.system;
        a = read.e;
        b = read.n;
        gridAccM = read.accM;
        break;
      }
    }
  }
  // Source height: the ellipsoidal one if published (no model in it), else
  // the first orthometric height we can convert.
  const ell =
    mark.hEll !== undefined && fr.frame !== 'nad27-qc' ? { id: 'ell', text: mark.hEll } : null;
  const ortho = published.find((p) => p.heightId !== 'ell');
  const src = ell ?? (ortho ? { id: ortho.heightId, text: ortho.text } : null);

  const target = defaultTarget(fr.frame, mark.lng, mark.lat);
  // The mark's own published grid as the target (the regional one first,
  // e.g. MTM before UTM in Québec), so the result can be compared with it.
  const markGrids = mark.grids
    .map((g) => gridSource(fr.frame, g)?.system)
    .filter((s): s is string => !!s && s !== from);
  const gridTarget = markGrids.find((s) => s === target.to) ?? markGrids[0];
  let to = gridTarget ?? target.to;
  // Never "from X to X" (a mark whose only readable value is its grid).
  if (to === from) to = coordSystem(`${fr.frame}:geo`) ? `${fr.frame}:geo` : target.to;
  // From h: to the mark's own published system (so the two can be compared),
  // else the region's. From an orthometric height: to h — on a classical
  // frame (OSGB36, LV95, RD, NAD83(1986)), which has no h, the h of its
  // GNSS-era counterpart (ETRS89, NAD83(2011)).
  let toHeight: string | null = null;
  if (src) toHeight = src.id === 'ell' ? (ortho?.heightId ?? target.toHeight) : 'ell';
  if (src && src.id !== 'ell' && !ellipsoidalHeightOn(fr.frame)) {
    const modern = MODERN_FRAME[fr.frame];
    if (modern && coordSystem(`${modern}:geo`)) to = `${modern}:geo`;
    else toHeight = null;
  }
  // Clamp to a system that exists: an unknown target is a refusal, not a result.
  if (!coordSystem(to)) to = from;
  const spec: ConvertSpec = { from, fromHeight: src?.id ?? null, to, toHeight };
  // How approximate the published position is: the mark's own (a scaled
  // benchmark, MRNF's open-data layer) or the grid square's, whichever is worse.
  const accM = Math.max(mark.posAccM ?? 0, gridAccM ?? 0);
  return {
    spec,
    a,
    b,
    ...(src ? { h: src.text } : {}),
    ...(fr.epoch !== undefined ? { epoch: fr.epoch } : {}),
    origin,
    published,
    near,
    ...(a !== '' && accM > 0 ? { approxPosition: { accM, why: approxWhy(mark, gridAccM) } } : {}),
    ...(a === ''
      ? {
          notice: `${mark.id} has no published coordinates Convert can read; enter them from the datasheet.`,
        }
      : {}),
  };
}

/** Why a mark's published position is approximate, in the user's words. */
function approxWhy(mark: GeodeticMark, gridAccM: number | undefined): string {
  if (gridAccM !== undefined && gridAccM >= (mark.posAccM ?? 0))
    return `${mark.id} is published only as a grid square`;
  if (mark.type === 'v')
    return `${mark.id} is a levelling benchmark: its height is precise, its position only approximate`;
  return `${mark.id}’s published position is approximate`;
}

/**
 * A tide station as the tide card knows it — structural, so the tides
 * branch's own `TideStation` (`@core/tides/station`) can be passed as is:
 * `openConvert(router, prefillFromTideStation(station))`.
 */
export interface TideStationLike {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** "CHS", "NOAA CO-OPS". Default: from the country. */
  agency?: string;
  /** Default: from the published offsets (CGVD2013 → Canada, NAVD88 → US). */
  country?: 'ca' | 'us' | string;
  /** What the agency calls the chart datum ("Chart datum", "MLLW"). */
  cdName?: string;
  /** CD expressed in national datums, as published: H_X = H_CD + CD_in_X. */
  national: readonly { datum: string; text: string }[];
}

function countryOf(st: TideStationLike): string {
  if (st.country) return st.country;
  const ds = st.national.map((n) => n.datum.toUpperCase());
  if (ds.some((d) => d.startsWith('CGVD') || d.startsWith('IGLD'))) return 'ca';
  if (ds.includes('NAVD88')) return 'us';
  return '';
}

const STATION_DATUMS: Record<string, StationDatum> = {
  CGVD2013: 'cgvd2013',
  CGVD28: 'cgvd28',
  IGLD85: 'igld85',
  'IGLD 1985': 'igld85',
  NAVD88: 'navd88',
};

/** The tide station's offsets as a Convert chart-datum context, or null (no usable offset). */
export function cdStationOf(st: TideStationLike): CdStation | null {
  const country = countryOf(st);
  if (country !== 'ca' && country !== 'us') return null;
  const agency = st.agency ?? (country === 'ca' ? 'CHS' : 'NOAA CO-OPS');
  const offsets: CdStation['offsets'] = {};
  for (const n of st.national) {
    const d = STATION_DATUMS[n.datum.toUpperCase().replace(/\s+/g, ' ')] ?? STATION_DATUMS[n.datum];
    const v = Number(n.text);
    if (d && Number.isFinite(v)) offsets[d] = v;
  }
  const hub: StationDatum = country === 'ca' ? 'cgvd2013' : 'navd88';
  if (offsets[hub] === undefined) return null;
  return {
    key: `${country}-${agency.toLowerCase().replace(/[^a-z]+/g, '')}:${st.id}`,
    name: `${st.name} (${st.id})`,
    agency,
    country,
    lon: st.lng,
    lat: st.lat,
    cdName: st.cdName ?? 'Chart datum',
    offsets,
  };
}

/**
 * Open Convert on a tide station's chart datum (tide card → Convert), or on a
 * tidal benchmark's height above CD when `heightAboveCd` is given.
 */
export function prefillFromTideStation(
  st: TideStationLike,
  opts: { heightAboveCd?: string; benchmark?: { id: string; lat: number; lng: number } } = {},
): ConvertRequest {
  const near = opts.benchmark
    ? { lon: opts.benchmark.lng, lat: opts.benchmark.lat }
    : { lon: st.lng, lat: st.lat };
  const cd = cdStationOf(st);
  const origin = opts.benchmark
    ? { kind: 'mark' as const, label: `From benchmark ${opts.benchmark.id}`, id: opts.benchmark.id }
    : { kind: 'station' as const, label: `From station ${st.name}`, id: st.id };
  const frame: FrameId = countryOf(st) === 'us' ? 'nad83-2011' : 'csrs';
  const pos = { a: near.lat.toFixed(6), b: near.lon.toFixed(6) };
  if (!cd) {
    return {
      spec: {
        from: `${frame}:geo`,
        fromHeight: null,
        to: 'same',
        toHeight: null,
        ...(frame === 'csrs' ? { epoch: 2010 } : {}),
      },
      ...pos,
      origin,
      near,
      notice: `${st.name} publishes no chart-datum offset Convert can use.`,
    };
  }
  return {
    spec: {
      from: `${frame}:geo`,
      fromHeight: `cd@${cd.key}`,
      to: 'same',
      toHeight: frame === 'csrs' ? 'cgvd2013a' : 'navd88',
      ...(frame === 'csrs' ? { epoch: 2010 } : {}),
    },
    ...pos,
    h: opts.heightAboveCd ?? '0.000',
    ...(frame === 'csrs' ? { epoch: '2010.0' } : {}),
    origin,
    stations: [cd],
    near,
  };
}

/** Open Convert on a point tapped on the map (its ≈ WGS 84 display position). */
export function prefillFromPoint(lat: number, lon: number): ConvertRequest {
  const t = defaultTarget('wgs84', lon, lat);
  return {
    spec: { from: 'wgs84:geo', fromHeight: null, to: t.to, toHeight: null },
    a: lat.toFixed(6),
    b: lon.toFixed(6),
    origin: { kind: 'point', label: 'Point on the map' },
    near: { lon, lat },
  };
}

/** An empty Convert (actions-sheet row): WGS 84 in, the region's grid out, nothing typed. */
export function emptyRequest(near: { lon: number; lat: number }): ConvertRequest {
  const t = defaultTarget('wgs84', near.lon, near.lat);
  return {
    spec: { from: 'wgs84:geo', fromHeight: null, to: t.to, toHeight: null },
    a: '',
    b: '',
    near,
  };
}

// ---- deep link / route params -------------------------------------------------------

/** Route params for a request (expo-router: strings only). Stations travel as JSON. */
export function toParams(req: ConvertRequest): Record<string, string> {
  const p: Record<string, string> = {
    from: req.spec.from,
    to: req.spec.to,
    a: req.a,
    b: req.b,
    lon: String(req.near.lon),
    lat: String(req.near.lat),
  };
  if (req.spec.fromHeight) p.fh = req.spec.fromHeight;
  if (req.spec.toHeight) p.th = req.spec.toHeight;
  if (req.c) p.c = req.c;
  if (req.h !== undefined) p.h = req.h;
  if (req.epoch) p.epoch = req.epoch;
  if (req.toEpoch) p.toEpoch = req.toEpoch;
  if (req.origin) p.label = req.origin.label;
  if (req.origin?.kind) p.kind = req.origin.kind;
  if (req.published?.length) p.pub = JSON.stringify(req.published);
  if (req.stations?.length) p.st = JSON.stringify(req.stations);
  if (req.notice) p.notice = req.notice;
  if (req.approxPosition) {
    p.pacc = String(req.approxPosition.accM);
    p.pwhy = req.approxPosition.why;
  }
  return p;
}

function str(v: unknown): string | undefined {
  if (Array.isArray(v)) return str(v[0]);
  return typeof v === 'string' ? v : undefined;
}

/** Parse route / deep-link params back (unknown or malformed values are dropped, not guessed). */
export function fromParams(params: Record<string, unknown>): ConvertRequest | null {
  const from = str(params.from);
  const to = str(params.to) ?? 'same';
  if (!from || !coordSystem(from)) return null;
  const epoch = str(params.epoch);
  const toEpoch = str(params.toEpoch);
  const nEpoch = epoch !== undefined && /^\d{4}(\.\d+)?$/.test(epoch) ? Number(epoch) : undefined;
  const nToEpoch =
    toEpoch !== undefined && /^\d{4}(\.\d+)?$/.test(toEpoch) ? Number(toEpoch) : undefined;
  const lon = Number(str(params.lon));
  const lat = Number(str(params.lat));
  const a = str(params.a) ?? '';
  const b = str(params.b) ?? '';
  const nearLat = Number.isFinite(lat) ? lat : (parseAngle(a, 'lat')?.value ?? 0);
  const nearLon = Number.isFinite(lon) ? lon : (parseAngle(b, 'lon')?.value ?? 0);
  const req: ConvertRequest = {
    spec: {
      from,
      fromHeight: str(params.fh) ?? null,
      to,
      toHeight: str(params.th) ?? null,
      ...(nEpoch !== undefined ? { epoch: nEpoch } : {}),
      ...(nToEpoch !== undefined ? { toEpoch: nToEpoch } : {}),
    },
    a,
    b,
    near: { lon: nearLon, lat: nearLat },
  };
  const c = str(params.c);
  const h = str(params.h);
  if (c !== undefined) req.c = c;
  if (h !== undefined) req.h = h;
  if (epoch !== undefined) req.epoch = epoch;
  if (toEpoch !== undefined) req.toEpoch = toEpoch;
  const label = str(params.label);
  const kind = str(params.kind);
  if (label)
    req.origin = {
      kind: kind === 'mark' || kind === 'station' || kind === 'point' ? kind : 'link',
      label,
    };
  const notice = str(params.notice);
  if (notice) req.notice = notice;
  // An approximate source position only ever makes the result MORE cautious;
  // a malformed or non-positive value is dropped.
  const pacc = Number(str(params.pacc));
  if (Number.isFinite(pacc) && pacc > 0)
    req.approxPosition = {
      accM: pacc,
      why: str(params.pwhy) ?? 'The source position is approximate',
    };
  try {
    const pub = str(params.pub);
    if (pub)
      req.published = (JSON.parse(pub) as ConvertRequest['published'])?.filter(
        (x) => typeof x?.heightId === 'string' && typeof x?.text === 'string',
      );
    const st = str(params.st);
    if (st)
      req.stations = (JSON.parse(st) as CdStation[]).filter(
        (s) => typeof s?.key === 'string' && typeof s?.lon === 'number',
      );
  } catch {
    // A malformed param is ignored, the rest still opens.
  }
  return req;
}
