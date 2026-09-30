import {
  BUBBLE_CHECK_MS,
  BUBBLE_FIRST_DELAY_MS,
  BUBBLE_IDLE_MS,
  BUBBLE_INTERVAL_MS,
  BUBBLE_VISIBLE_MS,
  bubbleDue,
  COFFEE_CYCLE_MS,
  COFFEE_PHASES,
  DEFAULT_TIP_BUTTON_VARIANT,
  MASCOT_FACE_MS,
  MASCOT_FACE_PHASES,
  motionDurationMs,
  MUG_LAYOUT,
  MUG_LOOP_INTERVAL_MS,
  mugPaths,
  TIP_BUTTON_MOTION,
  TIP_BUTTON_VARIANTS,
  TIP_JAR_REST_MS,
  TIP_JAR_WOBBLE_INTERVAL_MS,
  tipJarAnimates,
  tipJarVisible,
  type BubbleContext,
} from './tipJar';

describe('timings (named, owner-tunable)', () => {
  it('loops the mug every 7 s and offers a bubble at most once a minute', () => {
    expect(MUG_LOOP_INTERVAL_MS).toBe(7_000);
    expect(TIP_JAR_WOBBLE_INTERVAL_MS).toBe(MUG_LOOP_INTERVAL_MS);
    expect(BUBBLE_INTERVAL_MS).toBe(60_000);
    expect(BUBBLE_FIRST_DELAY_MS).toBe(60_000);
    expect(BUBBLE_VISIBLE_MS).toBe(8_000);
    expect(BUBBLE_IDLE_MS).toBe(5_000);
    expect(BUBBLE_CHECK_MS).toBeLessThanOrEqual(BUBBLE_IDLE_MS);
  });

  it('keeps the mascot face short and in order', () => {
    expect(MASCOT_FACE_MS).toBeLessThan(BUBBLE_VISIBLE_MS);
    const { eyesIn, blink, happy } = MASCOT_FACE_PHASES;
    expect(eyesIn[1]).toBeLessThan(blink[0]);
    expect(blink[2]).toBeLessThan(happy[0]);
    expect(happy[1]).toBeLessThanOrEqual(1);
  });
});

describe('mug layout (centred composition)', () => {
  const L = MUG_LAYOUT;
  // The glyph box is centred in the button, so button centre = box centre.
  const toButton = (x: number) => (L.button - L.box) / 2 + x;
  const buttonCentre = L.button / 2;

  it('puts the cup body’s axis on the button centre (±0.5 dp)', () => {
    const cupAxis = (L.cup.left + L.cup.right) / 2;
    expect(cupAxis).toBe(L.axis);
    expect(Math.abs(toButton(cupAxis) - buttonCentre)).toBeLessThanOrEqual(0.5);
  });

  it('centres the smoke, the heart and the face on the cup axis', () => {
    // Each puff is born on the axis; they drift out by the same amount, one
    // to each side, so the pair stays symmetric about it.
    expect(L.puff.left + L.puff.width / 2).toBeCloseTo(L.axis, 5);
    expect(L.heart.left + L.heart.width / 2).toBeCloseTo(L.axis, 5);
    expect(L.eyes.left + L.eyes.width / 2).toBeCloseTo(L.axis, 5);
  });

  it('keeps the smoke and heart above the rim and inside the circle', () => {
    const r = L.button / 2;
    const off = (L.button - L.box) / 2;
    // Highest point of a puff: it rises 11 dp and swells to 1.3×.
    const puffTop = off + L.puff.top - 11 - (L.puff.height * 0.3) / 2;
    const heartTop = off + L.heart.top - 7;
    for (const top of [puffTop, heartTop]) {
      // A point on the axis is inside the circle when it is below y = 0.
      expect(top).toBeGreaterThan(0);
      expect(top).toBeLessThan(off + L.cup.top);
    }
    // The widest puff at its peak still sits inside the circle.
    const halfW = (L.puff.width * 1.3) / 2 + L.puff.drift + L.puff.wobble;
    const dy = r - puffTop;
    expect(Math.hypot(halfW, dy)).toBeLessThan(r);
  });

  it('draws the cup, handle and face from those numbers', () => {
    const { cup, face } = mugPaths();
    expect(cup.startsWith(`M${L.cup.left} ${L.cup.top}`)).toBe(true);
    expect(cup).toContain(`M${L.cup.right} ${L.handle.top}`);
    expect(face).toContain(`M${L.axis - 1.6} ${L.smileY}`);
  });
});

