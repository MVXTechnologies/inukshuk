import { normalizeDeg, signedDeltaDeg } from '@core/signal/heading';
import { createHeadingFollower } from '@core/signal/headingMotion';
import { subscribeHeading, type CompassSample } from './useCompass';

/** One display frame of the heading, delivered to motion subscribers. */
export interface HeadingFrame {
  /** Display heading, degrees clockwise from north, [0, 360). */
  headingDeg: number;
  /**
   * The same heading on a continuous (unwrapped) scale: a turn through north
   * goes 359 → 361, never back to 1. What an animated rotation needs.
   */
  continuousDeg: number;
  /** The sensor's calibration (0 worst … 3 best) of the latest sample, or null. */
  accuracy: number | null;
  /** Which north the heading is from (see `CompassSample`). */
  reference: CompassSample['reference'];
  /** False on the frame the motion comes to rest (the last one until the next turn). */
  moving: boolean;
}

export interface MotionGate {
  /** At most one frame per this many ms (0 = every display frame). */
  minIntervalMs?: number;
  /** Skip frames that moved less than this from the last delivered one, °. */
  minDeltaDeg?: number;
}

type FrameListener = (frame: HeadingFrame) => void;

interface Subscriber {
  listener: FrameListener;
  minIntervalMs: number;
  minDeltaDeg: number;
  /** What it was last handed, and when. */
  sentDeg: number | null;
  sentAt: number;
  sentAccuracy: number | null | undefined;
}

// ---------------------------------------------------------------------------
// The heading, animated at display rate (owner, 2.6.0: "the compass is very
// staccato… it should be buttery smooth").
//
// `useCompass` filters the sensor stream, but that stream arrives at only
// ~5–10 Hz on Android (a reading is forwarded once it moved ≥ 2°), and on iOS
// in 1° steps: drawn as it lands, every turn is a staircase of 6–25° jumps
// with the picture frozen ~88 % of the frames in between. Here ONE follower
// (@core/signal/headingMotion: critically damped, with a lead that cancels
// its lag on a steady turn) is advanced once per animation frame, and every
// heading consumer — the camera in heading-up, the direction cone, the
// pointing line, the navigation tape, the compass badge — draws the same
// frame, in lockstep.
//
// Cost: the frame loop runs only while the heading is moving; a phone at rest
// costs no frames at all (the follower settles exactly on the target, and a
// resting stream does not wake it). Subscribers can gate their own rate (a
// GeoJSON rebuild need not run at 120 Hz). Nothing here touches React state:
// each subscriber decides what, if anything, to render.
// ---------------------------------------------------------------------------

const subscribers = new Set<Subscriber>();
const follower = createHeadingFollower();
let unsubscribeSensor: (() => void) | null = null;
let frameHandle: number | null = null;
let lastSample: CompassSample | null = null;
let latest: HeadingFrame | null = null;

/** The frame clock and scheduler; swappable so tests can step frames by hand. */
interface FrameScheduler {
  now(): number;
  request(cb: () => void): number;
  cancel(handle: number): void;
}

/** ~60 Hz, where there is no display to sync to (headless tests). */
const FALLBACK_FRAME_MS = 16;
const hasRaf = typeof requestAnimationFrame === 'function';
const systemScheduler: FrameScheduler = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  request: (cb) =>
    hasRaf ? requestAnimationFrame(cb) : (setTimeout(cb, FALLBACK_FRAME_MS) as unknown as number),
  cancel: (handle) => (hasRaf ? cancelAnimationFrame(handle) : clearTimeout(handle)),
};
let scheduler: FrameScheduler = systemScheduler;

/** Counters for tests and perf checks: frames computed since the last reset. */
export const headingMotionStats = { frames: 0, samples: 0 };

/** Test hook: drive the frame loop by hand. Pass null to restore the system clock. */
export function setHeadingMotionScheduler(next: FrameScheduler | null): void {
  if (frameHandle !== null) scheduler.cancel(frameHandle);
  frameHandle = null;
  scheduler = next ?? systemScheduler;
}

