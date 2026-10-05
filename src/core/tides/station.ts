/**
 * Tile feature → tide station. The tile schema (`infra/tiles/nas/tides/build.py`,
 * layer `tide_stations` of our `tides.pmtiles`):
 *
 * | key | meaning |
 * |-----|---------|
 * | `i`, `s`, `n` | agency station id, source index, name |
 * | `y`/`x` | the agency's station position |
 * | `k` | kind: `gauge` (live), `ref` (reference / prediction port), `sec` (secondary), `hist` |
 * | `lv` | live series: `coops` / `kv` (the card's "Now" line) |
 * | `cn` | chart-datum kind (catalogue `cdKinds`) |
 * | `L` | levels above CD, `CODE=text;…`, high → low, agency digits |
 * | `X` | recorded extremes above CD, `CODE=text@YYYY-MM-DD;…` |
 * | `D` | CD in a national datum, `DATUM=text;…` (H_X = H_CD + CD_in_X) |
 * | `E` | CD as an ellipsoidal height: `text|frame|epoch|how|checkedBy|ΔM|basis`, only when an agency oracle confirmed it |
 * | `ep`, `pd`, `z` | tidal epoch, publication date, zone / area |
 * | `rp`, `rpn`, `rL` | reference port id, name and levels (when this station lacks HAT/LAT) |
 * | `pa` | how far the published position may be off, m | `f` flags | `lu` land uplift cm/yr |
 *
 * Values stay strings end to end: the card prints the agency's digits.
 */

export type StationKind = 'gauge' | 'ref' | 'sec' | 'hist';
export type LiveSeries = 'coops' | 'kv';

export interface PublishedLevel {
  code: string;
  /** As published, e.g. "1.541". */
  text: string;
  /** Recorded extremes only. */
  date?: string;
}

export interface NationalOffset {
  /** Datum key as the build wrote it ("NAVD88", "IGN69", "NN2000"…). */
  datum: string;
  /** CD_in_X as published, e.g. "-0.846". */
  text: string;
}

export interface EllipsoidalCd {
  text: string;
  frame: string;
  epoch?: string;
  how: 'derived' | 'published';
  checkedBy: string;
  /** Our value − the oracle's, metres (signed). */
  deltaM: number;
  basis: string;
}

export interface TideStation {
  id: string;
  source: number;
  name: string;
  lat: number;
  lng: number;
  kind: StationKind;
  live?: LiveSeries;
  cdKind: string;
  levels: PublishedLevel[];
  extremes: PublishedLevel[];
  national: NationalOffset[];
  ellipsoid?: EllipsoidalCd;
  epoch?: string;
  published?: string;
  zone?: string;
  refPort?: { id: string; name: string; levels: PublishedLevel[] };
  posAccM?: number;
  flags: string[];
  landUpliftCmYr?: string;
}

const KINDS: readonly string[] = ['gauge', 'ref', 'sec', 'hist'];
const NUMBER = /^[-+]?\d+(\.\d+)?$/;

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** "CODE=text;CODE=text@date" → levels; malformed entries are dropped, never guessed. */
export function parseLevels(v: unknown): PublishedLevel[] {
  const s = str(v);
  if (s === undefined) return [];
  const out: PublishedLevel[] = [];
  for (const part of s.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const code = part.slice(0, eq).trim();
    const [text = '', date] = part.slice(eq + 1).split('@');
    if (!NUMBER.test(text.trim())) continue;
    const level: PublishedLevel = { code, text: text.trim() };
    if (date !== undefined && /^\d{4}(-\d{2}-\d{2})?$/.test(date.trim())) level.date = date.trim();
    out.push(level);
  }
  return out;
}

function parseNational(v: unknown): NationalOffset[] {
  return parseLevels(v).map((l) => ({ datum: l.code, text: l.text }));
}

function parseEllipsoid(v: unknown): EllipsoidalCd | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const [text = '', frame = '', epoch = '', how = '', checkedBy = '', delta = '', basis = ''] =
    s.split('|');
  const deltaM = Number(delta);
  if (!NUMBER.test(text) || frame === '' || checkedBy === '' || !Number.isFinite(deltaM)) {
    return undefined;
  }
  if (how !== 'derived' && how !== 'published') return undefined;
  const e: EllipsoidalCd = { text, frame, how, checkedBy, deltaM, basis };
  if (epoch !== '') e.epoch = epoch;
  return e;
}

/**
 * Parse one tile feature's properties. `fallback` is the geometry's
 * [lng, lat], used only when `x`/`y` are missing. Null when it isn't a station.
 */
export function parseTideStation(
  props: Readonly<Record<string, unknown>> | null | undefined,
  fallback?: readonly [number, number] | null,
): TideStation | null {
  if (!props) return null;
  const id = str(props.i);
  const source = num(props.s);
  const name = str(props.n);
  const cdKind = str(props.cn);
  if (id === undefined || source === undefined || name === undefined || cdKind === undefined) {
    return null;
  }
  const lat = num(props.y) ?? fallback?.[1];
  const lng = num(props.x) ?? fallback?.[0];
  if (lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  const k = str(props.k);
  const station: TideStation = {
    id,
    source,
    name,
    lat,
    lng,
    kind: k !== undefined && KINDS.includes(k) ? (k as StationKind) : 'hist',
    cdKind,
    levels: parseLevels(props.L),
    extremes: parseLevels(props.X),
    national: parseNational(props.D),
    flags: (str(props.f) ?? '').split(',').filter((f) => f !== ''),
  };
  const lv = str(props.lv);
  if (lv === 'coops' || lv === 'kv') station.live = lv;
  const e = parseEllipsoid(props.E);
  if (e) station.ellipsoid = e;
  const ep = str(props.ep);
  if (ep) station.epoch = ep;
  const pd = str(props.pd);
  if (pd) station.published = pd;
  const z = str(props.z);
  if (z) station.zone = z;
  const pa = num(props.pa);
  if (pa !== undefined && pa > 0) station.posAccM = pa;
  const lu = str(props.lu);
  if (lu) station.landUpliftCmYr = lu;
  const rp = str(props.rp);
  const rpn = str(props.rpn);
  const rL = parseLevels(props.rL);
  if (rp && rpn && rL.length > 0) station.refPort = { id: rp, name: rpn, levels: rL };
  return station;
}

/** Stable identity for selection. */
export function stationKey(s: Pick<TideStation, 'source' | 'id'>): string {
  return `${s.source}:${s.id}`;
}

interface FeatureLike {
  properties?: Readonly<Record<string, unknown>> | null;
  geometry?: { type?: string; coordinates?: unknown } | null;
}

/** The station a tap meant: the nearest one in the hit box. */
export function pickTappedStation(
  features: readonly unknown[],
  tap: readonly [number, number],
): TideStation | null {
  let best: { s: TideStation; d: number } | null = null;
  const cos = Math.cos((tap[1] * Math.PI) / 180);
  for (const raw of features) {
    if (typeof raw !== 'object' || raw === null) continue;
    const f = raw as FeatureLike;
    const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : null;
    const pt =
      Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number'
        ? ([c[0], c[1]] as [number, number])
        : null;
    const s = parseTideStation(f.properties, pt);
    if (!s) continue;
    const d = Math.hypot((s.lng - tap[0]) * cos, s.lat - tap[1]);
    if (best === null || d < best.d) best = { s, d };
  }
  return best?.s ?? null;
}