describe('tip button variants', () => {
  it('offers the five mockup ideas; the owner picked the coffee mug', () => {
    expect(TIP_BUTTON_VARIANTS).toHaveLength(5);
    expect(DEFAULT_TIP_BUTTON_VARIANT).toBe('coffeeSteam');
  });

  it('runs the coffee scene in ~2.5–3 s: two puffs, then the heart', () => {
    expect(motionDurationMs(TIP_BUTTON_MOTION.coffeeSteam)).toBe(COFFEE_CYCLE_MS);
    expect(COFFEE_CYCLE_MS).toBeGreaterThanOrEqual(2_500);
    expect(COFFEE_CYCLE_MS).toBeLessThanOrEqual(3_000);
    expect(COFFEE_PHASES.puffs).toHaveLength(2);
    const [first, second] = COFFEE_PHASES.puffs;
    expect(second?.[0]).toBeGreaterThan(first?.[0] ?? 0);
    // The heart comes out once the first puff is gone, and ends the scene.
    expect(COFFEE_PHASES.heart[0]).toBeGreaterThanOrEqual(first?.[1] ?? 1);
    expect(COFFEE_PHASES.heart[1]).toBe(1);
    // The scene fits well inside the 7 s loop, with a rest after it.
    expect(COFFEE_CYCLE_MS).toBeLessThan(MUG_LOOP_INTERVAL_MS);
  });

  it.each(TIP_BUTTON_VARIANTS)('%s comes back to rest', (v) => {
    const steps = TIP_BUTTON_MOTION[v];
    if (v !== 'coffeeSteam') expect(motionDurationMs(steps)).toBeLessThan(1000);
    const last = steps[steps.length - 1]?.to;
    expect(last === 0 || last === 1).toBe(true);
  });

  it('keeps the rotations gentle (at most 3°)', () => {
    for (const s of TIP_BUTTON_MOTION.jarCoin) expect(Math.abs(s.to)).toBeLessThanOrEqual(3);
  });

  it('never animates with reduced motion or after a tip', () => {
    expect(tipJarAnimates({ reduceMotion: false, hasTipped: false })).toBe(true);
    expect(tipJarAnimates({ reduceMotion: true, hasTipped: false })).toBe(false);
    expect(tipJarAnimates({ reduceMotion: false, hasTipped: true })).toBe(false);
  });
});

describe('tipJarVisible', () => {
  const NOW = 10 * TIP_JAR_REST_MS;
  const base = {
    enabled: true,
    recording: false,
    navigating: false,
    blocked: false,
    restingUntil: 0,
    now: NOW,
  };

  it('shows by default', () => {
    expect(tipJarVisible(base)).toBe(true);
  });

  it.each([
    ['switched off', { enabled: false }],
    ['recording', { recording: true }],
    ['following a destination', { navigating: true }],
    ['the corner is taken', { blocked: true }],
    ['resting after a tip or a verified donation', { restingUntil: NOW + 1 }],
  ])('hides when %s', (_label, patch) => {
    expect(tipJarVisible({ ...base, ...patch })).toBe(false);
  });

  it('comes back once the 12 months are over', () => {
    expect(tipJarVisible({ ...base, restingUntil: NOW })).toBe(true);
  });
});

