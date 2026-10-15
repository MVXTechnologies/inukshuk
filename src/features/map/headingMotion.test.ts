/**
 * The display-rate heading (owner, 2.6.0: "the compass is very staccato"):
 * one follower, advanced once per animation frame while the heading moves,
 * handed to every subscriber in lockstep — and, measured, no frames at all
 * at rest.
 */
import type { CompassSample } from './useCompass';
import {
  headingMotionStats,
  isHeadingMoving,
  setHeadingMotionScheduler,
  subscribeHeadingMotion,
  type HeadingFrame,
} from './headingMotion';

type SampleListener = (s: CompassSample) => void;
const mockSensor: { listener: SampleListener | null; subscriptions: number } = {
  listener: null,
  subscriptions: 0,
};
jest.mock('./useCompass', () => ({
  subscribeHeading: (l: SampleListener) => {
    mockSensor.listener = l;
    mockSensor.subscriptions++;
    return () => {
      mockSensor.listener = null;
    };
  },
}));

/** A hand-cranked display: `frame()` runs one animation frame, 60 Hz. */
const clock = { now: 0, pending: null as null | (() => void), requests: 0 };
function frame(): boolean {
  const cb = clock.pending;
  if (cb === null) return false;
  clock.pending = null;
  clock.now += 1000 / 60;
  cb();
  return true;
}
function sample(
  headingDeg: number,
  accuracy: number | null = 3,
  reference: 'true' | 'magnetic' = 'true',
) {
  mockSensor.listener?.({ headingDeg, accuracy, reference });
}

beforeEach(() => {
  clock.now = 0;
  clock.pending = null;
  clock.requests = 0;
  mockSensor.subscriptions = 0;
  setHeadingMotionScheduler({
    now: () => clock.now,
    request: (cb) => {
      clock.pending = cb;
      clock.requests++;
      return clock.requests;
    },
    cancel: () => {
      clock.pending = null;
    },
  });
});
afterEach(() => setHeadingMotionScheduler(null));

describe('subscribeHeadingMotion', () => {
  it('shares one sensor watch and stops it, and the frame loop, with the last subscriber', () => {
    const a = subscribeHeadingMotion(() => undefined);
    const b = subscribeHeadingMotion(() => undefined);
    expect(mockSensor.subscriptions).toBe(1);
    sample(10);
    sample(40);
    expect(isHeadingMoving()).toBe(true);
    a();
    expect(mockSensor.listener).not.toBeNull();
    b();
    expect(mockSensor.listener).toBeNull();
    expect(isHeadingMoving()).toBe(false);
    expect(clock.pending).toBeNull();
  });

  it('the first reading is drawn at once, at rest; a late subscriber gets the current frame', () => {
    const got: HeadingFrame[] = [];
    const off = subscribeHeadingMotion((f) => got.push(f));
    sample(123, 2, 'magnetic');
    expect(got).toEqual([
      { headingDeg: 123, continuousDeg: 123, accuracy: 2, reference: 'magnetic', moving: false },
    ]);
    expect(isHeadingMoving()).toBe(false);
    const late: HeadingFrame[] = [];
    const off2 = subscribeHeadingMotion((f) => late.push(f));
    expect(late).toHaveLength(1);
    off();
    off2();
  });

  it('glides between samples one frame at a time, every subscriber on the same frame, then stops', () => {
    const a: HeadingFrame[] = [];
    const b: HeadingFrame[] = [];
    const offA = subscribeHeadingMotion((f) => a.push(f));
    const offB = subscribeHeadingMotion((f) => b.push(f));
    sample(0);
    sample(30);
    let frames = 0;
    while (frame()) frames++;
    // ~0.6 s of motion, then the loop stopped by itself.
    expect(frames).toBeGreaterThan(20);
    expect(frames).toBeLessThan(60);
    expect(a).toEqual(b);
    const last = a.at(-1)!;
    expect(last).toMatchObject({ headingDeg: 30, moving: false });
    // Monotonic, no overshoot, small steps.
    for (let i = 1; i < a.length; i++) {
      const step = a[i]!.continuousDeg - a[i - 1]!.continuousDeg;
      expect(step).toBeGreaterThanOrEqual(-1e-9);
      expect(step).toBeLessThan(3);
    }
    offA();
    offB();
  });

  it('crosses north the short way: continuous 350 → 370, headings wrap to [0, 360)', () => {
    const got: HeadingFrame[] = [];
    const off = subscribeHeadingMotion((f) => got.push(f));
    sample(350);
    sample(10);
    while (frame());
    expect(got.at(-1)).toMatchObject({ headingDeg: 10, continuousDeg: 370 });
    for (const f of got) {
      expect(f.continuousDeg).toBeGreaterThanOrEqual(350 - 1e-9);
      expect(f.headingDeg).toBeGreaterThanOrEqual(0);
      expect(f.headingDeg).toBeLessThan(360);
    }
    off();
  });

  it('at rest a stream of identical readings (the filter holding still) costs no frame', () => {
    const got: HeadingFrame[] = [];
    const off = subscribeHeadingMotion((f) => got.push(f));
    sample(90);
    const framesBefore = headingMotionStats.frames;
    for (let i = 0; i < 100; i++) {
      clock.now += 120;
      sample(90);
    }
    expect(clock.pending).toBeNull();
    expect(headingMotionStats.frames).toBe(framesBefore);
    expect(got).toHaveLength(1);
    off();
  });

  it('honours each subscriber’s gate, and always hands it the resting frame', () => {
    const every: HeadingFrame[] = [];
    const gated: HeadingFrame[] = [];
    const offA = subscribeHeadingMotion((f) => every.push(f));
    const offB = subscribeHeadingMotion((f) => gated.push(f), {
      minIntervalMs: 100,
      minDeltaDeg: 1,
    });
    sample(0);
    sample(60);
    while (frame());
    const moving = gated.filter((f) => f.moving);
    expect(every.length).toBeGreaterThan(gated.length * 2);
    for (let i = 1; i < moving.length; i++) {
      expect(Math.abs(moving[i]!.headingDeg - moving[i - 1]!.headingDeg)).toBeGreaterThanOrEqual(1);
    }
    expect(gated.at(-1)).toMatchObject({ headingDeg: 60, moving: false });
    offA();
    offB();
  });

  it('a calibration change alone reaches subscribers (the cone widens), without a frame loop', () => {
    const got: HeadingFrame[] = [];
    const off = subscribeHeadingMotion((f) => got.push(f), { minDeltaDeg: 5 });
    sample(90, 3);
    sample(90, 1);
    expect(got.map((f) => f.accuracy)).toEqual([3, 1]);
    expect(clock.pending).toBeNull();
    off();
  });

  it('switching north jumps to the new one instead of gliding across the declination', () => {
    const got: HeadingFrame[] = [];
    const off = subscribeHeadingMotion((f) => got.push(f));
    sample(100, 3, 'magnetic');
    sample(85, 3, 'true');
    expect(got.at(-1)).toMatchObject({ headingDeg: 85, reference: 'true', moving: false });
    expect(clock.pending).toBeNull();
    off();
  });
});
