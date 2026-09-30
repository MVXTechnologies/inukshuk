/**
 * The tip button on the Map (#476, rounds 2–3): when it shows, how it looks
 * and when it moves. The component (`features/support/TipButton`) only
 * applies these rules.
 *
 * Guard rails (owner may change them):
 * - Map tab only, in the bottom-right corner;
 * - hidden by the "Show the tip button" setting (on by default), while a
 *   recording runs or a destination is being followed (the map is a tool
 *   then, not a place to ask for money), whenever the map says something
 *   else owns the corner, and for {@link TIP_JAR_REST_MS} (12 months) after a
 *   tip in the app or a verified "I already donated" — then it comes back;
 * - one short animation every {@link MUG_LOOP_INTERVAL_MS} (the chosen coffee
 *   scene lasts ~2.8 s, the others under a second), never when the OS asks
 *   for reduced motion or once the person has tipped, and paused while the
 *   person pans or zooms the map, while the Map tab is not in front and while
 *   the app is in the background;
 * - about once a minute the mug becomes a little character with a speech
 *   bubble and a fun fact — see {@link bubbleDue} for every guard.
 *
 * Pure: no React Native / Expo imports.
 */

export { TIP_JAR_REST_MS } from './verify';

/** The mug's loop: one short scene every 7 s (owner, round 4; was 15 s). */
export const MUG_LOOP_INTERVAL_MS = 7_000;
/** The same period for every variant (the four unused ones included). */
export const TIP_JAR_WOBBLE_INTERVAL_MS = MUG_LOOP_INTERVAL_MS;

/** The mascot bubble: at most one a minute… */
export const BUBBLE_INTERVAL_MS = 60_000;
/** …and never in the first minute after the Map opens. */
export const BUBBLE_FIRST_DELAY_MS = 60_000;
/** It folds away on its own after this long if nobody touches it. */
export const BUBBLE_VISIBLE_MS = 8_000;
/** The map must have been left alone this long since the person's last gesture. */
export const BUBBLE_IDLE_MS = 5_000;
/** The mascot face: eyes appear, blink, close into happy arcs with a smile. */
export const MASCOT_FACE_MS = 1_600;
/** How often the bubble schedule is checked (a JS timer, not a frame loop). */
export const BUBBLE_CHECK_MS = 1_000;

/**
 * The five icon + animation ideas from the owner's mockup
 * (`TipButton.dc.html`). Switching is a one-line change of
 * {@link DEFAULT_TIP_BUTTON_VARIANT}.
 */
export type TipButtonVariant =
  | 'jarCoin' // 1 · a jar with a coin, wobbles once
  | 'cairnCoin' // 2 · a gold coin drops onto three stones
  | 'stoneHeart' // 3 · a granite heart beats twice
  | 'coffeeSteam' // 4 · a mug, steam rises
  | 'inukshukHeart'; // 5 · the figure with a heart, a soft ring pulses out

export const TIP_BUTTON_VARIANTS: readonly TipButtonVariant[] = [
  'jarCoin',
  'cairnCoin',
  'stoneHeart',
  'coffeeSteam',
  'inukshukHeart',
];

/**
 * Owner pick (2026-09-30): 4 · the coffee mug. The other four stay in the
 * map, unused, so the choice stays a one-line change.
 */
export const DEFAULT_TIP_BUTTON_VARIANT: TipButtonVariant = 'coffeeSteam';

/**
 * The coffee scene (owner, round 4): two thick, soft smoke puffs swell, drift
 * up and fade; then a heart rises out of the mug and fades. ~2.8 s, then
 * rest. One linear 0→1 progress drives it all on the UI thread; the windows
 * below are fractions of it.
 */
export const COFFEE_CYCLE_MS = 2_800;
export const COFFEE_PHASES = {
  /** Each puff's [start, end] window; the second one trails the first. */
  puffs: [
    [0, 0.55],
    [0.18, 0.72],
  ] as readonly (readonly [number, number])[],
  /** The heart rises out of the mug over this window, then fades at its end. */
  heart: [0.55, 1] as const,
} as const;

