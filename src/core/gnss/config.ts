/**
 * The receiver extension's saved settings (`gnss.json`): the paired receiver,
 * the NTRIP correction profiles, the project datum and the phone-GPS policy.
 * Never the caster password: that lives in the secret store
 * (`@data/gnss/credentials`), keyed by the profile id.
 *
 * `sanitizeGnssConfig` reads any version of the file, or junk, field by
 * field: a bad field takes its default, never the whole file.
 */
import { FRAMES } from '../convert/systems';
import type { FrameId } from '../convert/types';
import { presetById, type CorrectionFrame, type EpochSpec } from './casters';
import { buildNtripRequest, NtripConfigError } from './ntrip';
import type { Corrections } from './output';
import { DEFAULT_PROJECT_DATUM_ID, isProjectDatumId } from './projectDatum';

export const GNSS_CONFIG_VERSION = 1;

/** How the paired receiver is reached (`modules/inukshuk-gnss` transports). */
export type ReceiverTransport = 'ble' | 'spp' | 'fake';

export interface PairedReceiver {
  id: string;
  name: string;
  transport: ReceiverTransport;
}

/** One NTRIP caster + mountpoint, and what its corrections' coordinates are in. */
export interface NtripProfile {
  id: string;
  /** "RTK2go · LEVIS_F9P". */
  label: string;
  /** The caster preset it started from (`casters.ts`), or null for a custom caster. */
  presetId: string | null;
  host: string;
  port: number;
  version: 1 | 2;
  mountpoint: string;
  username: string;
  /** The caster's frame and epoch; null = unknown (WGS 84 assumed, ⚠ shown — owner A5). */
  frame: CorrectionFrame | null;
  /** The sourcetable says the mountpoint needs the rover's position (VRS / nearest base). */
  needsGga: boolean;
  /** The user agreed to send their position to this caster (privacy disclosure). */
  ggaConsent: boolean;
  /** The mountpoint's position from the sourcetable, for the baseline line. */
  baseLat: number | null;
  baseLon: number | null;
}

export interface GnssConfig {
  version: number;
  receiver: PairedReceiver | null;
  profiles: NtripProfile[];
  /** The profile whose corrections are streamed; null = no corrections from the app. */
  activeProfileId: string | null;
  /** The project datum (`projectDatum.ts` option id). */
  projectDatumId: string;
  /** "Use the phone GPS when the receiver drops". */
  fallbackToPhone: boolean;
  /** The phone's GPS while the receiver is good: low-power standby (A9) or off. */
  phoneWhileGood: 'standby' | 'off';
}

export const DEFAULT_GNSS_CONFIG: GnssConfig = {
  version: GNSS_CONFIG_VERSION,
  receiver: null,
  profiles: [],
  activeProfileId: null,
  projectDatumId: DEFAULT_PROJECT_DATUM_ID,
  fallbackToPhone: true,
  phoneWhileGood: 'standby',
};

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
const str = (v: unknown, max = 256): string | null =>
  typeof v === 'string' && v.length <= max ? v : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function epochOf(v: unknown): EpochSpec | undefined {
  if (v === 'observation') return 'observation';
  const n = num(v);
  return n !== null && n > 1900 && n < 2200 ? n : undefined;
}

function frameOf(v: unknown): CorrectionFrame | null {
  const r = rec(v);
  const id = r ? str(r.frame, 32) : null;
  if (r === null || id === null || !(id in FRAMES)) return null;
  const frame = id as FrameId;
  const epoch = epochOf(r.epoch);
  return epoch === undefined ? { frame } : { frame, epoch };
}

function receiverOf(v: unknown): PairedReceiver | null {
  const r = rec(v);
  if (!r) return null;
  const id = str(r.id);
  const name = str(r.name) ?? '';
  const t = r.transport;
  if (id === null || id === '' || (t !== 'ble' && t !== 'spp' && t !== 'fake')) return null;
  return { id, name, transport: t };
}

