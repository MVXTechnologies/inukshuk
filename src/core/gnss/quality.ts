/**
 * Fix quality: what kind of solution a fix is, how accurate it claims to be,
 * whether the stream and its corrections are fresh, and — the policy part —
 * when the app should use the external receiver and when the phone's own GPS
 * (kept in low-power standby, owner decision A9, 2026-10-06).
 *
 * Everything is a pure function of its inputs and a clock value passed in.
 */

export type FixKind =
  | 'none'
  | 'autonomous'
  | 'sbas'
  | 'dgps'
  | 'rtk-float'
  | 'rtk-fixed'
  | 'dr'
  | 'manual'
  | 'simulated';

/** The five user-facing quality states (the chip). */
export type QualityState = 'no-fix' | 'autonomous' | 'dgps' | 'float' | 'fixed';

/** GGA quality indicator → kind (NMEA 0183 v4.11; 9 is used by some receivers for SBAS). */
export function kindFromGga(q: number): FixKind {
  switch (q) {
    case 1:
    case 3:
      return 'autonomous';
    case 2:
      return 'dgps';
    case 4:
      return 'rtk-fixed';
    case 5:
      return 'rtk-float';
    case 6:
      return 'dr';
    case 7:
      return 'manual';
    case 8:
      return 'simulated';
    case 9:
      return 'sbas';
    default:
      return 'none';
  }
}

/** RMC / VTG / GNS mode letter, used to tell SBAS from RTCM DGPS on GGA quality 2. */
export function kindFromMode(mode: string | null, ggaKind: FixKind): FixKind {
  if (ggaKind !== 'dgps' || mode === null) return ggaKind;
  // NMEA 4.x: D = differential (SBAS or DGPS); u-blox and Septentrio send D for SBAS too,
  // so only R/F (RTK) change the kind here — they mean GGA was out of date.
  if (mode === 'R') return 'rtk-fixed';
  if (mode === 'F') return 'rtk-float';
  return ggaKind;
}

/** UBX NAV-PVT fixType + flags → kind. */
export function kindFromUbx(p: {
  fixType: number;
  gnssFixOk: boolean;
  diffSoln: boolean;
  carrSoln: number;
}): FixKind {
  if (!p.gnssFixOk || p.fixType === 0 || p.fixType === 5) return 'none';
  if (p.fixType === 1) return 'dr';
  if (p.carrSoln === 2) return 'rtk-fixed';
  if (p.carrSoln === 1) return 'rtk-float';
  if (p.diffSoln) return 'dgps';
  return 'autonomous';
}

export function stateOf(kind: FixKind): QualityState {
  switch (kind) {
    case 'rtk-fixed':
      return 'fixed';
    case 'rtk-float':
      return 'float';
    case 'dgps':
    case 'sbas':
      return 'dgps';
    case 'autonomous':
    case 'dr':
      return 'autonomous';
    default:
      // manual / simulated positions are not a GNSS fix of the receiver's own.
      return 'no-fix';
  }
}

/** Whether a kind uses corrections from a correction source (vs. SBAS / none). */
export function usesCorrections(kind: FixKind): boolean {
  return kind === 'rtk-fixed' || kind === 'rtk-float' || kind === 'dgps';
}

// ---- accuracy -------------------------------------------------------------------------

/**
 * 95 % radius of a 2D normal error with per-axis σ (√χ²₂(0.95) = 2.4477);
 * exact for circular errors, the usual approximation otherwise.
 */
export const K95_2D = 2.4477;
/** 95 % of a 1D normal error. */
export const K95_1D = 1.96;

/** Horizontal 95 % radius from per-axis 1σ (GST σlat/σlon, or UBX hAcc taken as per-axis σ). */
export function horizontal95(sigmaLat: number, sigmaLon: number): number {
  return K95_2D * Math.sqrt((sigmaLat * sigmaLat + sigmaLon * sigmaLon) / 2);
}