/**
 * The mascot face, as fractions of {@link MASCOT_FACE_MS}: eyes fade in, blink
 * once, then close into happy arcs while a small smile appears.
 */
export const MASCOT_FACE_PHASES = {
  eyesIn: [0, 0.15] as const,
  blink: [0.3, 0.36, 0.42] as const,
  happy: [0.55, 0.65] as const,
} as const;

/**
 * Geometry of the coffee mug glyph (owner, round 4 fix), in dp inside the
 * 28 dp glyph box that the 48 dp button centres. The cup's BODY (not the
 * handle) sits on the button's vertical axis, and the smoke, the heart and
 * the mascot's eyes and smile all sit on that same axis. The handle hangs to
 * the right of it, the way a mug icon reads centred. The cup sits a little
 * low so the puffs and heart have room above the rim, inside the circle.
 */
const GLYPH_BOX = 28;
const CUP_WIDTH = 12;
const AXIS = GLYPH_BOX / 2;
export const MUG_LAYOUT = {
  button: 48,
  box: GLYPH_BOX,
  /** The cup body's vertical axis: everything else is centred on it. */
  axis: AXIS,
  cup: { left: AXIS - CUP_WIDTH / 2, right: AXIS + CUP_WIDTH / 2, top: 12.5, bottom: 22 },
  /** Bottom corner radius of the cup. */
  cupRadius: 4.5,
  /** The handle loop: from the cup's right wall out to `reach`. */
  handle: { top: 14, bottom: 18.5, reach: AXIS + CUP_WIDTH / 2 + 3.5 },
  stroke: 2,
  /**
   * Each puff is born on the axis and drifts `drift` dp out to one side as it
   * rises (the first left, the second right), so the smoke stays centred on
   * the cup even while only one puff is visible.
   */
  puff: { width: 9, height: 7, top: 4.5, left: AXIS - 4.5, drift: 2.5, wobble: 1.2 },
  heart: { width: 10, height: 9, top: 3, left: AXIS - 5 },
  /** Two oval eyes on the cup body, and the smile under them. */
  eyes: { width: 6.2, height: 3, top: 15, left: AXIS - 3.1 },
  eye: { width: 1.9, height: 3 },
  smileY: 19.4,
} as const;

/** The cup + handle path, and the mascot's happy arcs + smile, in glyph-box dp. */
export function mugPaths(): { cup: string; face: string } {
  const { cup, cupRadius: r, handle, eyes, eye, smileY, axis } = MUG_LAYOUT;
  const w = cup.right - cup.left;
  const loop = (handle.bottom - handle.top) / 2;
  const cupPath =
    `M${cup.left} ${cup.top}h${w}v${cup.bottom - cup.top - r}` +
    `a${r} ${r} 0 01-${r} ${r}h-${w - 2 * r}a${r} ${r} 0 01-${r}-${r}z` +
    `M${cup.right} ${handle.top}h${handle.reach - cup.right - loop}` +
    `a${loop} ${loop} 0 010 ${2 * loop}H${cup.right}`;
  // Happy arcs over each eye's centre, and a small smile under them.
  const arcY = eyes.top + eyes.height - 0.4;
  const lx = eyes.left + eye.width / 2 - 1;
  const rx = eyes.left + eyes.width - eye.width / 2 - 1;
  const face =
    `M${lx} ${arcY}q1-1.2 2 0M${rx} ${arcY}q1-1.2 2 0` + `M${axis - 1.6} ${smileY}q1.6 1.3 3.2 0`;
  return { cup: cupPath, face };
}

/** One step of an animation: the target value and the time to reach it (ms). */
export interface AnimStep {
  to: number;
  ms: number;
  /** Default ease-in-out; `linear` for a progress that drives a longer scene. */
  easing?: 'linear';
}

/**
 * Each variant's one animation, as keyframes on a single value (degrees for
 * rotations, a scale factor, or a 0→1 progress the component maps to a
 * position/opacity). All return to rest.
 */
