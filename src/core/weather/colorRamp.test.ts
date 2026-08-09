import { hexToRgb, interpolateRamp, rgbToHex } from './colorRamp';

describe('hexToRgb / rgbToHex', () => {
  it('round-trips six-digit hex colours', () => {
    expect(hexToRgb('#4A54C4')).toEqual({ r: 0x4a, g: 0x54, b: 0xc4 });
    expect(rgbToHex({ r: 0x4a, g: 0x54, b: 0xc4 })).toBe('#4A54C4');
    expect(hexToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('rejects junk', () => {
    expect(hexToRgb('#FFF')).toBeNull(); // shorthand unsupported by design
    expect(hexToRgb('red')).toBeNull();
    expect(hexToRgb('#GGGGGG')).toBeNull();
    expect(hexToRgb('')).toBeNull();
  });

  it('clamps and rounds channels on format', () => {
    expect(rgbToHex({ r: -5, g: 300, b: 127.6 })).toBe('#00FF80');
  });
});

describe('interpolateRamp', () => {
  it('keeps the endpoint colours and blends between them', () => {
    const ramp = interpolateRamp(['#000000', '#FFFFFF'], 3);
    expect(ramp).toEqual(['#000000', '#808080', '#FFFFFF']);
  });

  it('spaces multiple stops evenly (CSS linear-gradient style)', () => {
    const ramp = interpolateRamp(['#FF0000', '#00FF00', '#0000FF'], 5);
    expect(ramp[0]).toBe('#FF0000');
    expect(ramp[2]).toBe('#00FF00'); // middle stop lands mid-ramp
    expect(ramp[4]).toBe('#0000FF');
    expect(ramp[1]).toBe('#808000'); // halfway red→green
  });

  it('produces the requested count', () => {
    expect(interpolateRamp(['#000000', '#FFFFFF'], 32)).toHaveLength(32);
  });

  it('degrades predictably on degenerate inputs', () => {
    expect(interpolateRamp([], 8)).toEqual([]);
    expect(interpolateRamp(['#123456'], 3)).toEqual(['#123456', '#123456', '#123456']);
    expect(interpolateRamp(['#000000', '#FFFFFF'], 0)).toEqual([]);
    expect(interpolateRamp(['#000000', '#FFFFFF'], 1)).toEqual(['#000000']);
    expect(interpolateRamp(['junk', 'more junk'], 4)).toEqual([]);
    // Junk stops are skipped, parseable ones still ramp.
    expect(interpolateRamp(['junk', '#000000', '#FFFFFF'], 2)).toEqual(['#000000', '#FFFFFF']);
  });
});
