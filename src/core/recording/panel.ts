/**
 * The recording panel's size states and its hero fields (revamp decision 3,
 * board `Recording-States.html`). Pure: the panel component feeds it chevron
 * taps and swipes and renders what comes back.
 *
 * Changing size never touches the recording itself — these are view states.
 */

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
 * no other slot already shows. Returns a new tuple; a slot out of range
 * returns the fields unchanged.
 */
export function cycleHeroField(fields: readonly HeroField[], slot: number): HeroField[] {
  const current = fields[slot];
  if (current === undefined) return [...fields];
  const taken = new Set(fields.filter((_, i) => i !== slot));
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
