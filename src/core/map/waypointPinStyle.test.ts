import { WAYPOINT_ICONS } from '@core/library/waypointIcons';
import { WAYPOINT_COLORS, WAYPOINT_INK_DARK } from '@core/library/waypointStyle';

import {
  DEFAULT_GLYPH_IMAGE,
  SELECTED_RING,
  glyphImageName,
  glyphImagesInUse,
  glyphSpriteSize,
  pinBodyLayout,
  pinFeatureCollection,
  pinGlyphLayout,
  pinSpriteSize,
  type PinInput,
} from './waypointPinStyle';

const pin = (over: Partial<PinInput> = {}): PinInput => ({
  key: 'saved-a',
  latitude: 46.8,
  longitude: -71.2,
  label: 'A',
  ...over,
});

describe('waypoint pin features (#675)', () => {
  it('carries colour, ink, ring, glyph and sizes per pin', () => {
    const [f] = pinFeatureCollection(
      [pin({ icon: 'camp', color: '#FBC02D', size: 'L', hasPhoto: true })],
      null,
    ).features;
    expect(f?.geometry.coordinates).toEqual([-71.2, 46.8]);
    expect(f?.properties).toMatchObject({
      key: 'saved-a',
      label: 'A',
      fill: '#FBC02D',
      ink: WAYPOINT_INK_DARK,
      ring: '#FBF8F2',
      glyph: 'wpg-camp',
      photo: true,
      s: 0.8, // 40 / 50
      gs: 0.4,
      z: 0,
    });
  });

  it('draws a plain pin as today: sage, inukshuk, M', () => {
    const [f] = pinFeatureCollection([pin()], null).features;
    expect(f?.properties).toMatchObject({
      fill: '#566B33',
      glyph: DEFAULT_GLYPH_IMAGE,
      s: 0.64,
      photo: false,
    });
  });

  it('grows the selected pin, rings it amber and draws it on top', () => {
    const fc = pinFeatureCollection(
      [pin({ key: 'saved-a' }), pin({ key: 'saved-b', size: 'XL' })],
      'saved-b',
    );
    const b = fc.features.find((f) => f.properties.key === 'saved-b')?.properties;
    expect(b).toMatchObject({ ring: SELECTED_RING, z: 1, s: 1.2 });
    expect(fc.features.find((f) => f.properties.key === 'saved-a')?.properties.z).toBe(0);
  });

  it('leaves out the pin being moved, and any non-finite coordinate', () => {
    const fc = pinFeatureCollection(
      [pin({ key: 'saved-a' }), pin({ key: 'saved-b' }), pin({ key: 'bad', latitude: NaN })],
      null,
      'saved-a',
    );
    expect(fc.features.map((f) => f.properties.key)).toEqual(['saved-b']);
  });

  it('falls back to the inukshuk for an icon a later build wrote', () => {
    expect(glyphImageName('from-the-future')).toBe(DEFAULT_GLYPH_IMAGE);
    expect(glyphImageName(undefined)).toBe(DEFAULT_GLYPH_IMAGE);
  });

  it('registers only the glyphs in use', () => {
    expect(glyphImagesInUse([pin({ icon: 'camp' }), pin({ icon: 'camp' }), pin()])).toEqual([
      'wpg-camp',
      'wpg-default',
    ]);
  });

  /**
   * Measure, don't assert wall-clock: 500 pins are ONE collection of 500
   * features (one source update, one native call), the per-pin work is a
   * constant number of style lookups, and the layer count does not depend on
   * the pin count at all.
   */
  it('builds 500 pins as one collection, linear in the pin count', () => {
    const pins = Array.from({ length: 500 }, (_, i) =>
      pin({
        key: `saved-${i}`,
        latitude: 46 + i * 1e-3,
        icon: WAYPOINT_ICONS[i % WAYPOINT_ICONS.length]?.id,
        color: WAYPOINT_COLORS[i % WAYPOINT_COLORS.length]?.hex,
        size: (['S', 'M', 'L', 'XL'] as const)[i % 4],
        hasPhoto: i % 7 === 0,
      }),
    );
    const t0 = Date.now();
    const fc = pinFeatureCollection(pins, 'saved-3');
    const elapsed = Date.now() - t0;
    expect(fc.features).toHaveLength(500);
    expect(new Set(fc.features.map((f) => f.id)).size).toBe(500);
    // Generous ceiling only; the counts above are the measurement.
    expect(elapsed).toBeLessThan(500);
    // Even all distinct icons is a bounded registration (≤ catalogue + 1).
    expect(glyphImagesInUse(pins).length).toBeLessThanOrEqual(WAYPOINT_ICONS.length + 1);
  });
});

describe('sprite geometry', () => {
  it('matches the generator: pin 62×73, glyph 68×68', () => {
    expect(pinSpriteSize()).toMatchObject({ width: 62, height: 73 });
    expect(glyphSpriteSize()).toBe(68);
  });

  it('never culls a pin and sizes it per feature', () => {
    for (const layout of [pinBodyLayout, pinGlyphLayout]) {
      expect(layout['icon-allow-overlap']).toBe(true);
      expect(layout['icon-ignore-placement']).toBe(true);
    }
    expect(pinBodyLayout['icon-size']).toEqual(['get', 's']);
    expect(pinGlyphLayout['icon-image']).toEqual(['get', 'glyph']);
  });

  it('keeps zoom out of the per-feature expressions (iOS crashes on ["zoom"] in match/case)', () => {
    expect(JSON.stringify([pinBodyLayout, pinGlyphLayout])).not.toContain('zoom');
  });
});
