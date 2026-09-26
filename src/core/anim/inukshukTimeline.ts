/**
 * Choreography of the Inukshuk loader: five stones drop into place, puff
 * dust on landing, hold, fade, loop. Pure data + samplers; the React Native
 * component (`src/ui/components/InukshukLoader.tsx`) only maps these onto
 * Reanimated styles.
 *
 * Source of truth: the approved "Loader" design-canvas board (its CSS
 * @keyframes), transcribed 1:1 — percentages of the 3.4 s loop converted to
 * ms. Distances are CSS px at a 240 px tall figure (`REF_HEIGHT`); scale them
 * by `height / REF_HEIGHT`.
 */
import { EASE, type Bezier, type Keyframe, type Track } from './keyframes';

export const REF_HEIGHT = 240;
/** One loop, ms. */
export const CYCLE_MS = 3400;
/** A drop: 400 ms fall + 240 ms landing (squash, rebound, settle). */
export const FALL_MS = 400;
export const STAGGER_MS = 280;
/** Every stone has settled. */
export const SETTLED_MS = 1760;
export const FADE_START_MS = 2960;
export const FADE_END_MS = 3260;
/** Stones enter this far above their rest position (ref px). */
export const DROP_PX = 260;
/** How long one dust puff is visible after its landing. */
export const DUST_MS = 400;

// Easings named as in the design spec.
export const FALL: Bezier = [0.55, 0, 1, 0.45]; // gravity
export const REBOUND: Bezier = [0.34, 1.56, 0.64, 1];
export const SETTLE: Bezier = [0.22, 1, 0.36, 1];
export const BURST: Bezier = [0.2, 0.8, 0.3, 1];

export type StoneId = 'leg-left' | 'leg-right' | 'torso' | 'arm' | 'head';
/** Draw / drop order, back to front: each stone rests on the ones before it. */
export const STONE_ORDER: readonly StoneId[] = ['leg-left', 'leg-right', 'torso', 'arm', 'head'];

/** Channels of a stone track. */
export const TX = 0;
export const TY = 1;
export const ROT = 2; // degrees
export const SX = 3;
export const SY = 4;
export const OP = 5;

interface StoneMotion {
  /** Entry drift (ref px) and tilt (deg); both reach 0 exactly at contact. */
  drift: number;
  tilt: number;
  /** scaleX/scaleY at contact (squash). */
  squash: readonly [number, number];
  /** 120 ms after contact: small hop (ref px, negative = up) and stretch. */
  hop: number;
  stretch: readonly [number, number];
  /** 200 ms after contact, easing back to 1, 1 by 240 ms. */
  settle: readonly [number, number];
}

const MOTION: Record<StoneId, StoneMotion> = {
  'leg-left': {
    drift: -20,
    tilt: -10,
    squash: [1.08, 0.88],
    hop: -5,
    stretch: [0.97, 1.05],
    settle: [1.02, 0.98],
  },
  'leg-right': {
    drift: 22,
    tilt: 12,
    squash: [1.08, 0.88],
    hop: -5,
    stretch: [0.97, 1.05],
    settle: [1.02, 0.98],
  },
  torso: {
    drift: -18,
    tilt: -12,
    squash: [1.12, 0.84],
    hop: -5,
    stretch: [0.96, 1.06],
    settle: [1.03, 0.97],
  },
  arm: {
    drift: 24,
    tilt: 10,
    squash: [1.08, 0.8],
    hop: -5,
    stretch: [0.97, 1.08],
    settle: [1.02, 0.97],
  },
  head: {
    drift: -14,
    tilt: -14,
    squash: [1.14, 0.82],
    hop: -6,
    stretch: [0.95, 1.08],
    settle: [1.03, 0.97],
  },
};

/** When stone `id` starts falling / touches down, ms into the loop. */
export function dropStart(id: StoneId): number {
  return STONE_ORDER.indexOf(id) * STAGGER_MS;
}
export function landingAt(id: StoneId): number {
  return dropStart(id) + FALL_MS;
}