export const TIP_BUTTON_MOTION: Readonly<Record<TipButtonVariant, readonly AnimStep[]>> = {
  // Rotation (°): a gentle wobble.
  jarCoin: [
    { to: 3, ms: 90 },
    { to: -3, ms: 140 },
    { to: 2, ms: 120 },
    { to: -1.5, ms: 110 },
    { to: 0, ms: 100 },
  ],
  // Progress 0→1: the coin falls in, lands, fades.
  cairnCoin: [
    { to: 0.7, ms: 260 },
    { to: 1, ms: 180 },
    { to: 1, ms: 200 },
    { to: 0, ms: 0 },
  ],
  // Scale: two beats.
  stoneHeart: [
    { to: 1.16, ms: 110 },
    { to: 0.98, ms: 110 },
    { to: 1.1, ms: 110 },
    { to: 1, ms: 150 },
  ],
  // Progress 0→1 (linear): the puffs-then-heart scene of COFFEE_PHASES.
  coffeeSteam: [
    { to: 1, ms: COFFEE_CYCLE_MS, easing: 'linear' },
    { to: 0, ms: 0 },
  ],
  // Progress 0→1: a ring pulses out and fades.
  inukshukHeart: [
    { to: 1, ms: 750 },
    { to: 0, ms: 0 },
  ],
};

export function motionDurationMs(steps: readonly AnimStep[]): number {
  return steps.reduce((sum, step) => sum + step.ms, 0);
}

export interface TipJarContext {
  /** The "Show the tip button" setting. */
  enabled: boolean;
  recording: boolean;
  /** A destination is being followed on the map. */
  navigating: boolean;
  /** The map has something in the bottom-right corner right now. */
  blocked: boolean;
  /** Epoch ms until which the button rests after a tip / verified donation (0 = never). */
  restingUntil: number;
  now: number;
}

export function tipJarVisible(ctx: TipJarContext): boolean {
  return (
    ctx.enabled && !ctx.recording && !ctx.navigating && !ctx.blocked && ctx.now >= ctx.restingUntil
  );
}

export function tipJarAnimates(opts: { reduceMotion: boolean; hasTipped: boolean }): boolean {
  return !opts.reduceMotion && !opts.hasTipped;
}

/** What decides whether the mascot bubble may appear now. */
export interface BubbleContext {
  now: number;
  /** The tip button is on screen (see {@link tipJarVisible}). */
  buttonVisible: boolean;
  /** The Map tab is in front and the app is in the foreground. */
  active: boolean;
  /** A sheet, dialog, menu or search is open over the map. */
  blocked: boolean;
  /** The person is panning or zooming right now. */
  gestureActive: boolean;
  /** When the person's last map gesture ended (null = none yet). */
  lastGestureEndAt: number | null;
  /** When the Map was opened (the button mounted). */
  mapOpenedAt: number;
  /** When the last bubble was shown (null = none yet this session). */
  lastBubbleAt: number | null;
  /** (x) was pressed: no more bubbles this session. */
  snoozed: boolean;
}

/**
 * Guard rails for the mascot bubble (coordinator's recommendation, owner can
 * loosen them): never while the button is hidden (recording, following a
 * destination, the 12-month rest after a gift, switched off), never over a
 * sheet/dialog/menu/search, never during the person's own map gestures nor
 * within {@link BUBBLE_IDLE_MS} of one, not in the first
 * {@link BUBBLE_FIRST_DELAY_MS} after the Map opens, at most one per
 * {@link BUBBLE_INTERVAL_MS}, and never again this session after (x).
 */
export function bubbleDue(ctx: BubbleContext): boolean {
  if (!ctx.buttonVisible || !ctx.active || ctx.blocked || ctx.snoozed) return false;
  if (ctx.gestureActive) return false;
  if (ctx.now - ctx.mapOpenedAt < BUBBLE_FIRST_DELAY_MS) return false;
  if (ctx.lastBubbleAt !== null && ctx.now - ctx.lastBubbleAt < BUBBLE_INTERVAL_MS) return false;
  if (ctx.lastGestureEndAt !== null && ctx.now - ctx.lastGestureEndAt < BUBBLE_IDLE_MS)
    return false;
  return true;
}
