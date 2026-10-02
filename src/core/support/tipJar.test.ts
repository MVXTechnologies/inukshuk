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
  MUG_SCALE,
  mugPaths,
  TIP_BUTTON_MOTION,
  TIP_BUTTON_VARIANTS,
  TIP_JAR_HIDE_MS,
  TIP_JAR_HIDE_RECHECK_MS,
  TIP_JAR_REST_MS,
  TIP_JAR_WOBBLE_INTERVAL_MS,
  tipJarAnimates,
  tipJarHideUntil,
  tipJarVisible,
  type BubbleContext,
} from './tipJar';

describe('timings (named, owner-tunable)', () => {
  it('loops the mug every 12 s and offers a bubble at most every 2 min', () => {
    expect(MUG_LOOP_INTERVAL_MS).toBe(12_000);
    expect(TIP_JAR_WOBBLE_INTERVAL_MS).toBe(MUG_LOOP_INTERVAL_MS);
    expect(BUBBLE_INTERVAL_MS).toBe(120_000);
    expect(BUBBLE_FIRST_DELAY_MS).toBe(120_000);
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

  it('draws the cup 20 % bigger than round 4, in the same 48 dp button', () => {
    expect(MUG_SCALE).toBeCloseTo(1.2, 5);
    expect(L.button).toBe(48);
    expect(L.cup.right - L.cup.left).toBeCloseTo(12 * 1.2, 5);
    expect(L.cup.bottom - L.cup.top).toBeCloseTo(9.5 * 1.2, 5);
    expect(L.stroke).toBeCloseTo(2 * 1.2, 5);
    // Smoke, heart and face scale with it.
    expect(L.puff.width).toBeCloseTo(9 * 1.2, 5);
    expect(L.heart.width).toBeCloseTo(10 * 1.2, 5);
    expect(L.eyes.width).toBeCloseTo(6.2 * 1.2, 5);
  });

  it('keeps the whole mug, handle included, inside the circle', () => {
    const off = (L.button - L.box) / 2;
    const r = L.button / 2;
    const half = L.stroke / 2;
    const corners: [number, number][] = [
      [L.cup.left - half, L.cup.top - half],
      [L.handle.reach + half, L.handle.top - half],
      [L.handle.reach + half, L.handle.bottom + half],
      [L.cup.left - half, L.cup.bottom + half],
      [L.cup.right + half, L.cup.bottom + half],
    ];
    for (const [x, y] of corners) {
      expect(Math.hypot(off + x - r, off + y - r)).toBeLessThan(r - 2);
    }
  });

  it('keeps the smoke and heart above the rim and inside the circle', () => {
    const r = L.button / 2;
    const off = (L.button - L.box) / 2;
    // Highest point of a puff: it rises `rise` dp and swells to 1.3×.
    const puffTop = off + L.puff.top - L.puff.rise - (L.puff.height * 0.3) / 2;
    const heartTop = off + L.heart.top + L.heart.to;
    for (const top of [puffTop, heartTop]) {
      // Clear of the button's edge, above the rim.
      expect(top).toBeGreaterThan(2);
      expect(top).toBeLessThan(off + L.cup.top);
    }
    // The widest puff at its peak, and the heart at its peak, stay inside.
    const puffHalfW = (L.puff.width * 1.3) / 2 + L.puff.drift + L.puff.wobble;
    expect(Math.hypot(puffHalfW, r - puffTop)).toBeLessThan(r);
    expect(Math.hypot(L.heart.width / 2, r - heartTop)).toBeLessThan(r);
    // Each starts just over the rim, and the heart comes up out of the cup.
    expect(L.puff.top + L.puff.height).toBeLessThanOrEqual(L.cup.top);
    expect(L.heart.from).toBeGreaterThan(0);
  });

  it('draws the cup, handle and face from those numbers', () => {
    const { cup, face } = mugPaths();
    const n = (v: number) => Math.round(v * 100) / 100;
    expect(cup.startsWith(`M${n(L.cup.left)} ${n(L.cup.top)}`)).toBe(true);
    expect(cup).toContain(`M${n(L.cup.right)} ${n(L.handle.top)}`);
    expect(face).toContain(`M${n(L.axis - 1.6 * MUG_SCALE)} ${n(L.smileY)}`);
    // No float noise in the paths.
    expect(`${cup}${face}`).not.toMatch(/\d\.\d{3,}/);
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
    // The scene fits well inside the 12 s loop, with a rest after it.
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

describe('"Hide for an hour" (fake clock)', () => {
  const MIN = 60_000;
  const base = {
    enabled: true,
    recording: false,
    navigating: false,
    blocked: false,
    restingUntil: 0,
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-01T09:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is exactly one hour', () => {
    expect(TIP_JAR_HIDE_MS).toBe(60 * MIN);
    expect(tipJarHideUntil(1_000)).toBe(1_000 + 60 * MIN);
    expect(TIP_JAR_HIDE_RECHECK_MS).toBeLessThanOrEqual(MIN);
  });

  it('hides now, is still hidden at 59 min, and is back at 60 min', () => {
    const hiddenUntil = tipJarHideUntil(Date.now());
    expect(tipJarVisible({ ...base, hiddenUntil, now: Date.now() })).toBe(false);
    jest.advanceTimersByTime(59 * MIN);
    expect(tipJarVisible({ ...base, hiddenUntil, now: Date.now() })).toBe(false);
    jest.advanceTimersByTime(MIN);
    expect(tipJarVisible({ ...base, hiddenUntil, now: Date.now() })).toBe(true);
  });

  it('never brings back a button switched off in Settings', () => {
    const hiddenUntil = tipJarHideUntil(Date.now());
    jest.advanceTimersByTime(2 * 60 * MIN);
    expect(tipJarVisible({ ...base, enabled: false, hiddenUntil, now: Date.now() })).toBe(false);
  });

  it('never cuts the 12-month rest after a gift short', () => {
    const restingUntil = Date.now() + TIP_JAR_REST_MS;
    const hiddenUntil = tipJarHideUntil(Date.now());
    jest.advanceTimersByTime(2 * 60 * MIN);
    expect(tipJarVisible({ ...base, restingUntil, hiddenUntil, now: Date.now() })).toBe(false);
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

  it('offers the first bubble two minutes after the Map opens, not sooner', () => {
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

  it('shows the first bubble at 2 min, then one every 2 min', () => {
    expect(run(8)).toEqual([120, 240, 360, 480]);
  });

  it('never shows one during a recording, and resumes after', () => {
    const shown = run(8, [
      { at: 30, do: () => ({ buttonVisible: false }) },
      { at: 300, do: () => ({ buttonVisible: true }) },
    ]);
    expect(shown).toEqual([300, 420]);
  });

  it('holds off while the person moves the map, and for 5 s after', () => {
    const shown = run(3, [
      { at: 115, do: () => ({ gestureActive: true }) },
      { at: 122, do: (s) => ({ gestureActive: false, lastGestureEndAt: s.now }) },
    ]);
    expect(shown[0]).toBe(127);
  });

  it('stops for the rest of the session after (x)', () => {
    const shown = run(10, [{ at: 121, do: () => ({ snoozed: true }) }]);
    expect(shown).toEqual([120]);
  });

  it('waits while a sheet is open', () => {
    const shown = run(3, [
      { at: 100, do: () => ({ blocked: true }) },
      { at: 150, do: () => ({ blocked: false }) },
    ]);
    expect(shown[0]).toBe(150);
  });
});
