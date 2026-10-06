import type { LngLat } from '@core/models';

import type { TakenAtSource } from './model';

/**
 * Normalize the EXIF dictionary `expo-image-picker` returns (with
 * `exif: true`) into what photo placement needs: when, and maybe where.
 *
 * The two platforms disagree on shape (checked in expo-image-picker 56):
 *
 * - **iOS** returns the `{Exif}` dictionary with the `{GPS}` one flattened to
 *   `GPS<Tag>` keys: `GPSLatitude` is UNSIGNED with a `GPSLatitudeRef` of
 *   `N`/`S` (same for longitude, `E`/`W`), `GPSTimeStamp` is `HH:mm:ss.SS`,
 *   `OffsetTimeOriginal` is present on modern iPhones, and the sub-second tag
 *   is spelled `SubsecTimeOriginal`. Camera shots carry no GPS at all.
 * - **Android** reads `ExifInterface`: `GPSLatitude`/`GPSLongitude` are
 *   SIGNED decimals (from `latLong`), the refs may or may not be present, the
 *   GPS time may come as rationals (`13/1,12/1,5/1`), `OffsetTimeOriginal` is
 *   not exposed, and the sub-second tag is `SubSecTimeOriginal`.
 *
 * Everything here is total: a missing, malformed or absurd tag yields
 * `undefined`, never a throw.
 */

/** A photo's capture time as found in the file, before time-zone resolution. */
export type ExifTime =
  /** An absolute instant (offset or GPS UTC was present). */
  | {
      kind: 'absolute';
      epochMs: number;
      source: Extract<TakenAtSource, 'exif-offset' | 'exif-gps-utc'>;
    }
  /** A wall-clock reading with no zone: `wallMs` is that reading taken as if it were UTC. */
  | { kind: 'local'; wallMs: number };

export interface NormalizedExif {
  time?: ExifTime;
  /** `[lng, lat]`, signed. */
  lngLat?: LngLat;
  /** GPS altitude in metres, if any (informational: placement uses the trail's elevation). */
  altitudeM?: number;
  /** Pixel size the file declares, when present. */
  width?: number;
  height?: number;
}

type Raw = Record<string, unknown>;

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const rational = parseRational(v);
    if (rational !== undefined) return rational;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

/** `"4/1"` → 4. Undefined for anything else (including a zero denominator). */
function parseRational(s: string): number | undefined {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return undefined;
  const d = Number(m[2]);
  return d === 0 ? undefined : Number(m[1]) / d;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/** First present key of `keys` — the platforms spell some tags differently. */
function pick(raw: Raw, ...keys: string[]): unknown {
  for (const k of keys) if (raw[k] !== undefined && raw[k] !== null) return raw[k];
  return undefined;
}

/**
 * Degrees from a decimal, a `"deg,min,sec"` / `"d/1,m/1,s/100"` triple, or an
 * array of three numbers — every form seen in the wild for GPS coordinates.
 */
function degrees(v: unknown): number | undefined {
  if (Array.isArray(v) && v.length === 3) {
    const [d, m, s] = v.map(num);
    return d === undefined || m === undefined || s === undefined ? undefined : dms(d, m, s);
  }
  if (typeof v === 'string' && v.includes(',')) {
    const parts = v.split(',').map((p) => num(p));
    if (parts.length !== 3 || parts.some((p) => p === undefined)) return undefined;
    const [d, m, s] = parts as [number, number, number];
    return dms(d, m, s);
  }
  return num(v);
}

const dms = (d: number, m: number, s: number): number =>
  Math.sign(d || 1) * (Math.abs(d) + m / 60 + s / 3600);

/**
 * Apply a hemisphere ref. A value that is already negative is trusted as-is
 * (Android's `latLong` is signed AND may still carry the ref) — negating it
 * again would mirror the photo across the equator.
 */
function signed(value: number, ref: unknown, negativeRefs: readonly string[]): number {
  if (value < 0) return value;
  const r = str(ref)?.toUpperCase();
  return r !== undefined && negativeRefs.includes(r) ? -value : value;
}

/** The GPS position, or undefined when absent, out of range, or the classic `0,0` placeholder. */
export function exifLngLat(raw: Raw): LngLat | undefined {
  const latRaw = degrees(pick(raw, 'GPSLatitude', 'Latitude'));
  const lngRaw = degrees(pick(raw, 'GPSLongitude', 'Longitude'));
  if (latRaw === undefined || lngRaw === undefined) return undefined;
  const lat = signed(latRaw, pick(raw, 'GPSLatitudeRef', 'LatitudeRef'), ['S']);
  const lng = signed(lngRaw, pick(raw, 'GPSLongitudeRef', 'LongitudeRef'), ['W']);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  // Cameras without a fix write zeros; nobody hikes at Null Island.
  if (Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6) return undefined;
  return [lng, lat];
}

const DATE_TIME = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;

/**
 * `"2026:09:27 10:31:05"` read as if UTC (epoch ms), or undefined. EXIF's
 * all-zero "unknown" date and impossible fields are rejected.
 */
export function parseExifDateTime(value: unknown, subSec?: unknown): number | undefined {
  const s = str(value);
  if (s === undefined) return undefined;
  const m = DATE_TIME.exec(s);
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) {
    return undefined;
  }
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  // Date.UTC rolls 31 Feb into March; reject instead of silently shifting.
  if (new Date(ms).getUTCDate() !== d) return undefined;
  return ms + fraction(m[7] ?? str(subSec));
}

