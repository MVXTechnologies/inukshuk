/**
 * Stage 3's pure glue (src/core/gnss/README.md "State + UI"): one receiver
 * connection's bytes → fixes → quality status, the position-source policy
 * with its anti-flap hold, and the track point a fix becomes.
 *
 * The app's session (`@features/gnss/session`) owns the link, the clock and
 * the stores; everything it decides is decided here, from bytes and clock
 * values passed in.
 */
import type { TrackPoint } from '../models';
import type { GnssFix, SatInView } from './fix';
import { FixAssembler } from './fix';
import {
  decideSource,
  INITIAL_STATUS,
  nextStatus,
  type ExternalStatus,
  type PhoneGpsMode,
  type PositionSourceKind,
  type SourceDecision,
} from './quality';
import { GnssDemuxer, type StreamEvent } from './stream';
import { LAYER, minimalKitConfig } from './ubx';

/** Frames seen this connection, and the receiver's answers to CFG-VALSET. */
export interface StreamCounters {
  nmea: number;
  ubx: number;
  rtcm: number;
  /** ACK-ACK / ACK-NAK to a CFG-VALSET (the u-blox kit setup, `kitSetupFrames`). */
  cfgAck: number;
  cfgNak: number;
}

/**
 * One connection's parse state: a demuxer, an assembler and the quality
 * state machine. `push` per received chunk, `tick` on a ~1 s timer,
 * `discontinuity` whenever the byte stream stops being continuous (link
 * drop, other device, native overflow) — per the core's transport contract.
 */
export class ReceiverPipeline {
  /**
   * The connection's demuxer: the native adapter (`@data/gnss/receiverStream`)
   * pushes every chunk into it and resets it on a discontinuity, then hands
   * the frames to `events`.
   */
  readonly demuxer = new GnssDemuxer();
  private asm = new FixAssembler();
  status: ExternalStatus = INITIAL_STATUS;
  fix: GnssFix | null = null;
  readonly counters: StreamCounters = { nmea: 0, ubx: 0, rtcm: 0, cfgAck: 0, cfgNak: 0 };

  /** The latest sky view (GSV / NAV-SAT). */
  get sky(): SatInView[] {
    return this.asm.sky;
  }

  /** Feed one received chunk; returns the fixes it completed (oldest first). */
  push(chunk: Uint8Array, nowMs: number): GnssFix[] {
    return this.events(this.demuxer.push(chunk), nowMs);
  }

  /** Feed already-demuxed frames (the native adapter's `onFrames`). */
  events(evs: readonly StreamEvent[], nowMs: number): GnssFix[] {
    const out: GnssFix[] = [];
    for (const ev of evs) {
      this.counters[ev.kind === 'rtcm3' ? 'rtcm' : ev.kind] += 1;
      if (ev.kind === 'ubx' && ev.msg !== null && 'cls' in ev.msg && ev.msg.cls === 0x06) {
        this.counters[ev.msg.kind === 'ACK-ACK' ? 'cfgAck' : 'cfgNak'] += 1;
      }
      for (const f of this.asm.push(ev, nowMs)) out.push(this.accept(f, nowMs));
    }
    return out;
  }

  /** Silence check: call about once a second, data or not. */
  tick(nowMs: number): ExternalStatus {
    this.status = nextStatus(this.status, null, nowMs);
    return this.status;
  }

  /** The stream broke: close the epoch in progress and drop any partial frame. */
  discontinuity(nowMs: number): GnssFix[] {
    this.demuxer.reset();
    return this.flush(nowMs);
  }

  /** Close the epoch in progress (the adapter already reset the demuxer). */
  flush(nowMs: number): GnssFix[] {
    return this.asm.flush(nowMs).map((f) => this.accept(f, nowMs));
  }

  private accept(f: GnssFix, nowMs: number): GnssFix {
    this.fix = f;
    this.status = nextStatus(
      this.status,
      { kind: f.kind, correctionAgeS: f.correctionAgeS, receivedAtMs: nowMs },
      nowMs,
    );
    return f;
  }
}

// ---- u-blox kit setup -----------------------------------------------------------------------

/**
 * Receivers that are u-blox kits by name (SparkFun RTK, ArduSimple
 * simpleRTK, ZED-F9P boards): the app may configure them for its needs.
 */
const UBLOX_KIT_NAME =
  /sparkfun|rtk ?(facet|express|surveyor|torch|postcard)|ardusimple|simplertk|u-?blox|zed-?f9|\bf9p\b/i;

/**
 * Whether to write the minimal kit setup (`minimalKitConfig`) after
 * connecting: a u-blox kit by name, or a receiver that already speaks UBX on
 * this link. Never for a commercial receiver (Bad Elf, Garmin, Emlid), whose
 * configuration is its maker's business.
 */
