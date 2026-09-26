import { compositeOver, isPurple, parseRgba, toHex, toHsl } from './hsl';

describe('parseRgba', () => {
  it.each([
    ['#2D3740', { r: 45, g: 55, b: 64, a: 1 }],
    ['#2d3740', { r: 45, g: 55, b: 64, a: 1 }],
    ['#fff', { r: 255, g: 255, b: 255, a: 1 }],
    ['#0008', { r: 0, g: 0, b: 0, a: 136 / 255 }],
    ['#2D374080', { r: 45, g: 55, b: 64, a: 128 / 255 }],
    ['rgb(247, 243, 249)', { r: 247, g: 243, b: 249, a: 1 }],
    ['rgba(45,55,64,0.92)', { r: 45, g: 55, b: 64, a: 0.92 }],
    ['rgba(45, 55, 64, 40%)', { r: 45, g: 55, b: 64, a: 0.4 }],
    ['transparent', { r: 0, g: 0, b: 0, a: 0 }],
    ['  Transparent ', { r: 0, g: 0, b: 0, a: 0 }],
  ])('%s', (input, expected) => {
    expect(parseRgba(input)).toEqual(expected);
  });

  it.each(['#12345', 'red', 'rgb(1,2)', 'rgb(256,0,0)', 'rgba(0,0,0,2)', ''])(
    'rejects %j',
    (input) => {
      expect(() => parseRgba(input)).toThrow();
    },
  );
});

describe('toHex', () => {
  it('formats upper-case and rounds', () => {
    expect(toHex({ r: 45.4, g: 55.6, b: 0, a: 1 })).toBe('#2D3800');
  });
});

describe('compositeOver', () => {
  it('returns the foreground when it is opaque', () => {
    expect(compositeOver('#2D3740', '#FFFFFF')).toBe('#2D3740');
  });

  it('mixes a translucent foreground into the background', () => {
    // Stone at 92 % over white: 45*.92 + 255*.08 = 61.8 → 3E; 64*.92 + 20.4 = 79.3 → 4F.
    expect(compositeOver('rgba(45,55,64,0.92)', '#FFFFFF')).toBe('#3E474F');
  });

  it('returns the background under a fully transparent foreground', () => {
    expect(compositeOver('transparent', '#F2ECE0')).toBe('#F2ECE0');
  });

  it('refuses a translucent background', () => {
    expect(() => compositeOver('#000000', 'rgba(0,0,0,0.5)')).toThrow();
  });
});

describe('toHsl', () => {
  it('is achromatic for greys', () => {
    expect(toHsl('#8A8B8C').s).toBeLessThan(0.01);
    expect(toHsl('#000000')).toEqual({ h: 0, s: 0, l: 0 });
  });

  it.each([
    ['#FF0000', 0],
    ['#00FF00', 120],
    ['#0000FF', 240],
    ['#FF00FF', 300],
    ['#FF0080', 330],
  ])('hue of %s is %d°', (hex, hue) => {
    expect(toHsl(hex).h).toBeCloseTo(hue, 0);
  });

  it('computes saturation and lightness', () => {
    const { s, l } = toHsl('#2D3740');
    expect(l).toBeCloseTo(0.2137, 3);
    expect(s).toBeCloseTo(0.1743, 3);
  });
});

describe('isPurple', () => {
  it.each([
    ['rgb(247, 243, 249)'], // Paper MD3 light elevation.level1 — the lavender leak
    ['rgb(233, 227, 241)'], // level5
    ['rgb(52, 49, 63)'], // dark level5
    ['rgb(208, 188, 255)'], // inversePrimary
    ['#8A63C9'], // a clearly purple swatch
  ])('flags %s', (c) => {
    expect(isPurple(c)).toBe(true);
  });

  it.each([
    ['#2D3740'], // stone: blue-grey, hue ~208°
    ['#F2ECE0'], // paper
    ['#8A8B8C'], // granite (achromatic)
    ['#2F7FC1'], // puck blue, hue ~207°
    ['transparent'],
    ['#1C1B1F'], // Paper's near-black: hue ~255° but HSL saturation 6.9 %
  ])('passes %s', (c) => {
    expect(isPurple(c)).toBe(false);
  });
});
