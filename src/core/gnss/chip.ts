/**
 * The external receiver's status chip (map and recording panel) and the
 * numbers its detail sheet repeats: what the state is called, how accurate
 * the receiver says it is, how many satellites it uses and how old its
 * corrections are. Mockup: research-gnss-team/mockup `gnss-chips-*.png`.
 *
 * House rule (same as `@core/recording/gpsChip`): the state is carried by the
 * words and the shape, never by colour alone. The accuracy is always the
 * receiver's own claim (GST σ or UBX hAcc → 95 %), or HDOP × UERE marked "≈";
 * never the phone's estimate.
 */
import type { GnssFix } from './fix';
import {
  CORR_AGING_S,
  usesCorrections,
  type AccuracyEstimate,
  type ExternalStatus,
  type FixKind,
  type QualityState,
} from './quality';

/**
 * How the chip is drawn. Each tone has its own word too ("RTK fixed",
 * "Corrections lost"…), so colour-blind users lose nothing.
 * - `fixed`: green outline; `float` / `warn`: amber outline; `dgps`: blue
 *   outline; `neutral`: plain outline; `lost`: red fill.
 */
export type ChipTone = 'fixed' | 'float' | 'dgps' | 'neutral' | 'warn' | 'lost';

/** The leading icon: the receiver, the phone's GPS, or a receiver that is gone. */
export type ChipIcon = 'receiver' | 'phone' | 'receiver-off';

export interface ReceiverChip {
  tone: ChipTone;
  icon: ChipIcon;
  /** "RTK fixed · ±1.4 cm" — the state and the accuracy. */
  label: string;
  /** "14 sats · corr 1 s" — null when there is nothing to add. */
  detail: string | null;
  /** The whole chip as one sentence for screen readers. */
  a11y: string;
}

/** The receiver link as the chip needs it (`modules/inukshuk-gnss` link states). */
export type ChipLink = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface ChipInput {
  link: ChipLink;
  /** The quality state machine's latest status (null before any). */
  status: ExternalStatus | null;
  /** The latest fix (null before any). */
  fix: GnssFix | null;
  /** The position source in use. */
  using: 'external' | 'phone';
  /** The phone's own accuracy, metres, when the phone is the source. */
  phoneAccuracyM: number | null;
  /** Falling back to the phone is allowed (Settings). */
  fallback: boolean;
  nowMs: number;
}

/** "±1.4 cm", "±18 cm", "±0.6 m", "±12 m"; "≈" in front when it comes from HDOP. */
export function formatAccuracy(m: number, basis: AccuracyEstimate['basis'] = 'receiver'): string {
  const approx = basis === 'hdop' ? '≈' : '';
  let text: string;
  if (m < 0.1) text = `${(Math.max(m, 0.001) * 100).toFixed(1)} cm`;
  else if (m < 1) text = `${Math.round(m * 100)} cm`;
  else if (m < 10) text = `${m.toFixed(1)} m`;
  else text = `${Math.round(m)} m`;
  return `${approx}±${text}`;
}

/**
 * Decimals of a degree worth showing for a position this accurate (95 %,
 * metres): the last digit about a tenth of the accuracy, 5…9 decimals
 * (1e-5° ≈ 1.1 m, 1e-9° ≈ 0.1 mm). A coordinate never claims more precision
 * than its fix.
 */
export function coordDecimals(accuracyM: number | null): number {
  if (accuracyM === null || !(accuracyM > 0)) return 6;
  const d = Math.ceil(-Math.log10(accuracyM / 10 / 111_320));
  return Math.min(9, Math.max(5, d));
}

/** "46.80293147° N, 71.17740218° W". */
export function formatLatLon(lat: number, lon: number, decimals: number): string {
  const ns = lat < 0 ? 'S' : 'N';
  const ew = lon < 0 ? 'W' : 'E';
  return `${Math.abs(lat).toFixed(decimals)}° ${ns}, ${Math.abs(lon).toFixed(decimals)}° ${ew}`;
}

/** A height with as many decimals as its accuracy supports ("62.418 m"). */
export function formatHeight(h: number, accuracyM: number | null): string {
  const d = accuracyM === null ? 1 : accuracyM < 0.1 ? 3 : accuracyM < 1 ? 2 : 1;
  return `${h.toFixed(d)} m`;
}