/**
 * Nominal user-equivalent range error per kind, metres — the "≈" fallback
 * when a receiver reports only HDOP (no GST, no hAcc). Order-of-magnitude
 * values, labelled approximate wherever shown.
 */
export const UERE_M: Record<FixKind, number | null> = {
  none: null,
  autonomous: 4,
  sbas: 1.5,
  dgps: 0.8,
  'rtk-float': 0.3,
  'rtk-fixed': 0.02,
  dr: 10,
  manual: null,
  simulated: null,
};

export interface AccuracyEstimate {
  /** Horizontal 95 % radius, metres. */
  h95: number;
  /** Vertical 95 %, metres, when known. */
  v95: number | null;
  /** Where the number comes from; 'hdop' values are shown with "≈". */
  basis: 'receiver' | 'hdop';
}

export function accuracyOf(f: {
  kind: FixKind;
  sigmaLat: number | null;
  sigmaLon: number | null;
  sigmaV: number | null;
  hdop: number | null;
}): AccuracyEstimate | null {
  if (f.sigmaLat !== null && f.sigmaLon !== null) {
    return {
      h95: horizontal95(f.sigmaLat, f.sigmaLon),
      v95: f.sigmaV === null ? null : K95_1D * f.sigmaV,
      basis: 'receiver',
    };
  }
  const uere = UERE_M[f.kind];
  if (f.hdop === null || uere === null) return null;
  return { h95: K95_2D * f.hdop * uere, v95: null, basis: 'hdop' };
}

// ---- stream + correction freshness -----------------------------------------------------------

/** No fix for this long: the stream is stale (the chip greys out, phone GPS warms up). */
export const STREAM_STALE_MS = 2_000;
/** No fix for this long: the receiver is lost; fall back to the phone (GNSS.md §4.5). */
export const STREAM_LOST_MS = 5_000;
/** RTK degrades past this correction age (amber). */
export const CORR_AGING_S = 10;
/** Corrections this old are not trusted (red); the fix is shown at most as float. */
export const CORR_STALE_S = 60;

export type Freshness = 'live' | 'stale' | 'lost';
export type CorrectionHealth = 'none' | 'ok' | 'aging' | 'stale';

export interface QualityInput {
  kind: FixKind;
  /** Age of corrections the fix reports, seconds. */
  correctionAgeS: number | null;
  /** Clock time the fix was received, ms. */
  receivedAtMs: number;
}

export interface ExternalStatus {
  state: QualityState;
  freshness: Freshness;
  correction: CorrectionHealth;
  /** The receiver's own claim before stale-correction downgrade. */
  reportedState: QualityState;
  correctionAgeS: number | null;
  lastFixAtMs: number | null;
  /** When `state` was entered, ms. */
  sinceMs: number;
}

export const INITIAL_STATUS: ExternalStatus = {
  state: 'no-fix',
  freshness: 'lost',
  correction: 'none',
  reportedState: 'no-fix',
  correctionAgeS: null,
  lastFixAtMs: null,
  sinceMs: 0,
};

export function correctionHealth(kind: FixKind, ageS: number | null): CorrectionHealth {
  if (!usesCorrections(kind)) return 'none';
  if (ageS === null) return 'ok';
  if (ageS > CORR_STALE_S) return 'stale';
  if (ageS > CORR_AGING_S) return 'aging';
  return 'ok';
}

function freshnessAt(lastFixAtMs: number | null, nowMs: number): Freshness {
  if (lastFixAtMs === null) return 'lost';
  const dt = nowMs - lastFixAtMs;
  if (dt >= STREAM_LOST_MS) return 'lost';
  if (dt >= STREAM_STALE_MS) return 'stale';
  return 'live';
}

/**
 * The quality state machine. Call with each new fix (`fix`) and on a timer
 * (`fix` = null) so staleness is noticed without data. Corrections older
 * than CORR_STALE_S cap an RTK-fixed claim at "float": the receiver keeps
 * saying "fixed" while the solution drifts.
 */