function deliver(frame: HeadingFrame, now: number): void {
  latest = frame;
  for (const s of subscribers) {
    const due =
      s.sentDeg === null ||
      !frame.moving ||
      s.sentAccuracy !== frame.accuracy ||
      (now - s.sentAt >= s.minIntervalMs &&
        Math.abs(signedDeltaDeg(s.sentDeg, frame.headingDeg)) >= s.minDeltaDeg);
    if (!due) continue;
    // The resting frame is always delivered (the last position of a turn is
    // never lost), but only once.
    if (!frame.moving && s.sentDeg === frame.headingDeg && s.sentAccuracy === frame.accuracy) {
      continue;
    }
    s.sentDeg = frame.headingDeg;
    s.sentAt = now;
    s.sentAccuracy = frame.accuracy;
    s.listener(frame);
  }
}

function frameOf(continuousDeg: number, moving: boolean): HeadingFrame | null {
  if (lastSample === null || !Number.isFinite(continuousDeg)) return null;
  return {
    headingDeg: normalizeDeg(continuousDeg),
    continuousDeg,
    accuracy: lastSample.accuracy,
    reference: lastSample.reference,
    moving,
  };
}

function tick(): void {
  frameHandle = null;
  const now = scheduler.now();
  headingMotionStats.frames++;
  const x = follower.advance(now);
  const moving = !follower.isSettled();
  const frame = frameOf(x, moving);
  if (frame) deliver(frame, now);
  if (moving) frameHandle = scheduler.request(tick);
}

function onSample(sample: CompassSample): void {
  headingMotionStats.samples++;
  const now = scheduler.now();
  // Another north is another scale: jump to it rather than glide across the declination.
  if (lastSample !== null && lastSample.reference !== sample.reference) follower.reset();
  lastSample = sample;
  const first = follower.value() === null;
  follower.setTarget(sample.headingDeg, now);
  if (first) {
    const frame = frameOf(follower.advance(now), false);
    if (frame) deliver(frame, now);
    return;
  }
  if (!follower.isSettled()) {
    if (frameHandle === null) frameHandle = scheduler.request(tick);
  } else if (latest !== null && latest.accuracy !== sample.accuracy) {
    // A calibration change alone (the cone's width) still reaches subscribers.
    const frame = frameOf(follower.advance(now), false);
    if (frame) deliver(frame, now);
  }
}

function stop(): void {
  unsubscribeSensor?.();
  unsubscribeSensor = null;
  if (frameHandle !== null) scheduler.cancel(frameHandle);
  frameHandle = null;
  follower.reset();
  lastSample = null;
  latest = null;
}

/**
 * Subscribe to the display-rate heading. The listener gets the current frame
 * at once (if any), then one per animation frame while the heading moves —
 * thinned by `gate` — and always the frame it comes to rest on. Returns an
 * unsubscribe function; the sensor watch (shared, `subscribeHeading`) stops
 * when the last subscriber leaves.
 *
 * Like `subscribeHeading`, this expects location permission to already be
 * granted; on a phone without a magnetometer the listener simply never fires.
 */
export function subscribeHeadingMotion(listener: FrameListener, gate: MotionGate = {}): () => void {
  const s: Subscriber = {
    listener,
    minIntervalMs: gate.minIntervalMs ?? 0,
    minDeltaDeg: gate.minDeltaDeg ?? 0,
    sentDeg: null,
    sentAt: -Infinity,
    sentAccuracy: undefined,
  };
  subscribers.add(s);
  if (latest !== null) {
    s.sentDeg = latest.headingDeg;
    s.sentAt = scheduler.now();
    s.sentAccuracy = latest.accuracy;
    listener(latest);
  }
  if (unsubscribeSensor === null) unsubscribeSensor = subscribeHeading(onSample);
  return () => {
    subscribers.delete(s);
    if (subscribers.size === 0) stop();
  };
}

/** True while the heading is animating (the frame loop is running). */
export function isHeadingMoving(): boolean {
  return frameHandle !== null;
}
