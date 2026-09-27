import { GPS_LOST_MS, type GpsQuality } from '../geo/track/gpsQuality';

/**
 * The recording panel's GPS chip (revamp `After-Recording.html`,
 * `After-Paused.html`): state is carried by text and shape, not colour alone.
 *
 * - `ok`: outline chip, "GPS ±5 m";
 * - `weak`: amber outline chip, "Weak GPS · ±35 m";
 * - `lost`: red chip, "No GPS · 2 min";
 * - `acquiring`: outline chip, "Finding GPS…".
 */
export interface GpsChip {
  kind: 'ok' | 'weak' | 'lost' | 'acquiring';
  label: string;
}

/** Accuracy radius, rounded for display (never below 1 m). */
function metres(accuracyM: number): string {
  return `±${Math.max(1, Math.round(accuracyM))} m`;
}

/** Time since the last fix, as the lost chip states it. */
function sinceLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h`;
}

export function gpsChip(
  quality: GpsQuality,
  lastAccuracyM: number | null,
  lastFixAt: number | null,
  now: number,
): GpsChip {
  switch (quality) {
    case 'acquiring':
      return { kind: 'acquiring', label: 'Finding GPS…' };
    case 'lost':
      return {
        kind: 'lost',
        label: `No GPS · ${sinceLabel(lastFixAt === null ? GPS_LOST_MS : now - lastFixAt)}`,
      };
    case 'weak':
      return {
        kind: 'weak',
        label: lastAccuracyM === null ? 'Weak GPS' : `Weak GPS · ${metres(lastAccuracyM)}`,
      };
    default:
      return { kind: 'ok', label: lastAccuracyM === null ? 'GPS' : `GPS ${metres(lastAccuracyM)}` };
  }
}
