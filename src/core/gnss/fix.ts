/**
 * The fix model and the epoch assembler: stream events (NMEA sentences, UBX
 * NAV messages) → one `GnssFix` per navigation epoch.
 *
 * NMEA: an epoch is everything sharing one UTC time of day (GGA, RMC, GST,
 * ZDA carry it; GSA, GSV and VTG attach to the epoch in progress). It closes
 * when a sentence with another time arrives, or on `flush()`.
 * UBX: an epoch is everything sharing one iTOW (NAV-PVT, HPPOSLLH, STATUS).
 * When a receiver sends both, UBX wins (it has the high-precision position
 * and the correction age) and NMEA epochs are dropped while UBX is flowing.
 *
 * Coordinates are as the receiver output them, in the frame of whatever
 * corrected them (`datum.ts` says which and converts).
 */
import { constellationOf, type NmeaMessage } from './nmea';
import {
  accuracyOf,
  kindFromGga,
  kindFromMode,
  kindFromUbx,
  type AccuracyEstimate,
  type FixKind,
} from './quality';
import type { StreamEvent } from './stream';
import type { NavHpposllh, NavPvt, NavSat, NavStatus, UbxMessage } from './ubx';

export interface SatInView {
  /** 'gps', 'glonass', 'galileo', 'beidou', 'qzss', 'navic', 'sbas', 'other'. */
  system: string;
  prn: number;
  elevDeg: number | null;
  azDeg: number | null;
  /** C/N0 or SNR, dB(Hz). */
  snr: number | null;
  /** Used in the solution (UBX NAV-SAT); null when the stream doesn't say (NMEA GSV). */
  used: boolean | null;
}

export interface GnssFix {
  /** UTC ms; null until a date is known (RMC / ZDA / NAV-PVT). */
  timeMs: number | null;
  lat: number;
  lon: number;
  /** Ellipsoidal height, metres (NMEA: altMsl + geoidSep; UBX: height). */
  hEll: number | null;
  /** Height above the receiver's own geoid model — never used for survey output. */
  hMsl: number | null;
  geoidSep: number | null;
  kind: FixKind;
  /** 1σ errors, metres (GST, or UBX hAcc per axis / vAcc). */
  sigmaLat: number | null;
  sigmaLon: number | null;
  sigmaV: number | null;
  accuracy: AccuracyEstimate | null;
  hdop: number | null;
  pdop: number | null;
  vdop: number | null;
  satsUsed: number | null;
  satsInView: number | null;
  correctionAgeS: number | null;
  baseId: string | null;
  /** UBX NAV-STATUS diffCorr: corrections are reaching the receiver (null: not reported). */
  correctionsInput: boolean | null;
  speedMps: number | null;
  courseDeg: number | null;
  protocol: 'nmea' | 'ubx';
}

const DAY_MS = 86_400_000;

function dateMs(d: { y: number; m: number; d: number }): number {
  return Date.UTC(d.y, d.m - 1, d.d);
}

interface NmeaEpoch {
  tod: number | null;
  gga?: Extract<NmeaMessage, { type: 'GGA' }>;
  rmc?: Extract<NmeaMessage, { type: 'RMC' }>;
  gst?: Extract<NmeaMessage, { type: 'GST' }>;
  vtg?: Extract<NmeaMessage, { type: 'VTG' }>;
  gsa: Extract<NmeaMessage, { type: 'GSA' }>[];
}

interface UbxEpoch {
  iTOW: number;
  pvt?: NavPvt;
  hp?: NavHpposllh;
  status?: NavStatus;
}

/** How long UBX keeps priority over NMEA after its last NAV-PVT. */
export const UBX_PRIORITY_MS = 3_000;

export class FixAssembler {
  private n: NmeaEpoch | null = null;
  private u: UbxEpoch | null = null;
  /** UTC midnight of the current day, ms, from RMC / ZDA. */
  private dayMs: number | null = null;
  private lastTod: number | null = null;
  private inView = new Map<string, number>();
  private lastPvtAt: number | null = null;
  /** Latest sky view (GSV or NAV-SAT). */
  sky: SatInView[] = [];
  private gsvBuild = new Map<string, SatInView[]>();
  private skyBy = new Map<string, SatInView[]>();