export function nextStatus(
  prev: ExternalStatus,
  fix: QualityInput | null,
  nowMs: number,
): ExternalStatus {
  let reported = prev.reportedState;
  let ageS = prev.correctionAgeS;
  let lastFixAtMs = prev.lastFixAtMs;
  let correction = prev.correction;
  if (fix) {
    reported = stateOf(fix.kind);
    ageS = fix.correctionAgeS;
    lastFixAtMs = fix.receivedAtMs;
    correction = correctionHealth(fix.kind, fix.correctionAgeS);
  }
  const freshness = freshnessAt(lastFixAtMs, nowMs);
  let state: QualityState = freshness === 'lost' ? 'no-fix' : reported;
  if (state === 'fixed' && correction === 'stale') state = 'float';
  return {
    state,
    freshness,
    correction,
    reportedState: reported,
    correctionAgeS: ageS,
    lastFixAtMs,
    sinceMs: state === prev.state ? prev.sinceMs : nowMs,
  };
}

// ---- source policy (external vs phone GPS) ------------------------------------------------

export type PositionSourceKind = 'external' | 'phone';
/** Phone GPS power mode: off, low-power standby (instant fallback), full accuracy. */
export type PhoneGpsMode = 'off' | 'standby' | 'active';

/** Never switch sources twice within this window (no 1.5 m back-and-forth teleports). */
export const MIN_SWITCH_MS = 2_000;

export interface SourcePolicyInput {
  /** null = no external receiver connected. */
  external: ExternalStatus | null;
  current: PositionSourceKind;
  lastSwitchAtMs: number | null;
  nowMs: number;
  /** User opted for "external only" (phone GPS off while the receiver is good). */
  externalOnly: boolean;
}

export type SourceReason =
  'no-receiver' | 'receiver-ok' | 'receiver-stale' | 'receiver-lost' | 'receiver-no-fix' | 'hold';

export interface SourceDecision {
  use: PositionSourceKind;
  phone: PhoneGpsMode;
  reason: SourceReason;
  /** The source changed: the recorder starts a new segment (never joins two sources). */
  switched: boolean;
}

/**
 * Which position source to use, and how hard the phone GPS should work.
 *
 * - receiver good → external; phone in low-power standby (off if "external only");
 * - receiver stale (2–5 s silent) → keep external, phone to full power so a fallback is instant;
 * - receiver lost (> 5 s) or no fix → phone, full power;
 * - a switch is held off for MIN_SWITCH_MS after the previous one.
 */
export function decideSource(p: SourcePolicyInput): SourceDecision {
  const ext = p.external;
  let want: PositionSourceKind;
  let phone: PhoneGpsMode;
  let reason: SourceReason;
  if (ext === null) {
    want = 'phone';
    phone = 'active';
    reason = 'no-receiver';
  } else if (ext.freshness === 'lost') {
    want = 'phone';
    phone = 'active';
    reason = 'receiver-lost';
  } else if (ext.state === 'no-fix') {
    want = 'phone';
    phone = 'active';
    reason = 'receiver-no-fix';
  } else if (ext.freshness === 'stale') {
    want = 'external';
    phone = 'active';
    reason = 'receiver-stale';
  } else {
    want = 'external';
    phone = p.externalOnly ? 'off' : 'standby';
    reason = 'receiver-ok';
  }
  if (want !== p.current) {
    const held = p.lastSwitchAtMs !== null && p.nowMs - p.lastSwitchAtMs < MIN_SWITCH_MS;
    // Falling back to the phone is never held when there is no receiver at all.
    if (held && ext !== null) {
      return { use: p.current, phone: 'active', reason: 'hold', switched: false };
    }
    return { use: want, phone, reason, switched: true };
  }
  return { use: want, phone, reason, switched: false };
}
