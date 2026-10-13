import {
  DEFAULT_WAYPOINT_COLOR,
  WAYPOINT_COLORS,
  WAYPOINT_INK_DARK,
  WAYPOINT_INK_LIGHT,
  WAYPOINT_PIN_DIAMETER,
  WAYPOINT_RING,
  WAYPOINT_RING_ON_PAPER,
  contrastRatio,
  swatchNeedsOutline,
  isWaypointColor,
  isWaypointSize,
  normalizeWaypointStyle,
  pinGeometry,
  waypointColorName,
  waypointFill,
  waypointInk,
  waypointRing,
  waypointSize,
  waypointSizeName,
  waypointStyleCaption,
} from './waypointStyle';

describe('waypoint palette (#675)', () => {
  it('has 18 distinct swatches, each a valid colour with a name', () => {
    expect(WAYPOINT_COLORS).toHaveLength(18);
    expect(new Set(WAYPOINT_COLORS.map((c) => c.hex)).size).toBe(18);
    for (const c of WAYPOINT_COLORS) {
      expect(isWaypointColor(c.hex)).toBe(true);
      expect(c.hex).toBe(c.hex.toUpperCase());
      expect(waypointColorName(c.hex)).toBe(c.name);
    }
  });

  it('flips the glyph ink to dark on the light swatches', () => {
    const dark = WAYPOINT_COLORS.filter((c) => waypointInk(c.hex) === WAYPOINT_INK_DARK).map(
      (c) => c.name,
    );
    // The mockup's four light fills, plus cyan and pumpkin, whose white glyph
    // measured under 3:1.
    expect(dark.sort()).toEqual(['Amber', 'Cyan', 'Lime', 'Paper', 'Pumpkin', 'Yellow']);
  });

  it('gives every swatch, and the default, a glyph at 3:1 or better', () => {
    for (const hex of [...WAYPOINT_COLORS.map((c) => c.hex), DEFAULT_WAYPOINT_COLOR]) {
      expect([hex, contrastRatio(waypointInk(hex), hex) >= 3]).toEqual([hex, true]);
    }
  });

  it('rings the paper pin in stone, every other pin in paper', () => {
    expect(waypointRing('#FBF8F2')).toBe(WAYPOINT_RING_ON_PAPER);
    expect(waypointRing('#D32F2F')).toBe(WAYPOINT_RING);
    expect(waypointRing(undefined)).toBe(WAYPOINT_RING);
  });

  it('falls back to the default sage for no colour or junk', () => {
    expect(waypointFill(undefined)).toBe(DEFAULT_WAYPOINT_COLOR);
    expect(waypointFill('red')).toBe(DEFAULT_WAYPOINT_COLOR);
    expect(waypointFill('#1e64c8')).toBe('#1E64C8');
    expect(waypointInk(undefined)).toBe(WAYPOINT_INK_LIGHT);
  });

  it('names a foreign colour "Custom colour"', () => {
    expect(waypointColorName('#123456')).toBe('Custom colour');
    expect(waypointColorName(undefined)).toBe('Default colour');
  });

  it('measures contrast like WCAG', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });
});

describe('waypoint size (#675)', () => {
  it('defaults to M and validates', () => {
    expect(waypointSize(undefined)).toBe('M');
    expect(waypointSize('XL')).toBe('XL');
    expect(isWaypointSize('XXL')).toBe(false);
    expect(isWaypointSize(2)).toBe(false);
    expect(waypointSizeName('L')).toBe('Large');
  });

  it('grows S < M < L < XL', () => {
    const d = WAYPOINT_PIN_DIAMETER;
    expect(d.S < d.M && d.M < d.L && d.L < d.XL).toBe(true);
  });

  it('puts the head centre √2/2 of the diameter above the tip', () => {
    const g = pinGeometry(40);
    expect(g.headCenterY).toBeCloseTo(28.284, 3);
    expect(g.height).toBeCloseTo(48.284, 3);
    expect(g.width).toBe(40);
  });
});

describe('style helpers', () => {
  it('captions the preview', () => {
    expect(waypointStyleCaption({ icon: 'camp', color: '#E8612C', size: 'L' })).toBe(
      'Camp · Orange · L',
    );
    expect(waypointStyleCaption({})).toBe('Default pin · Default colour · M');
  });

  it('keeps valid style fields and drops junk', () => {
    expect(normalizeWaypointStyle({ color: '#abcdef', size: 'S' })).toEqual({
      color: '#ABCDEF',
      size: 'S',
    });
    expect(normalizeWaypointStyle({ color: 12, size: 'huge' })).toEqual({});
  });
});

describe('swatchNeedsOutline (2.5.1 QA: Stone vanished on the dark sheet)', () => {
  const LIGHT_SHEET = '#FBF8F2';
  const DARK_SHEET = '#1A1F24';

  it('outlines Paper on the light sheet and Stone on the dark one', () => {
    expect(swatchNeedsOutline('#FBF8F2', LIGHT_SHEET)).toBe(true);
    expect(swatchNeedsOutline('#2D3740', DARK_SHEET)).toBe(true);
  });

  it('leaves every swatch that stands out alone', () => {
    expect(swatchNeedsOutline('#2D3740', LIGHT_SHEET)).toBe(false);
    expect(swatchNeedsOutline('#FBF8F2', DARK_SHEET)).toBe(false);
    expect(swatchNeedsOutline('#D32F2F', DARK_SHEET)).toBe(false);
  });

  it('outlines at most a couple of the 18 swatches per theme', () => {
    for (const sheet of [LIGHT_SHEET, DARK_SHEET]) {
      const outlined = WAYPOINT_COLORS.filter((c) => swatchNeedsOutline(c.hex, sheet));
      expect(outlined.length).toBeGreaterThanOrEqual(1);
      expect(outlined.length).toBeLessThanOrEqual(2);
    }
  });
});
