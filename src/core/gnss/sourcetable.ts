/**
 * NTRIP sourcetable: STR (streams / mountpoints), CAS (casters) and NET
 * (networks) records, and "which mountpoint is nearest" for the picker.
 *
 * Record layouts: NTRIP 2.0 (RTCM 10410.1), as documented by the BKG
 * caster manual. A sourcetable carries no datum: the frame of a mountpoint's
 * corrections comes from the correction profile (`casters.ts`), never from
 * here.
 */
import { distanceM } from '../convert/regions';

export interface SourceStream {
  mountpoint: string;
  identifier: string;
  /** "RTCM 3.2", "RTCM3.1", "CMR+", "RTCM 2.3"… */
  format: string;
  formatDetails: string;
  /** 0 none, 1 L1, 2 L1+L2. */
  carrier: number | null;
  navSystem: string;
  network: string;
  country: string;
  lat: number | null;
  lon: number | null;
  /** The caster needs the rover's GGA (VRS, nearest-base). */
  nmea: boolean;
  /** Network (VRS / MAC / FKP) solution rather than a single base. */
  networkSolution: boolean;
  generator: string;
  authentication: 'none' | 'basic' | 'digest' | string;
  fee: boolean;
  bitrate: number | null;
  misc: string;
}

export interface SourceCaster {
  host: string;
  port: number | null;
  identifier: string;
  operator: string;
  nmea: boolean;
  country: string;
  lat: number | null;
  lon: number | null;
  misc: string;
}

export interface SourceNetwork {
  identifier: string;
  operator: string;
  authentication: string;
  fee: boolean;
  webNet: string;
  webStr: string;
  webReg: string;
  misc: string;
}

export interface Sourcetable {
  streams: SourceStream[];
  casters: SourceCaster[];
  networks: SourceNetwork[];
  /** Lines that were not a valid record (skipped). */
  badLines: number;
  /** ENDSOURCETABLE was seen. */
  complete: boolean;
}

function n(s: string): number | null {
  if (s.trim() === '') return null;
  const v = Number(s.trim());
  return Number.isFinite(v) ? v : null;
}

function coord(lat: string, lon: string): [number | null, number | null] {
  const a = n(lat);
  const o = n(lon);
  if (a === null || o === null || Math.abs(a) > 90) return [null, null];
  // Some casters write 0;0 for "unknown"; others use 0–360 longitudes.
  if (a === 0 && o === 0) return [null, null];
  return [a, o > 180 ? o - 360 : o];
}

const yes = (s: string): boolean => s.trim().toUpperCase() === 'Y';

const STR = [
  'mountpoint',
  'identifier',
  'format',
  'formatDetails',
  'carrier',
  'navSystem',
  'network',
  'country',
  'lat',
  'lon',
  'nmea',
  'solution',
  'generator',
  'compression',
  'authentication',
  'fee',
  'bitrate',
] as const;
const CAS = ['host', 'port', 'identifier', 'operator', 'nmea', 'country', 'lat', 'lon'] as const;
const NET = [
  'identifier',
  'operator',
  'authentication',
  'fee',
  'webNet',
  'webStr',
  'webReg',
] as const;

type Rec<K extends string> = Record<K, string> & { misc: string };

/**
 * The record's named fields (missing trailing ones are ''), its misc tail,
 * or null when it has fewer fields than the format requires.
 */
function record<K extends string>(
  f: readonly string[],
  names: readonly K[],
  required: number,
): Rec<K> | null {
  if (f.length - 1 < required || f[1] === '') return null;
  const r = { misc: f.slice(names.length + 1).join(';') } as Rec<K>;
  names.forEach((k, i) => {
    r[k] = (f[i + 1] ?? '') as Rec<K>[K];
  });
  return r;
}

const AUTH: Record<string, string> = { N: 'none', B: 'basic', D: 'digest' };

export function parseSourcetable(text: string): Sourcetable {
  const out: Sourcetable = { streams: [], casters: [], networks: [], badLines: 0, complete: false };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    if (line.startsWith('ENDSOURCETABLE')) {
      out.complete = true;
      break;
    }
    const f = line.split(';');
    const kind = f[0];
    const s = kind === 'STR' ? record(f, STR, 10) : null;
    const c = kind === 'CAS' ? record(f, CAS, 2) : null;
    const t = kind === 'NET' ? record(f, NET, 1) : null;
    if (s) {
      const [lat, lon] = coord(s.lat, s.lon);
      const auth = s.authentication.trim();
      out.streams.push({
        mountpoint: s.mountpoint,
        identifier: s.identifier,
        format: s.format,
        formatDetails: s.formatDetails,
        carrier: n(s.carrier),
        navSystem: s.navSystem,
        network: s.network,
        country: s.country,
        lat,
        lon,
        nmea: s.nmea.trim() === '1',
        networkSolution: s.solution.trim() === '1',
        generator: s.generator,
        authentication: AUTH[auth] ?? auth,
        fee: yes(s.fee),
        bitrate: n(s.bitrate),
        misc: s.misc,
      });
    } else if (c) {
      const [lat, lon] = coord(c.lat, c.lon);
      out.casters.push({
        host: c.host,
        port: n(c.port),
        identifier: c.identifier,
        operator: c.operator,
        nmea: c.nmea.trim() === '1',
        country: c.country,
        lat,
        lon,
        misc: c.misc,
      });
    } else if (t) {
      out.networks.push({
        identifier: t.identifier,
        operator: t.operator,
        authentication: t.authentication,
        fee: yes(t.fee),
        webNet: t.webNet,
        webStr: t.webStr,
        webReg: t.webReg,
        misc: t.misc,
      });
    } else {
      out.badLines++;
    }
  }
  return out;
}

/** RTCM 3.x is what u-blox and every modern rover takes; RTCM 2 / CMR are not usable by DIY kits. */
export function isRtcm3(s: SourceStream): boolean {
  return /^RTCM\s*3/i.test(s.format.trim());
}

export interface RankedStream {
  stream: SourceStream;
  /** Great-circle distance to the rover, km; null when the stream has no position. */
  distanceKm: number | null;
  /** RTCM 3 (usable by the receivers we support). */
  usable: boolean;
}

/**
 * Mountpoints nearest the rover first. Usable (RTCM 3) streams come before
 * unusable ones at any distance; streams without a position go last.
 */
export function rankMountpoints(
  streams: readonly SourceStream[],
  lat: number,
  lon: number,
  limit = Infinity,
): RankedStream[] {
  const ranked = streams.map<RankedStream>((s) => ({
    stream: s,
    distanceKm: s.lat === null || s.lon === null ? null : distanceM(lon, lat, s.lon, s.lat) / 1000,
    usable: isRtcm3(s),
  }));
  ranked.sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1;
    if (a.distanceKm === null || b.distanceKm === null) {
      if (a.distanceKm === b.distanceKm)
        return a.stream.mountpoint.localeCompare(b.stream.mountpoint);
      return a.distanceKm === null ? 1 : -1;
    }
    return a.distanceKm - b.distanceKm || a.stream.mountpoint.localeCompare(b.stream.mountpoint);
  });
  return ranked.slice(0, limit);
}

/**
 * Single-base RTK degrades with baseline length (≈ 1 ppm + ~1 cm): beyond
 * ~35 km a fixed solution becomes unreliable for L1/L2 rovers. Used to warn,
 * not to block.
 */
export const BASELINE_WARN_KM = 35;
