import { hillshadeLook } from './terrainOptions';
import {
  DEFAULT_TILT_RELIEF,
  isTiltRelief,
  MAP_MAX_PITCH_DEG,
  pitchBucket,
  TILT_RELIEF_EXAGGERATION,
  TILT_RELIEF_FULL_DEG,
  TILT_RELIEF_LABEL,
  TILT_RELIEF_START_DEG,
  TILT_RELIEFS,
  tiltAmount,
  tiltReliefExaggeration,
  tiltReliefLook,
} from './tiltRelief';

describe('the setting', () => {
  it('defaults to natural', () => {
    expect(DEFAULT_TILT_RELIEF).toBe('natural');
  });

  it('lists Off / Natural / Dramatic in slider order', () => {
    expect(TILT_RELIEFS.map((r) => TILT_RELIEF_LABEL[r])).toEqual(['Off', 'Natural', 'Dramatic']);
  });

  it('recognises only its own values', () => {
    for (const r of TILT_RELIEFS) expect(isTiltRelief(r)).toBe(true);
    for (const junk of ['none', 'Natural', '', null, undefined, 1, {}]) {
      expect(isTiltRelief(junk)).toBe(false);
    }
  });
});

describe('MAP_MAX_PITCH_DEG', () => {
  it("is MapLibre Native's default cap, which the RN wrapper cannot raise", () => {
    expect(MAP_MAX_PITCH_DEG).toBe(60);
  });

  it('leaves room to reach full relief before the cap', () => {
    expect(TILT_RELIEF_START_DEG).toBeLessThan(TILT_RELIEF_FULL_DEG);
    expect(TILT_RELIEF_FULL_DEG).toBeLessThan(MAP_MAX_PITCH_DEG);
  });
});

describe('tiltAmount', () => {
  it('is 0 while flat or barely tilted', () => {
    expect(tiltAmount(0)).toBe(0);
    expect(tiltAmount(TILT_RELIEF_START_DEG)).toBe(0);
    expect(tiltAmount(-5)).toBe(0);
  });

  it('is 1 from the full-relief pitch up to the cap', () => {
    expect(tiltAmount(TILT_RELIEF_FULL_DEG)).toBe(1);
    expect(tiltAmount(MAP_MAX_PITCH_DEG)).toBe(1);
  });

  it('ramps linearly and monotonically between', () => {
    const mid = (TILT_RELIEF_START_DEG + TILT_RELIEF_FULL_DEG) / 2;
    expect(tiltAmount(mid)).toBeCloseTo(0.5);
    let prev = 0;
    for (let p = 0; p <= MAP_MAX_PITCH_DEG; p += 1) {
      const t = tiltAmount(p);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it('reads a non-finite pitch as flat', () => {
    expect(tiltAmount(Number.NaN)).toBe(0);
    expect(tiltAmount(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('pitchBucket', () => {
  it('rounds to 5° steps so tiny settles re-render nothing', () => {
    expect(pitchBucket(0.4)).toBe(0);
    expect(pitchBucket(2.4)).toBe(0);
    expect(pitchBucket(2.6)).toBe(5);
    expect(pitchBucket(44.9)).toBe(45);
    expect(pitchBucket(47.4)).toBe(45);
  });

  it('never exceeds the cap and treats junk as flat', () => {
    expect(pitchBucket(85)).toBe(MAP_MAX_PITCH_DEG);
    expect(pitchBucket(-3)).toBe(0);
    expect(pitchBucket(Number.NaN)).toBe(0);
  });
});

describe('tiltReliefLook', () => {
  it('draws nothing when off, whatever the pitch', () => {
    expect(tiltReliefLook('off', MAP_MAX_PITCH_DEG, false)).toBeNull();
    expect(tiltReliefLook('off', MAP_MAX_PITCH_DEG, true)).toBeNull();
  });

  it('draws nothing on a flat map (no extra DEM pass)', () => {
    expect(tiltReliefLook('natural', 0, false)).toBeNull();
    expect(tiltReliefLook('dramatic', TILT_RELIEF_START_DEG, true)).toBeNull();
  });

  it('reaches each mode’s full exaggeration at full tilt', () => {
    expect(tiltReliefLook('natural', 50, false)?.exaggeration).toBe(
      TILT_RELIEF_EXAGGERATION.natural,
    );
    expect(tiltReliefLook('dramatic', 60, false)?.exaggeration).toBe(
      TILT_RELIEF_EXAGGERATION.dramatic,
    );
  });

  it('makes Dramatic deeper than Natural at every tilted pitch', () => {
    for (let p = TILT_RELIEF_START_DEG + 5; p <= MAP_MAX_PITCH_DEG; p += 5) {
      const n = tiltReliefLook('natural', p, false)!.exaggeration;
      const d = tiltReliefLook('dramatic', p, false)!.exaggeration;
      expect(d).toBeGreaterThan(n);
    }
  });

  it('stacked on the default shading, stays within the hillshade range', () => {
    const base = hillshadeLook('medium', false).exaggeration;
    for (const mode of ['natural', 'dramatic'] as const) {
      const extra = tiltReliefLook(mode, MAP_MAX_PITCH_DEG, false)!.exaggeration;
      expect(extra).toBeGreaterThan(0);
      expect(base + extra).toBeLessThanOrEqual(1.1);
    }
  });

  it.each([false, true])('uses the base shading palette (dark=%s)', (dark) => {
    const n = tiltReliefLook('natural', 60, dark)!;
    const d = tiltReliefLook('dramatic', 60, dark)!;
    const medium = hillshadeLook('medium', dark);
    const heavy = hillshadeLook('heavy', dark);
    expect(n.shadowColor).toBe(medium.shadowColor);
    expect(n.highlightColor).toBe(medium.highlightColor);
    expect(d.shadowColor).toBe(heavy.shadowColor);
    expect(d.accentColor).toBe(heavy.accentColor);
  });

  it('shades the dark map toward black and the light map toward umber', () => {
    expect(tiltReliefLook('natural', 60, true)!.shadowColor).toMatch(/^rgba\(0, 0, 0,/);
    expect(tiltReliefLook('natural', 60, false)!.shadowColor).toMatch(/^rgba\(74, 62, 45,/);
  });
});

describe('tiltReliefExaggeration', () => {
  it('is 0 (pass hidden) when off or flat', () => {
    expect(tiltReliefExaggeration('off', 60)).toBe(0);
    expect(tiltReliefExaggeration('natural', 0)).toBe(0);
    expect(tiltReliefExaggeration('dramatic', TILT_RELIEF_START_DEG)).toBe(0);
  });

  it('matches the look’s exaggeration whatever the theme', () => {
    for (const p of [15, 30, 45, 60]) {
      for (const mode of ['natural', 'dramatic'] as const) {
        expect(tiltReliefExaggeration(mode, p)).toBe(tiltReliefLook(mode, p, true)!.exaggeration);
      }
    }
  });
});
