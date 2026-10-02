import {
  DEFAULT_WHITE_KEY,
  WHITE_KEY_LEVELS,
  nearestWhiteKeyLevel,
  parseWhiteKeyLevel,
  whiteKeyLabel,
  whiteKeyStrength,
  effectiveWhiteKey,
  isWhiteKeyLevel,
  keyWhiteAlpha,
  loadWhiteKeyRuntime,
} from './pdfWhiteKey';

const { keyWhite, keyPixel } = loadWhiteKeyRuntime();
const FULL = whiteKeyStrength(4);
const SOME = whiteKeyStrength(2);

/** Composite an RGBA pixel over an opaque background channel value. */
const over = (c: number, a: number, bg: number) => (c * a + bg * (255 - a)) / 255;

describe('keyWhiteAlpha', () => {
  it('makes pure white fully transparent at full strength', () => {
    expect(keyWhiteAlpha(255, 255, 255, 255, FULL)).toBe(0);
  });

  it('leaves pure white partly opaque at 50 %', () => {
    const alpha = keyWhiteAlpha(255, 255, 255, 255, SOME);
    expect(alpha).toBeGreaterThan(80);
    expect(alpha).toBeLessThan(160);
  });

  it('keeps a light-grey text edge partially', () => {
    const alpha = keyWhiteAlpha(200, 200, 200, 255, FULL);
    expect(alpha).toBeGreaterThan(100);
    expect(alpha).toBeLessThan(255);
  });

  it('never touches dark ink', () => {
    expect(keyWhiteAlpha(0, 0, 0, 255, FULL)).toBe(255);
    expect(keyWhiteAlpha(120, 120, 120, 255, FULL)).toBe(255);
  });

  it.each([
    ['woodland green', [205, 230, 190]],
    // Measured on a 2024 US Topo sheet (Beau Lake, ME): its woodland tint is very
    // light (chroma 25) and must still stay fully opaque.
    ['US Topo woodland tint', [228, 240, 215]],
    ['water blue', [175, 220, 250]],
    ['contour brown', [200, 160, 110]],
    ['built-up pink', [250, 205, 205]],
    ['saturated red', [230, 30, 40]],
    ['yellow', [255, 255, 120]],
  ])('keeps %s fully opaque', (_name, rgb) => {
    const [r, g, b] = rgb as [number, number, number];
    expect(keyWhiteAlpha(r, g, b, 255, FULL)).toBe(255);
  });

  it('is monotonic in strength', () => {
    const at = (s: number) => keyWhiteAlpha(235, 235, 235, 255, s);
    expect(at(0)).toBe(255);
    expect(at(SOME)).toBeLessThan(at(0));
    expect(at(FULL)).toBeLessThan(at(SOME));
  });

  it('scales an already-translucent pixel', () => {
    expect(keyWhiteAlpha(255, 255, 255, 100, SOME)).toBe(Math.round(100 * (1 - SOME)));
  });
});

describe('keyPixel', () => {
  it('un-blends the kept share from white so it looks unchanged over white', () => {
    for (const v of [190, 210, 225, 235]) {
      const [r, , , a] = keyPixel(v, v, v, 255, FULL) as [number, number, number, number];
      expect(Math.abs(over(r, a, 255) - v)).toBeLessThanOrEqual(2);
    }
  });

  it('darkens the kept part of a grey edge instead of leaving a pale halo', () => {
    const [r, , , a] = keyPixel(225, 225, 225, 255, FULL) as [number, number, number, number];
    expect(a).toBeLessThan(255);
    expect(r).toBeLessThan(225);
  });
});