export function isUbloxKit(name: string | null, counters: Pick<StreamCounters, 'ubx'>): boolean {
  return counters.ubx > 0 || (name !== null && UBLOX_KIT_NAME.test(name));
}

/**
 * The CFG-VALSET frames for a kit behind a BLE/SPP bridge: UART1 (where
 * SparkFun's ESP32 and ArduSimple's XBee-socket bridges sit), RTCM3 in, UBX
 * NAV + NMEA (GGA for NTRIP) out, 1 Hz, RAM only — the user's saved receiver
 * configuration is never overwritten.
 */
export function kitSetupFrames(): Uint8Array[] {
  return minimalKitConfig({ port: 'UART1', rateHz: 1, nmea: true, layers: LAYER.RAM });
}

// ---- position source -----------------------------------------------------------------------

export interface SourceState {
  current: PositionSourceKind;
  lastSwitchAtMs: number | null;
}

export const INITIAL_SOURCE: SourceState = { current: 'phone', lastSwitchAtMs: null };

export interface SourceOptions {
  /** "Phone GPS while the receiver is good": standby (A9, default) or off. */
  phoneWhileGood: 'standby' | 'off';
  /** "Use the phone GPS when the receiver drops" (Settings; default on). */
  fallback: boolean;
}

export interface SourceOutcome {
  state: SourceState;
  decision: SourceDecision;
  /** What the app uses: the decision, unless fallback is off (then the receiver, lost or not). */
  use: PositionSourceKind;
  /** How hard the phone's GPS works. */
  phone: PhoneGpsMode;
}

/**
 * `decideSource` with its state threaded through, plus the "no fallback"
 * option: with fallback off the receiver stays the source when it drops (the
 * recording then auto-pauses on "location lost"), and the phone GPS stays in
 * standby — it feeds nothing, so it need not work hard.
 */
export function arbitrate(
  prev: SourceState,
  external: ExternalStatus | null,
  nowMs: number,
  opts: SourceOptions,
): SourceOutcome {
  const decision = decideSource({
    external,
    current: prev.current,
    lastSwitchAtMs: prev.lastSwitchAtMs,
    nowMs,
    externalOnly: opts.phoneWhileGood === 'off',
  });
  const state: SourceState = decision.switched
    ? { current: decision.use, lastSwitchAtMs: nowMs }
    : { current: decision.use, lastSwitchAtMs: prev.lastSwitchAtMs };
  if (!opts.fallback && external !== null) {
    return {
      state,
      decision,
      use: 'external',
      phone: opts.phoneWhileGood === 'off' ? 'off' : 'standby',
    };
  }
  return { state, decision, use: decision.use, phone: decision.phone };
}

// ---- recording ---------------------------------------------------------------------------

/** A position to record: the fix's coordinates as drawn on the map (WGS 84). */
export interface MapPosition {
  lat: number;
  lon: number;
}

/**
 * The track point an external fix becomes. Time is the phone's clock at
 * arrival (the recorder's pauses and the phone feed are on that clock; the
 * receiver's UTC can differ by its latency or a replayed session's date).
 * Altitude is the receiver's MSL height (its geoid), else its ellipsoidal
 * height, like the phone's own. The accuracy is the receiver's 95 % claim.
 */
export function trackPointFromFix(fix: GnssFix, pos: MapPosition, nowMs: number): TrackPoint {
  const p: TrackPoint = {
    latitude: pos.lat,
    longitude: pos.lon,
    time: nowMs,
    source: 'external',
    gnss: { fix: fix.kind },
  };
  const alt = fix.hMsl ?? fix.hEll;
  if (alt !== null) p.altitude = alt;
  if (fix.accuracy) {
    p.accuracy = fix.accuracy.h95;
    if (fix.accuracy.v95 !== null) p.altitudeAccuracy = fix.accuracy.v95;
  }
  if (fix.speedMps !== null) p.speed = fix.speedMps;
  const g = p.gnss as NonNullable<TrackPoint['gnss']>;
  if (fix.satsUsed !== null) g.sats = fix.satsUsed;
  if (fix.correctionAgeS !== null) g.ageS = fix.correctionAgeS;
  if (fix.hdop !== null) g.hdop = fix.hdop;
  return p;
}

/** Approximate ground distance, metres (equirectangular; fine below a few km). */
export function shortDistanceM(a: MapPosition, b: MapPosition): number {
  const k = 111_320;
  const dx = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dx, (b.lat - a.lat) * k);
}

/**
 * Whether an external fix goes to the recorder: like the phone watch's
 * distance filter (`minDisplacementM`, at least 1 m), so a 10 Hz receiver on
 * a stationary hiker doesn't add a point a tenth of a second.
 */
export function shouldRecord(
  last: MapPosition | null,
  next: MapPosition,
  minDisplacementM: number,
): boolean {
  if (last === null) return true;
  return shortDistanceM(last, next) >= Math.max(1, minDisplacementM);
}