describe('bubbleDue guards', () => {
  const T0 = 1_000_000;
  const ready: BubbleContext = {
    now: T0 + BUBBLE_FIRST_DELAY_MS,
    buttonVisible: true,
    active: true,
    blocked: false,
    gestureActive: false,
    lastGestureEndAt: null,
    mapOpenedAt: T0,
    lastBubbleAt: null,
    snoozed: false,
  };

  it('offers the first bubble one minute after the Map opens, not sooner', () => {
    expect(bubbleDue(ready)).toBe(true);
    expect(bubbleDue({ ...ready, now: T0 + BUBBLE_FIRST_DELAY_MS - 1 })).toBe(false);
  });

  it.each([
    [
      'the button is hidden (recording, following, resting, switched off)',
      { buttonVisible: false },
    ],
    ['the Map is not in front or the app is backgrounded', { active: false }],
    ['a sheet, dialog, menu or search is open', { blocked: true }],
    ['the person is panning or zooming', { gestureActive: true }],
    ['(x) snoozed it for the session', { snoozed: true }],
  ])('stays away while %s', (_label, patch) => {
    expect(bubbleDue({ ...ready, ...patch })).toBe(false);
  });

  it('waits for 5 s of calm after the person’s last gesture', () => {
    const now = ready.now;
    expect(bubbleDue({ ...ready, lastGestureEndAt: now - BUBBLE_IDLE_MS + 1 })).toBe(false);
    expect(bubbleDue({ ...ready, lastGestureEndAt: now - BUBBLE_IDLE_MS })).toBe(true);
  });

  it('shows at most one bubble a minute', () => {
    const now = ready.now + 10 * BUBBLE_INTERVAL_MS;
    expect(bubbleDue({ ...ready, now, lastBubbleAt: now - BUBBLE_INTERVAL_MS + 1 })).toBe(false);
    expect(bubbleDue({ ...ready, now, lastBubbleAt: now - BUBBLE_INTERVAL_MS })).toBe(true);
  });
});

describe('bubble schedule over time (fake timers)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * The component's loop, reduced to its logic: a check every
   * BUBBLE_CHECK_MS that shows a bubble when due and hides it after
   * BUBBLE_VISIBLE_MS. Returns the times (s after opening) bubbles appeared.
   */
  function run(
    minutes: number,
    events: { at: number; do: (s: BubbleContext) => Partial<BubbleContext> }[] = [],
  ): number[] {
    const opened = Date.now();
    const state: BubbleContext = {
      now: opened,
      buttonVisible: true,
      active: true,
      blocked: false,
      gestureActive: false,
      lastGestureEndAt: null,
      mapOpenedAt: opened,
      lastBubbleAt: null,
      snoozed: false,
    };
    const shown: number[] = [];
    const timer = setInterval(() => {
      state.now = Date.now();
      const elapsed = Math.round((state.now - opened) / 1000);
      for (const e of events) if (e.at === elapsed) Object.assign(state, e.do(state));
      if (bubbleDue(state)) {
        state.lastBubbleAt = state.now;
        shown.push(elapsed);
      }
    }, BUBBLE_CHECK_MS);
    jest.advanceTimersByTime(minutes * 60_000);
    clearInterval(timer);
    return shown;
  }

  it('shows the first bubble at 1 min, then one per minute', () => {
    expect(run(4)).toEqual([60, 120, 180, 240]);
  });

  it('never shows one during a recording, and resumes after', () => {
    const shown = run(4, [
      { at: 30, do: () => ({ buttonVisible: false }) },
      { at: 150, do: () => ({ buttonVisible: true }) },
    ]);
    expect(shown).toEqual([150, 210]);
  });

  it('holds off while the person moves the map, and for 5 s after', () => {
    const shown = run(2, [
      { at: 55, do: () => ({ gestureActive: true }) },
      { at: 62, do: (s) => ({ gestureActive: false, lastGestureEndAt: s.now }) },
    ]);
    expect(shown[0]).toBe(67);
  });

  it('stops for the rest of the session after (x)', () => {
    const shown = run(5, [{ at: 61, do: () => ({ snoozed: true }) }]);
    expect(shown).toEqual([60]);
  });

  it('waits while a sheet is open', () => {
    const shown = run(2, [
      { at: 50, do: () => ({ blocked: true }) },
      { at: 90, do: () => ({ blocked: false }) },
    ]);
    expect(shown[0]).toBe(90);
  });
});
