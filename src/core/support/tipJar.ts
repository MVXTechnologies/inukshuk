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
 * - about every two minutes the mug becomes a little character with a speech
 *   bubble and a fun fact — see {@link bubbleDue} for every guard.
 *
 * Pure: no React Native / Expo imports.
 */

export { TIP_JAR_REST_MS } from './verify';

/** The mug's loop: one short scene every 12 s (owner; was 7 s, and 15 s before that). */
export const MUG_LOOP_INTERVAL_MS = 12_000;
/** The same period for every variant (the four unused ones included). */
export const TIP_JAR_WOBBLE_INTERVAL_MS = MUG_LOOP_INTERVAL_MS;
/**
 * The mug's loop runs regardless of map interaction (owner): no pause on taps,
 * pans, pinches, rotation, tilt or camera animations. Only the bubble waits
 * for the map to be still (BUBBLE_IDLE_MS).
 */

/** The mascot bubble: at most one every two minutes (owner; was one a minute)… */
export const BUBBLE_INTERVAL_MS = 120_000;
/** …and never in the first two minutes after the Map opens. */
export const BUBBLE_FIRST_DELAY_MS = 120_000;
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
 * glyph box that the 48 dp button centres. The cup's BODY (not the handle)
 * sits on the button's vertical axis, and the smoke, the heart and the
 * mascot's eyes and smile all sit on that same axis. The handle hangs to the
 * right of it, the way a mug icon reads centred. The cup sits a little low so
 * the puffs and heart have room above the rim, inside the circle.
 *
 * {@link MUG_SCALE}: the owner asked for a bigger cup (+20 %) in the same
 * 48 dp button; every size scales with it, and the smoke and heart travel a
 * little less so they still fit above the rim.
 */
export const MUG_SCALE = 1.2;
const S = MUG_SCALE;
const GLYPH_BOX = 34;
const AXIS = GLYPH_BOX / 2;
const CUP_WIDTH = 12 * S;
const CUP_TOP = 14.5;
const CUP_BOTTOM = CUP_TOP + 9.5 * S;
const PUFF = { width: 9 * S, height: 7 * S };
const HEART = { width: 10 * S, height: 9 * S };
const EYES_WIDTH = 6.2 * S;
export const MUG_LAYOUT = {
  button: 48,
  box: GLYPH_BOX,
  /** The cup body's vertical axis: everything else is centred on it. */
  axis: AXIS,
  cup: {
    left: AXIS - CUP_WIDTH / 2,
    right: AXIS + CUP_WIDTH / 2,
    top: CUP_TOP,
    bottom: CUP_BOTTOM,
  },
  /** Bottom corner radius of the cup. */
  cupRadius: 4.5 * S,
  /** The handle loop: from the cup's right wall out to `reach`. */
  handle: {
    top: CUP_TOP + 1.5 * S,
    bottom: CUP_TOP + 6 * S,
    reach: AXIS + CUP_WIDTH / 2 + 3.5 * S,
  },
  stroke: 2 * S,
  /**
   * Each puff is born on the axis, just over the rim, and rises `rise` dp
   * while it drifts `drift` dp out to one side (the first left, the second
   * right), so the smoke stays centred on the cup even while only one puff is
   * visible.
   */
  puff: {
    ...PUFF,
    top: CUP_TOP - 1 - PUFF.height,
    left: AXIS - PUFF.width / 2,
    rise: 7.5,
    drift: 2.5 * S,
    wobble: 1.2 * S,
  },
  /** The heart rises out of the cup: its offset goes from `from` to `to` dp. */
  heart: {
    ...HEART,
    top: CUP_TOP - 1 - HEART.height,
    left: AXIS - HEART.width / 2,
    from: 6,
    to: -5,
  },
  /** Two oval eyes on the cup body, and the smile under them. */
  eyes: { width: EYES_WIDTH, height: 3 * S, top: CUP_TOP + 2.5 * S, left: AXIS - EYES_WIDTH / 2 },
  eye: { width: 1.9 * S, height: 3 * S },
  smileY: CUP_TOP + 6.9 * S,
} as const;

/** Two decimals, so the SVG paths stay short and free of float noise. */
const n = (v: number) => Math.round(v * 100) / 100;

/** The cup + handle path, and the mascot's happy arcs + smile, in glyph-box dp. */
export function mugPaths(): { cup: string; face: string } {
  const { cup, handle, eyes, eye, smileY, axis } = MUG_LAYOUT;
  const r = n(MUG_LAYOUT.cupRadius);
  const w = n(cup.right - cup.left);
  const loop = n((handle.bottom - handle.top) / 2);
  const cupPath =
    `M${n(cup.left)} ${n(cup.top)}h${w}v${n(cup.bottom - cup.top - r)}` +
    `a${r} ${r} 0 01-${r} ${r}h-${n(w - 2 * r)}a${r} ${r} 0 01-${r}-${r}z` +
    `M${n(cup.right)} ${n(handle.top)}h${n(handle.reach - cup.right - loop)}` +
    `a${loop} ${loop} 0 010 ${n(2 * loop)}H${n(cup.right)}`;
  // Happy arcs over each eye's centre, and a small smile under them.
  const arcY = n(eyes.top + eyes.height - 0.4 * S);
  const arc = `q${n(S)}-${n(1.2 * S)} ${n(2 * S)} 0`;
  const lx = n(eyes.left + eye.width / 2 - S);
  const rx = n(eyes.left + eyes.width - eye.width / 2 - S);
  const face =
    `M${lx} ${arcY}${arc}M${rx} ${arcY}${arc}` +
    `M${n(axis - 1.6 * S)} ${n(smileY)}q${n(1.6 * S)} ${n(1.3 * S)} ${n(3.2 * S)} 0`;
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
  /** Epoch ms until which the button is hidden by long-press › "Hide for an hour" (0 = not). */
  hiddenUntil?: number;
  now: number;
}

export function tipJarVisible(ctx: TipJarContext): boolean {
  return (
    ctx.enabled &&
    !ctx.recording &&
    !ctx.navigating &&
    !ctx.blocked &&
    ctx.now >= ctx.restingUntil &&
    ctx.now >= (ctx.hiddenUntil ?? 0)
  );
}

/**
 * Long-press › "Hide for an hour" (owner): the button comes back this long
 * after it was hidden, by the wall clock — whether or not the app was open.
 * Separate from the Settings switch (off until switched back on) and from the
 * 12-month rest after a gift ({@link TIP_JAR_REST_MS}).
 */
export const TIP_JAR_HIDE_MS = 60 * 60 * 1000;

/** While hidden for the hour, the Map re-checks the clock this often (and on foreground). */
export const TIP_JAR_HIDE_RECHECK_MS = 60 * 1000;

/** The `tipJarHiddenUntil` to store when the person hides the button at `now`. */
export function tipJarHideUntil(now: number): number {
  return now + TIP_JAR_HIDE_MS;
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