/** `"45"` (sub-second digits) → 450 ms. */
function fraction(digits: string | undefined): number {
  if (digits === undefined || !/^\d+$/.test(digits)) return 0;
  return Math.round(Number(`0.${digits}`) * 1000);
}

/** `"+02:00"`, `"-04:00"`, `"Z"` → minutes east of UTC; undefined otherwise. */
export function parseExifOffset(value: unknown): number | undefined {
  const s = str(value);
  if (s === undefined) return undefined;
  if (s === 'Z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(s);
  if (!m) return undefined;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  if (minutes > 14 * 60) return undefined;
  return m[1] === '-' ? -minutes : minutes;
}

/** GPS date `"2026:09:27"` + time (`"13:12:05.00"` or `"13/1,12/1,5/1"`) → epoch ms UTC. */
export function parseGpsDateTime(date: unknown, time: unknown): number | undefined {
  const d = str(date);
  if (d === undefined) return undefined;
  const dm = /^(\d{4})[:-](\d{2})[:-](\d{2})$/.exec(d);
  if (!dm) return undefined;
  let h: number | undefined;
  let mi: number | undefined;
  let se: number | undefined;
  if (Array.isArray(time) && time.length === 3) {
    [h, mi, se] = time.map(num);
  } else {
    const t = str(time);
    if (t === undefined) return undefined;
    const parts = t.includes(',')
      ? t.split(',').map((p) => num(p))
      : t.split(':').map((p) => num(p));
    if (parts.length !== 3) return undefined;
    [h, mi, se] = parts;
  }
  if (h === undefined || mi === undefined || se === undefined) return undefined;
  if (h < 0 || h > 23 || mi < 0 || mi > 59 || se < 0 || se >= 61) return undefined;
  const base = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
  if (!Number.isFinite(base)) return undefined;
  return base + Math.round(((h * 60 + mi) * 60 + se) * 1000);
}

/**
 * When the photo was taken, as far as the file says. Preference: the
 * original time WITH its offset → the GPS UTC stamp → the original time as an
 * unzoned wall clock (resolved later against the device's zone, see
 * {@link resolveTakenAt}). `DateTimeOriginal` beats `DateTimeDigitized` beats
 * the file's `DateTime` (an editor may have rewritten that one).
 */
export function exifTime(raw: Raw): ExifTime | undefined {
  const subSec = pick(raw, 'SubsecTimeOriginal', 'SubSecTimeOriginal');
  const original =
    parseExifDateTime(pick(raw, 'DateTimeOriginal'), subSec) ??
    parseExifDateTime(
      pick(raw, 'DateTimeDigitized'),
      pick(raw, 'SubsecTimeDigitized', 'SubSecTimeDigitized'),
    ) ??
    parseExifDateTime(pick(raw, 'DateTime'), pick(raw, 'SubsecTime', 'SubSecTime'));
  const offset = parseExifOffset(
    pick(raw, 'OffsetTimeOriginal', 'OffsetTimeDigitized', 'OffsetTime'),
  );
  if (original !== undefined && offset !== undefined) {
    return { kind: 'absolute', epochMs: original - offset * 60_000, source: 'exif-offset' };
  }
  const gps = parseGpsDateTime(
    pick(raw, 'GPSDateStamp', 'DateStamp'),
    pick(raw, 'GPSTimeStamp', 'TimeStamp'),
  );
  if (gps !== undefined) {
    // A GPS stamp keeps whole seconds at best; when the camera clock agrees
    // with it to within a minute, the original time's sub-seconds are finer.
    if (original !== undefined) {
      const drift = original - gps;
      const zoneish = Math.round(drift / (15 * 60_000)) * 15 * 60_000;
      if (Math.abs(drift - zoneish) < 60_000) {
        return { kind: 'absolute', epochMs: original - zoneish, source: 'exif-gps-utc' };
      }
    }
    return { kind: 'absolute', epochMs: gps, source: 'exif-gps-utc' };
  }
  if (original !== undefined) return { kind: 'local', wallMs: original };
  return undefined;
}

/** Everything placement needs from one picked photo's EXIF. */
export function normalizeExif(raw: unknown): NormalizedExif {
  if (raw === null || typeof raw !== 'object') return {};
  const r = raw as Raw;
  const out: NormalizedExif = {};
  const time = exifTime(r);
  if (time) out.time = time;
  const lngLat = exifLngLat(r);
  if (lngLat) {
    out.lngLat = lngLat;
    const alt = num(pick(r, 'GPSAltitude', 'Altitude'));
    if (alt !== undefined) {
      // GPSAltitudeRef 1 = below sea level (a few lake shores, the Dead Sea).
      out.altitudeM = num(pick(r, 'GPSAltitudeRef', 'AltitudeRef')) === 1 ? -Math.abs(alt) : alt;
    }
  }
  const w = num(pick(r, 'PixelXDimension', 'ImageWidth'));
  const h = num(pick(r, 'PixelYDimension', 'ImageLength'));
  if (w !== undefined && w > 0 && h !== undefined && h > 0) {
    out.width = w;
    out.height = h;
  }
  return out;
}

/**
 * Minutes east of UTC that the device's zone had at an instant. Injected so
 * this module stays pure: the app passes `(ms) => -new Date(ms).getTimezoneOffset()`.
 */
export type ZoneOffsetAt = (epochMs: number) => number;

/**
 * Turn an {@link ExifTime} into an instant. An unzoned wall clock is read in
 * the device's zone AT THAT DATE (so a September photo uses daylight time even
 * when imported in November): the offset is looked up twice so a reading near
 * a DST switch still lands on the right side of it.
 */
export function resolveTakenAt(
  time: ExifTime,
  zoneOffsetAt: ZoneOffsetAt,
): { epochMs: number; source: TakenAtSource } {
  if (time.kind === 'absolute') return { epochMs: time.epochMs, source: time.source };
  const guess = time.wallMs - zoneOffsetAt(time.wallMs) * 60_000;
  const epochMs = time.wallMs - zoneOffsetAt(guess) * 60_000;
  return { epochMs, source: 'exif-local' };
}
