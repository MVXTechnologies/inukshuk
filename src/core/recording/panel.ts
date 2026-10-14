/**
 * The recording panel's size states and its hero fields (revamp decision 3,
 * board `Recording-States.html`). Pure: the panel component feeds it chevron
 * taps and swipes and renders what comes back.
 *
 * Changing size never touches the recording itself — these are view states.
 */
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatElevationChange,
  formatPace,
  formatSpeed,
  type Units,
} from '@core/format';
import { msUntilSunset } from '@core/sun/sunTimes';

/**
 * - `mini`: A, a small overlay pill (map first);
 * - `strip`: B, status row + three hero fields + controls (the default);
 * - `expanded`: C, the strip plus six more fields and the elevation so far.
 */
export type PanelState = 'mini' | 'strip' | 'expanded';

/** The state a new recording opens in. */
export const INITIAL_PANEL_STATE: PanelState = 'strip';

/** One step larger (tap the mini pill, the "More" chevron, or swipe up). */
export function expandPanel(state: PanelState): PanelState {
  return state === 'mini' ? 'strip' : 'expanded';
}

/** One step smaller (the minimize/"Less" chevron, or swipe down). */
export function collapsePanel(state: PanelState): PanelState {
  return state === 'expanded' ? 'strip' : 'mini';
}

/** Vertical drag (dp, down positive) and its release velocity (dp/s). */
export interface SwipeInput {
  dy: number;
  vy: number;
}

/** A drag must travel this far, or flick this fast, to change state. */
export const SWIPE_DISTANCE_DP = 40;
export const SWIPE_VELOCITY_DPS = 500;

/**
 * The state after a released vertical swipe: up expands, down collapses,
 * anything short of the distance/velocity thresholds snaps back.
 */
export function panelAfterSwipe(state: PanelState, { dy, vy }: SwipeInput): PanelState {
  const up = dy <= -SWIPE_DISTANCE_DP || vy <= -SWIPE_VELOCITY_DPS;
  const down = dy >= SWIPE_DISTANCE_DP || vy >= SWIPE_VELOCITY_DPS;
  if (up && !down) return expandPanel(state);
  if (down && !up) return collapsePanel(state);
  return state;
}

/** Every value the panel can show in a hero slot (and in the expanded grid). */
export type HeroField =
  'time' | 'distance' | 'gain' | 'speed' | 'pace' | 'altitude' | 'descent' | 'moving' | 'sunset';

/** Cycle order when a hero field is tapped. */
export const HERO_FIELD_ORDER: readonly HeroField[] = [
  'time',
  'distance',
  'gain',
  'speed',
  'pace',
  'altitude',
  'descent',
  'moving',
  'sunset',
];

/** The three hero slots when recording starts: Time · Distance · Gain. */
export const DEFAULT_HERO_FIELDS: readonly [HeroField, HeroField, HeroField] = [
  'time',
  'distance',
  'gain',
];

/** The expanded state's extra grid (board order), after the hero row. */
export const EXPANDED_FIELDS: readonly HeroField[] = [
  'speed',
  'pace',
  'altitude',
  'descent',
  'moving',
  'sunset',
];

/**
 * Tap a hero slot: it shows the next field in {@link HERO_FIELD_ORDER} that
 * no other slot already shows, and none of `skip` (2.6.0: the metrics the
 * info strip already shows, so every metric has one owner). Returns a new
 * tuple; a slot out of range, or nothing left to show, returns the fields
 * unchanged.
 */
export function cycleHeroField(
  fields: readonly HeroField[],
  slot: number,
  skip: ReadonlySet<HeroField> = new Set(),
): HeroField[] {
  const current = fields[slot];
  if (current === undefined) return [...fields];
  const taken = new Set([...fields.filter((_, i) => i !== slot), ...skip]);
  const start = HERO_FIELD_ORDER.indexOf(current);
  for (let step = 1; step <= HERO_FIELD_ORDER.length; step++) {
    const next = HERO_FIELD_ORDER[(start + step) % HERO_FIELD_ORDER.length]!;
    if (!taken.has(next)) {
      const out = [...fields];
      out[slot] = next;
      return out;
    }
  }
  return [...fields];
}

/** Each hero field's caption, as the panel prints it (upper case). */
export const HERO_FIELD_LABEL: Record<HeroField, string> = {
  time: 'TIME',
  distance: 'DISTANCE',
  gain: 'GAIN',
  speed: 'SPEED',
  pace: 'PACE',
  altitude: 'ALTITUDE',
  descent: 'DESCENT',
  moving: 'MOVING',
  sunset: 'TO SUNSET',
};

/** What the hero fields are computed from: the recorder's live numbers. */
export interface HeroData {
  /** Recording time so far (pauses excluded), seconds. */
  elapsedS: number;
  distanceM: number;
  ascentM: number;
  descentM: number;
  movingTimeS: number;
  avgSpeedMps: number;
  liveSpeedMps: number;
  /** The last fix's altitude, or null when it has none. */
  altitudeM: number | null;
  /** The last fix, for the sunset countdown; null before the first one. */
  position: { latitude: number; longitude: number } | null;
  nowMs: number;
}

/**
 * A hero field's text, in the user's units ("1:12:40", "8.42 km", "+412 m",
 * "—"): one formatter for the recording panel and the info strip, so the two
 * can never disagree about the same metric.
 */
export function heroFieldText(field: HeroField, d: HeroData, units: Units): string {
  switch (field) {
    case 'time':
      return formatDuration(d.elapsedS);
    case 'distance':
      return formatDistance(d.distanceM, units);
    case 'gain':
      return formatElevationChange(d.ascentM, 'up', units);
    case 'speed':
      return formatSpeed(d.liveSpeedMps, units);
    case 'pace':
      return d.avgSpeedMps > 0 ? formatPace(d.avgSpeedMps, units) : '—';
    case 'altitude':
      return d.altitudeM === null ? '—' : formatElevation(d.altitudeM, units);
    case 'descent':
      return formatElevationChange(d.descentM, 'down', units);
    case 'moving':
      return formatDuration(d.movingTimeS);
    case 'sunset': {
      const left =
        d.position === null
          ? null
          : msUntilSunset(d.nowMs, d.position.latitude, d.position.longitude);
      return left === null ? '—' : formatDuration(Math.round(left / 1000));
    }
  }
}