  /**
   * Feed one stream event; returns the fixes it completes (0 or 1, rarely 2).
   * `nowMs` is the arrival clock time, used only for the UBX-over-NMEA priority.
   */
  push(ev: StreamEvent, nowMs: number): GnssFix[] {
    if (ev.kind === 'rtcm3') return [];
    if (ev.kind === 'ubx') return this.ubx(ev.msg, nowMs);
    return this.nmea(ev.msg, nowMs);
  }

  /** Close the epochs in progress (end of stream / disconnect). */
  flush(nowMs: number): GnssFix[] {
    const out: GnssFix[] = [];
    const u = this.closeUbx();
    if (u) out.push(u);
    const n = this.closeNmea(nowMs);
    if (n) out.push(n);
    return out;
  }

  private ubxActive(nowMs: number): boolean {
    return this.lastPvtAt !== null && nowMs - this.lastPvtAt < UBX_PRIORITY_MS;
  }

  // ---- NMEA ----

  private nmea(m: NmeaMessage, nowMs: number): GnssFix[] {
    const out: GnssFix[] = [];
    // u-blox sends an epoch's UBX messages before its NMEA: NMEA closes the UBX epoch.
    const u = this.closeUbx();
    if (u) out.push(u);
    if (m.type === 'ZDA' || m.type === 'RMC') {
      if (m.date) this.dayMs = dateMs(m.date);
    }
    if (m.type === 'GSV') {
      this.gsv(m);
      return out;
    }
    const tod =
      m.type === 'GGA' || m.type === 'RMC' || m.type === 'GST' || m.type === 'ZDA'
        ? m.tod
        : undefined;
    if (tod !== undefined && tod !== null && this.n && this.n.tod !== null && tod !== this.n.tod) {
      const f = this.closeNmea(nowMs);
      if (f) out.push(f);
    }
    if (!this.n) this.n = { tod: tod ?? null, gsa: [] };
    if (this.n.tod === null && tod !== undefined && tod !== null) this.n.tod = tod;
    switch (m.type) {
      case 'GGA':
        this.n.gga = m;
        break;
      case 'RMC':
        this.n.rmc = m;
        break;
      case 'GST':
        this.n.gst = m;
        break;
      case 'VTG':
        this.n.vtg = m;
        break;
      case 'GSA':
        this.n.gsa.push(m);
        break;
      default:
        break;
    }
    return out;
  }

  private gsv(m: Extract<NmeaMessage, { type: 'GSV' }>): void {
    const key = `${m.talker}/${m.signalId ?? ''}`;
    this.inView.set(key, m.inView);
    const system = constellationOf(m.talker);
    const list = m.index === 1 ? [] : (this.gsvBuild.get(key) ?? []);
    for (const s of m.sats) {
      list.push({ system, prn: s.prn, elevDeg: s.elevDeg, azDeg: s.azDeg, snr: s.snr, used: null });
    }
    this.gsvBuild.set(key, list);
    if (m.index === m.total) {
      this.skyBy.set(key, list);
      this.sky = [...this.skyBy.values()].flat();
    }
  }

  private timeOf(tod: number | null): number | null {
    if (tod === null || this.dayMs === null) return null;
    // Midnight rollover between the date sentence and this one.
    if (this.lastTod !== null && tod + 43_200 < this.lastTod) this.dayMs += DAY_MS;
    this.lastTod = tod;
    return this.dayMs + Math.round(tod * 1000);
  }