function profileOf(v: unknown): NtripProfile | null {
  const r = rec(v);
  if (!r) return null;
  const id = str(r.id, 64);
  const host = str(r.host);
  const port = num(r.port);
  if (id === null || id === '' || host === null || port === null) return null;
  const lat = num(r.baseLat);
  const lon = num(r.baseLon);
  return {
    id,
    label: str(r.label) ?? host,
    presetId: str(r.presetId, 64),
    host,
    port,
    version: r.version === 2 ? 2 : 1,
    mountpoint: str(r.mountpoint) ?? '',
    username: str(r.username) ?? '',
    frame: frameOf(r.frame),
    needsGga: r.needsGga === true,
    ggaConsent: r.ggaConsent === true,
    baseLat: lat !== null && Math.abs(lat) <= 90 ? lat : null,
    baseLon: lon !== null && Math.abs(lon) <= 180 ? lon : null,
  };
}

/** The config from a parsed `gnss.json` of any version, or junk. Never throws. */
export function sanitizeGnssConfig(raw: unknown): GnssConfig {
  const r = rec(raw) ?? {};
  const profiles: NtripProfile[] = [];
  if (Array.isArray(r.profiles)) {
    for (const p of r.profiles) {
      const ok = profileOf(p);
      if (ok && !profiles.some((x) => x.id === ok.id)) profiles.push(ok);
    }
  }
  const active = str(r.activeProfileId, 64);
  return {
    version: GNSS_CONFIG_VERSION,
    receiver: receiverOf(r.receiver),
    profiles,
    activeProfileId: active !== null && profiles.some((p) => p.id === active) ? active : null,
    projectDatumId: isProjectDatumId(r.projectDatumId)
      ? r.projectDatumId
      : DEFAULT_PROJECT_DATUM_ID,
    fallbackToPhone: r.fallbackToPhone !== false,
    phoneWhileGood: r.phoneWhileGood === 'off' ? 'off' : 'standby',
  };
}

/** The active profile, if any. */
export function activeProfile(c: GnssConfig): NtripProfile | null {
  return c.profiles.find((p) => p.id === c.activeProfileId) ?? null;
}

/** What `receiverFrame` gets: the active profile's frame (null = unknown), or 'none'. */
export function correctionsOf(c: GnssConfig): Corrections {
  const p = activeProfile(c);
  return p === null ? 'none' : p.frame;
}

/** A new profile, from a caster preset or blank. */
export function newProfile(id: string, presetId: string | null): NtripProfile {
  const preset = presetId === null ? undefined : presetById(presetId);
  return {
    id,
    label: preset?.label ?? 'NTRIP caster',
    presetId: preset?.id ?? null,
    host: preset?.host ?? '',
    port: preset?.port ?? 2101,
    version: preset?.version ?? 2,
    mountpoint: '',
    username: '',
    frame: preset?.frame ?? null,
    needsGga: false,
    ggaConsent: false,
    baseLat: null,
    baseLon: null,
  };
}

/**
 * What is wrong with a profile, in the editor's words; null when it can
 * connect. The checks are the request builder's own (it refuses what it
 * can't send safely), so the editor and the session never disagree.
 */
export function profileProblem(
  p: Pick<NtripProfile, 'host' | 'port' | 'mountpoint' | 'version' | 'username'>,
  opts: { needMountpoint: boolean } = { needMountpoint: true },
): string | null {
  if (p.host.trim() === '') return 'Enter the caster address';
  if (opts.needMountpoint && p.mountpoint.trim() === '') return 'Choose a mountpoint';
  try {
    buildNtripRequest({
      host: p.host.trim(),
      port: p.port,
      mountpoint: p.mountpoint.trim(),
      version: p.version,
      username: p.username,
    });
    return null;
  } catch (e) {
    /* istanbul ignore next -- the builder throws nothing else */
    if (!(e instanceof NtripConfigError)) throw e;
    return e.message;
  }
}