describe('keyWhite (buffer pass)', () => {
  it('returns the buffer unchanged at strength 0', () => {
    const data = new Uint8ClampedArray([255, 255, 255, 255, 200, 200, 200, 255, 10, 200, 30, 255]);
    const copy = Uint8ClampedArray.from(data);
    expect(keyWhite(data, 0)).toBe(0);
    expect(data).toEqual(copy);
  });

  it('keys white, keeps colour and ink, and counts what changed', () => {
    const data = new Uint8ClampedArray([
      255,
      255,
      255,
      255, // paper
      0,
      0,
      0,
      255, // ink
      205,
      230,
      190,
      255, // woodland
      250,
      250,
      250,
      255, // near-white
    ]);
    expect(keyWhite(data, FULL)).toBe(2);
    expect(data[3]).toBe(0);
    expect(Array.from(data.slice(4, 12))).toEqual([0, 0, 0, 255, 205, 230, 190, 255]);
    // Near-white keeps only the faint ink it holds: 5/255 of black.
    expect(Array.from(data.slice(12, 16))).toEqual([0, 0, 0, 5]);
  });

  it('keys every pixel of a run like the first (the run shortcut is exact)', () => {
    const px = [230, 232, 229, 255, 230, 232, 229, 255, 40, 40, 40, 255, 230, 232, 229, 255];
    const data = new Uint8ClampedArray(px);
    keyWhite(data, SOME);
    const one = keyPixel(230, 232, 229, 255, SOME);
    expect(Array.from(data.slice(0, 4))).toEqual(one);
    expect(Array.from(data.slice(4, 8))).toEqual(one);
    expect(Array.from(data.slice(8, 12))).toEqual([40, 40, 40, 255]);
    expect(Array.from(data.slice(12, 16))).toEqual(one);
  });

  it('clamps strength and ignores a trailing partial pixel', () => {
    const data = new Uint8ClampedArray([255, 255, 255, 255, 255, 255]);
    expect(keyWhite(data, 7)).toBe(1);
    expect(data[3]).toBe(0);
    expect(keyWhite(new Uint8ClampedArray([255, 255, 255, 255]), -1)).toBe(0);
  });
});

describe('levels (5-stop slider)', () => {
  it('defaults to Off, with no keying', () => {
    expect(DEFAULT_WHITE_KEY).toBe(0);
    expect(whiteKeyStrength(DEFAULT_WHITE_KEY)).toBe(0);
  });

  it('maps the five stops onto 0 / 25 / 50 / 75 / 100 % strength', () => {
    expect(WHITE_KEY_LEVELS).toEqual([0, 1, 2, 3, 4]);
    expect(WHITE_KEY_LEVELS.map(whiteKeyStrength)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('labels the stops Off, 25 %, 50 %, 75 %, 100 %', () => {
    expect(WHITE_KEY_LEVELS.map(whiteKeyLabel)).toEqual(['Off', '25 %', '50 %', '75 %', '100 %']);
  });

  it('keys pure white more at every stop, to fully clear at 100 %', () => {
    const alphas = WHITE_KEY_LEVELS.map((l) =>
      keyWhiteAlpha(255, 255, 255, 255, whiteKeyStrength(l)),
    );
    expect(alphas[0]).toBe(255);
    expect(alphas[4]).toBe(0);
    for (let i = 1; i < alphas.length; i++) {
      expect(alphas[i]).toBeLessThan(alphas[i - 1] ?? 0);
    }
    // 50 % leaves half the paper as a veil.
    expect(Math.abs((alphas[2] ?? 0) - 128)).toBeLessThanOrEqual(1);
  });

  it('keeps the US Topo woodland tint (228, 240, 215) fully solid at every stop', () => {
    for (const l of WHITE_KEY_LEVELS) {
      expect(keyWhiteAlpha(228, 240, 215, 255, whiteKeyStrength(l))).toBe(255);
    }
  });

  it('validates persisted stops', () => {
    expect(isWhiteKeyLevel(2)).toBe(true);
    expect(isWhiteKeyLevel(0)).toBe(true);
    expect(isWhiteKeyLevel(5)).toBe(false);
    expect(isWhiteKeyLevel(1.5)).toBe(false);
    expect(isWhiteKeyLevel('some')).toBe(false);
  });

  it('migrates the old named levels: off → 0, some → 2 (50 %), full → 4 (100 %)', () => {
    expect(parseWhiteKeyLevel('off')).toBe(0);
    expect(parseWhiteKeyLevel('some')).toBe(2);
    expect(parseWhiteKeyLevel('full')).toBe(4);
    expect(parseWhiteKeyLevel(3)).toBe(3);
    for (const junk of ['half', 'toString', 'constructor', 7, -1, 2.5, null, undefined, {}]) {
      expect(parseWhiteKeyLevel(junk)).toBeUndefined();
    }
  });

  it('snaps a slider position to the nearest stop, clamped', () => {
    expect(nearestWhiteKeyLevel(0.4)).toBe(0);
    expect(nearestWhiteKeyLevel(1.6)).toBe(2);
    expect(nearestWhiteKeyLevel(3.5)).toBe(4);
    expect(nearestWhiteKeyLevel(9)).toBe(4);
    expect(nearestWhiteKeyLevel(-3)).toBe(0);
    expect(nearestWhiteKeyLevel(Number.NaN)).toBe(0);
  });

  it('lets a per-map override win over the global level', () => {
    expect(effectiveWhiteKey(undefined, 2)).toBe(2);
    expect(effectiveWhiteKey(0, 4)).toBe(0);
    expect(effectiveWhiteKey(4, 0)).toBe(4);
  });
});