function stoneTrack(id: StoneId): Track {
  const m = MOTION[id];
  const start = dropStart(id);
  const land = start + FALL_MS;
  const at = (t: number, v: readonly number[], ease: Keyframe['ease']): Keyframe => ({
    t,
    v,
    ease,
  });
  const top = (op: number) => [m.drift, -DROP_PX, m.tilt, 1, 1, op];
  const rest = (op: number) => [0, 0, 0, 1, 1, op];
  const entry: Keyframe[] =
    start === 0
      ? // The first stone fades in over its first 51 ms (1.5 % of the loop)
        // while it starts to fall, so the loop restart never pops.
        [at(0, top(0), EASE), at(51, [m.drift * 0.95, -DROP_PX + 10, m.tilt, 1, 1, 1], FALL)]
      : // The others are hidden until their turn, then fall from the top.
        [at(0, top(0), 'step'), at(start, top(1), FALL)];
  return [
    ...entry,
    at(land, [0, 0, 0, m.squash[0], m.squash[1], 1], REBOUND),
    at(land + 120, [0, m.hop, 0, m.stretch[0], m.stretch[1], 1], FALL),
    at(land + 200, [0, 0, 0, m.settle[0], m.settle[1], 1], SETTLE),
    at(land + 240, rest(1), 'step'),
    at(FADE_START_MS, rest(1), EASE),
    at(FADE_END_MS, rest(0), 'step'),
    at(CYCLE_MS, rest(0), 'step'),
  ];
}

export const STONE_TRACKS: Readonly<Record<StoneId, Track>> = {
  'leg-left': stoneTrack('leg-left'),
  'leg-right': stoneTrack('leg-right'),
  torso: stoneTrack('torso'),
  arm: stoneTrack('arm'),
  head: stoneTrack('head'),
};

// ---------------------------------------------------------------------------
// Dust: 5 specks per landing, 3 from the left end of the contact line and 2
// from the right, puffing sideways/up and fading within 400 ms.

export const DUST_GRANITE = '#5F6B76';
export const DUST_PAPER = '#A89E8C';

export interface Speck {
  side: 'left' | 'right';
  /** Size (ref px) and nudge from the contact point (ref px). */
  w: number;
  h: number;
  dx: number;
  dy: number;
  color: string;
  /** Motion track, channels [x, y, scale] (ref px), local ms since landing. */
  motion: Track;
}

/** Opacity of any speck, local ms since its landing. */
export const SPECK_OPACITY: Track = [
  { t: 0, v: [0], ease: BURST },
  { t: 17, v: [0.6], ease: EASE },
  { t: 200, v: [0.55], ease: FALL },
  { t: DUST_MS, v: [0], ease: 'step' },
];

function speckMotion(mid: readonly [number, number], end: readonly [number, number]): Track {
  return [
    { t: 0, v: [0, 0, 0.5], ease: BURST },
    { t: 200, v: [mid[0], mid[1], 1], ease: FALL },
    { t: DUST_MS, v: [end[0], end[1], 0.8], ease: 'step' },
  ];
}

export const SPECKS: readonly Speck[] = [
  {
    side: 'left',
    w: 5,
    h: 3,
    dx: 0,
    dy: 0,
    color: DUST_GRANITE,
    motion: speckMotion([-17, -8], [-21, -4]),
  },
  {
    side: 'left',
    w: 4,
    h: 4,
    dx: 3,
    dy: -1,
    color: DUST_PAPER,
    motion: speckMotion([-10, -13], [-12, -9]),
  },
  {
    side: 'left',
    w: 3,
    h: 3,
    dx: -2,
    dy: 1,
    color: DUST_GRANITE,
    motion: speckMotion([-23, -3], [-29, 1]),
  },
  {
    side: 'right',
    w: 5,
    h: 3,
    dx: 0,
    dy: 0,
    color: DUST_PAPER,
    motion: speckMotion([17, -8], [21, -4]),
  },
  {
    side: 'right',
    w: 4,
    h: 4,
    dx: -3,
    dy: -1,
    color: DUST_GRANITE,
    motion: speckMotion([11, -13], [14, -9]),
  },
];

/** Local time since a landing at `landing`, wrapped into the loop. */
export function sinceLanding(t: number, landing: number): number {
  'worklet';
  const d = (t - landing) % CYCLE_MS;
  return d < 0 ? d + CYCLE_MS : d;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Contact line of each landing, in figure-frame units: the ground for the
 * legs, the top of the supporting stone for the rest. The arm puffs where it
 * meets the torso's ends, not at its own tips out in the air.
 */
export function contactLine(
  id: StoneId,
  rects: Readonly<Record<StoneId, Rect>>,
): { left: number; right: number; y: number } {
  const r = rects[id];
  const span = id === 'arm' ? rects.torso : r;
  return { left: span.x, right: span.x + span.w, y: r.y + r.h };
}

/**
 * Where the loop can stop when it plays once: every stone settled and the
 * last puff of dust gone, before the fade.
 */
export const PLAY_ONCE_END_MS = Math.max(SETTLED_MS, landingAt('head') + DUST_MS);