/** "3 s", "2 min", "1 h" — an age, as the chip states it. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h`;
}

/** The name of a fix kind, as the chip and sheet say it. */
export function kindLabel(kind: FixKind): string {
  switch (kind) {
    case 'rtk-fixed':
      return 'RTK fixed';
    case 'rtk-float':
      return 'RTK float';
    case 'dgps':
      return 'DGPS';
    case 'sbas':
      return 'SBAS';
    case 'autonomous':
      return 'Receiver';
    case 'dr':
      return 'Dead reckoning';
    default:
      return 'No fix';
  }
}

/** The quality state's name (Settings line, sheet header). */
export function stateLabel(state: QualityState): string {
  switch (state) {
    case 'fixed':
      return 'RTK fixed';
    case 'float':
      return 'RTK float';
    case 'dgps':
      return 'DGPS';
    case 'autonomous':
      return 'Autonomous';
    default:
      return 'No fix';
  }
}

function toneOf(state: QualityState): ChipTone {
  switch (state) {
    case 'fixed':
      return 'fixed';
    case 'float':
      return 'float';
    case 'dgps':
      return 'dgps';
    default:
      return 'neutral';
  }
}

/** "14 sats · corr 1 s": the satellites used and, for corrected fixes, the correction age. */
export function chipDetail(fix: GnssFix | null, status: ExternalStatus | null): string | null {
  const parts: string[] = [];
  if (fix?.satsUsed != null) parts.push(`${fix.satsUsed} sats`);
  const age = status?.correctionAgeS ?? null;
  if (fix && usesCorrections(fix.kind) && age !== null) parts.push(`corr ${formatAge(age)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function chip(
  tone: ChipTone,
  icon: ChipIcon,
  label: string,
  detail: string | null = null,
): ReceiverChip {
  return { tone, icon, label, detail, a11y: detail ? `${label}, ${detail}` : label };
}

/**
 * The chip for the receiver's current state.
 *
 * - connecting → "Connecting to receiver…";
 * - receiver silent/gone and the phone is the source → amber "Phone GPS ±5 m ·
 *   receiver off"; with no fallback allowed → red "Receiver lost · 1 min";
 * - RTK whose corrections stopped (> CORR_AGING_S) → amber "Corrections lost 14 s";
 * - otherwise the state's own word and the receiver's accuracy.
 */
export function receiverChip(i: ChipInput): ReceiverChip {
  if (i.link === 'connecting') return chip('neutral', 'receiver', 'Connecting to receiver…');
  const status = i.status;
  const lastAt = status?.lastFixAtMs ?? null;
  const gone = i.link !== 'connected' || status === null || status.freshness === 'lost';
  if (i.using === 'phone' && (gone || status.state === 'no-fix')) {
    if (!i.fallback) {
      const since = lastAt === null ? '' : ` · ${formatAge((i.nowMs - lastAt) / 1000)}`;
      return chip('lost', 'receiver-off', `Receiver lost${since}`);
    }
    const acc = i.phoneAccuracyM === null ? '' : ` ${formatAccuracy(i.phoneAccuracyM)}`;
    const why = gone ? 'receiver off' : 'receiver has no fix';
    return chip('warn', 'phone', `Phone GPS${acc} · ${why}`);
  }
  if (gone) {
    const since = lastAt === null ? '' : ` · ${formatAge((i.nowMs - lastAt) / 1000)}`;
    return chip('lost', 'receiver-off', `Receiver lost${since}`);
  }
  const fix = i.fix;
  const detail = chipDetail(fix, status);
  const acc = fix?.accuracy ? ` · ${formatAccuracy(fix.accuracy.h95, fix.accuracy.basis)}` : '';
  if (status.state === 'no-fix') return chip('neutral', 'receiver', 'Receiver · no fix', detail);
  if (status.freshness === 'stale') {
    const silent = lastAt === null ? '' : ` ${formatAge((i.nowMs - lastAt) / 1000)}`;
    return chip('warn', 'receiver', `Receiver silent${silent}${acc}`, detail);
  }
  if (
    (status.correction === 'aging' || status.correction === 'stale') &&
    status.correctionAgeS !== null &&
    status.correctionAgeS > CORR_AGING_S
  ) {
    return chip(
      'warn',
      'receiver',
      `Corrections lost ${formatAge(status.correctionAgeS)}${acc}`,
      fix?.satsUsed != null ? `${fix.satsUsed} sats` : null,
    );
  }
  const name =
    status.state === 'dgps' && fix?.kind === 'sbas'
      ? 'SBAS'
      : status.state === 'autonomous'
        ? 'Receiver'
        : stateLabel(status.state);
  return chip(toneOf(status.state), 'receiver', `${name}${acc}`, detail);
}