  private closeNmea(nowMs: number): GnssFix | null {
    const e = this.n;
    this.n = null;
    if (!e) return null;
    const gga = e.gga;
    const rmc = e.rmc;
    if (this.ubxActive(nowMs)) return null;
    const lat = gga?.lat ?? rmc?.lat ?? null;
    const lon = gga?.lon ?? rmc?.lon ?? null;
    if (lat === null || lon === null) return null;
    let kind: FixKind;
    if (gga) kind = kindFromMode(rmc?.mode ?? null, kindFromGga(gga.quality));
    else kind = rmc?.valid ? 'autonomous' : 'none';
    const hEll =
      gga && gga.altMsl !== null && gga.geoidSep !== null ? gga.altMsl + gga.geoidSep : null;
    // Several GSAs (one per constellation) share the same DOPs; take the first.
    const gsa = e.gsa[0];
    const satsFromGsa = e.gsa.length > 0 ? e.gsa.reduce((s, g) => s + g.prns.length, 0) : null;
    let inView: number | null = null;
    for (const [k, v] of this.inView) if (!k.startsWith('GN/')) inView = (inView ?? 0) + v;
    const sigmaLat = e.gst?.sigmaLat ?? null;
    const sigmaLon = e.gst?.sigmaLon ?? null;
    const sigmaV = e.gst?.sigmaAlt ?? null;
    const hdop = gga?.hdop ?? gsa?.hdop ?? null;
    return {
      timeMs: this.timeOf(e.tod),
      lat,
      lon,
      hEll,
      hMsl: gga?.altMsl ?? null,
      geoidSep: gga?.geoidSep ?? null,
      kind,
      sigmaLat,
      sigmaLon,
      sigmaV,
      accuracy: accuracyOf({ kind, sigmaLat, sigmaLon, sigmaV, hdop }),
      hdop,
      pdop: gsa?.pdop ?? null,
      vdop: gsa?.vdop ?? null,
      satsUsed: gga?.satsUsed ?? satsFromGsa,
      satsInView: inView,
      correctionAgeS: gga?.ageS ?? null,
      baseId: gga?.baseId ?? null,
      correctionsInput: null,
      speedMps: rmc?.speedMps ?? e.vtg?.speedMps ?? null,
      courseDeg: rmc?.courseDeg ?? e.vtg?.courseTrue ?? null,
      protocol: 'nmea',
    };
  }

  // ---- UBX ----

  private ubx(m: UbxMessage | null, nowMs: number): GnssFix[] {
    if (m === null || !('iTOW' in m)) return [];
    if (m.kind === 'NAV-SAT') {
      this.navSat(m);
      return [];
    }
    const out: GnssFix[] = [];
    if (this.u && this.u.iTOW !== m.iTOW) {
      const f = this.closeUbx();
      if (f) out.push(f);
    }
    if (!this.u) this.u = { iTOW: m.iTOW };
    if (m.kind === 'NAV-PVT') {
      this.u.pvt = m;
      this.lastPvtAt = nowMs;
      // A PVT supersedes any NMEA epoch in progress.
      this.n = null;
    } else if (m.kind === 'NAV-HPPOSLLH') this.u.hp = m;
    else this.u.status = m;
    return out;
  }

  private navSat(m: NavSat): void {
    this.sky = m.svs.map((s) => ({
      system: s.gnss,
      prn: s.svId,
      elevDeg: s.elevDeg,
      azDeg: s.azDeg,
      snr: s.cno,
      used: s.used,
    }));
    this.inView.clear();
    this.inView.set('UBX/', m.svs.length);
    this.skyBy.clear();
  }

  private closeUbx(): GnssFix | null {
    const e = this.u;
    this.u = null;
    const p = e?.pvt;
    if (!e || !p) return null;
    const hp = e.hp && !e.hp.invalidLlh ? e.hp : null;
    const kind = kindFromUbx(p);
    if (p.invalidLlh && !hp) return null;
    const hAcc = hp ? hp.hAcc : p.hAcc;
    const vAcc = hp ? hp.vAcc : p.vAcc;
    const age = p.correctionAgeS;
    const inView = this.inView.get('UBX/') ?? null;
    return {
      timeMs: p.utcMs,
      lat: hp ? hp.lat : p.lat,
      lon: hp ? hp.lon : p.lon,
      hEll: hp ? hp.height : p.height,
      hMsl: hp ? hp.hMSL : p.hMSL,
      geoidSep: hp ? hp.height - hp.hMSL : p.height - p.hMSL,
      kind,
      sigmaLat: hAcc,
      sigmaLon: hAcc,
      sigmaV: vAcc,
      accuracy: accuracyOf({ kind, sigmaLat: hAcc, sigmaLon: hAcc, sigmaV: vAcc, hdop: null }),
      hdop: null,
      pdop: p.pDOP,
      vdop: null,
      satsUsed: p.numSV,
      satsInView: inView,
      // u-blox reports an interval; the upper bound is the honest age.
      correctionAgeS: age === null ? null : age[1],
      baseId: null,
      correctionsInput: e.status ? e.status.diffCorr : null,
      speedMps: p.gSpeed,
      courseDeg: p.headMot,
      protocol: 'ubx',
    };
  }
}
