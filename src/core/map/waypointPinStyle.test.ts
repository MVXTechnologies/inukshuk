import { WAYPOINT_ICONS } from '@core/library/waypointIcons';
import { WAYPOINT_COLORS, WAYPOINT_INK_DARK } from '@core/library/waypointStyle';

import {
  DEFAULT_GLYPH_IMAGE,
  SELECTED_RING,
  glyphImageName,
  glyphImagesInUse,
  glyphSpriteSize,
  pinDrawOrder,
  pinFeatureCollection,
  pinLabelFilter,
  pinLayout,
  pinPaint,
  pinPhotoFilter,
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

const body = (fc: ReturnType<typeof pinFeatureCollection>, key: string) =>
  fc.features.find((f) => f.properties.key === key && f.properties.part === 'body')?.properties;
const glyph = (fc: ReturnType<typeof pinFeatureCollection>, key: string) =>
  fc.features.find((f) => f.properties.key === key && f.properties.part === 'glyph')?.properties;

describe('waypoint pin features (#675)', () => {
  it('draws each pin as a body then a glyph, with colour, ink, ring and sizes', () => {
    const fc = pinFeatureCollection(
      [pin({ icon: 'camp', color: '#FBC02D', size: 'L', hasPhoto: true })],
      null,
    );
    expect(fc.features.map((f) => f.id)).toEqual(['saved-a:body', 'saved-a:glyph']);
    expect(fc.features[0]?.geometry.coordinates).toEqual([-71.2, 46.8]);
    expect(fc.features[1]?.geometry.coordinates).toEqual([-71.2, 46.8]);
    expect(body(fc, 'saved-a')).toMatchObject({
      key: 'saved-a',
      label: 'A',
      img: 'wp-pin',
      tint: '#FBC02D',
      ring: '#FBF8F2',
      photo: true,
      sz: 0.8, // 40 / 50
      z: 0,
    });
    expect(glyph(fc, 'saved-a')).toMatchObject({
      img: 'wpg-camp',
      tint: WAYPOINT_INK_DARK,
      sz: 0.4,
    });
  });

  it('draws a plain pin as today: sage, inukshuk, M', () => {
    const fc = pinFeatureCollection([pin()], null);
    expect(body(fc, 'saved-a')).toMatchObject({ tint: '#566B33', sz: 0.64, photo: false });
    expect(glyph(fc, 'saved-a')).toMatchObject({ img: DEFAULT_GLYPH_IMAGE });
  });

  it('grows the selected pin, rings it amber and draws it last (on top)', () => {
    const fc = pinFeatureCollection(
      [pin({ key: 'saved-a', latitude: 46 }), pin({ key: 'saved-b', size: 'XL', latitude: 47 })],
      'saved-b',
    );
    expect(body(fc, 'saved-b')).toMatchObject({ ring: SELECTED_RING, z: 1, sz: 1.2 });
    expect(body(fc, 'saved-a')?.z).toBe(0);
    // b is north (would be behind), but selected: it goes last.
    expect(fc.features.map((f) => f.id)).toEqual([
      'saved-a:body',
      'saved-a:glyph',
      'saved-b:body',
      'saved-b:glyph',
    ]);
  });

  it('leaves out the pin being moved, and any non-finite coordinate', () => {
    const fc = pinFeatureCollection(
      [pin({ key: 'saved-a' }), pin({ key: 'saved-b' }), pin({ key: 'bad', latitude: NaN })],
      null,
      'saved-a',
    );
    expect(new Set(fc.features.map((f) => f.properties.key))).toEqual(new Set(['saved-b']));
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
   * Measure, don't assert wall-clock: 500 pins are ONE collection of 1000
   * features (one source update, one native call), the per-pin work is a
   * constant number of style lookups plus one sort, and the layer count does
   * not depend on the pin count at all.
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
    expect(fc.features).toHaveLength(1000);
    expect(new Set(fc.features.map((f) => f.id)).size).toBe(1000);
    // Generous ceiling only; the counts above are the measurement.
    expect(elapsed).toBeLessThan(500);
    // Even all distinct icons is a bounded registration (≤ catalogue + 1).
    expect(glyphImagesInUse(pins).length).toBeLessThanOrEqual(WAYPOINT_ICONS.length + 1);
  });
});

/**
 * 2.5.1 QA (overlapping pins): every glyph drew above every body, because a
 * glyph LAYER drew above a body LAYER. Now each pin's body and glyph are
 * consecutive features of ONE layer drawn in source order, back to front —
 * so whatever overlaps, a pin in front covers the whole pin behind it.
 */
describe('overlapping pins stack whole (body + glyph together)', () => {
  it('emits the features back to front, each body immediately followed by its glyph', () => {
    const fc = pinFeatureCollection(
      [
        pin({ key: 'south', latitude: 46.79 }),
        pin({ key: 'north', latitude: 46.81 }),
        pin({ key: 'mid', latitude: 46.8 }),
      ],
      null,
    );
    expect(fc.features.map((f) => f.id)).toEqual([
      'north:body',
      'north:glyph',
      'mid:body',
      'mid:glyph',
      'south:body',
      'south:glyph',
    ]);
  });

  it('keeps input order for pins at the same latitude', () => {
    const fc = pinFeatureCollection([pin({ key: 'first' }), pin({ key: 'second' })], null);
    expect(fc.features.map((f) => f.id)).toEqual([
      'first:body',
      'first:glyph',
      'second:body',
      'second:glyph',
    ]);
  });

  it('draws body and glyph from one layer, in source order, with no sort key', () => {
    // Source order is the draw order only without a sort key (style spec).
    expect(pinLayout['symbol-z-order']).toBe('source');
    expect(pinLayout).not.toHaveProperty('symbol-sort-key');
    expect(pinLayout['icon-image']).toEqual(['get', 'img']);
    expect(pinLayout['icon-size']).toEqual(['get', 'sz']);
    // Each part keeps its own anchor, offset, tint and ring.
    expect(pinLayout['icon-anchor']).toEqual([
      'match',
      ['get', 'part'],
      'glyph',
      'center',
      'bottom',
    ]);
    expect(pinPaint['icon-color']).toEqual(['get', 'tint']);
    expect(pinPaint['icon-halo-width']).toEqual(['match', ['get', 'part'], 'glyph', 0, 2]);
  });

  it('draws the badge and the label once per pin, from its body', () => {
    expect(JSON.stringify(pinPhotoFilter)).toContain('"body"');
    expect(pinLabelFilter).toEqual(['==', ['get', 'part'], 'body']);
  });

  it('pinDrawOrder: north behind, input order on ties, selected last', () => {
    const order = pinDrawOrder(
      [
        { key: 'a', latitude: 1 },
        { key: 'b', latitude: 3 },
        { key: 'c', latitude: 1 },
        { key: 'd', latitude: 2 },
      ],
      'b',
    );
    expect(order.map((p) => p.key)).toEqual(['d', 'a', 'c', 'b']);
  });
});

describe('sprite geometry', () => {
  it('matches the generator: pin 62×73, glyph 68×68', () => {
    expect(pinSpriteSize()).toMatchObject({ width: 62, height: 73 });
    expect(glyphSpriteSize()).toBe(68);
  });

  it('never culls a pin and sizes it per feature', () => {
    expect(pinLayout['icon-allow-overlap']).toBe(true);
    expect(pinLayout['icon-ignore-placement']).toBe(true);
  });

  it('keeps zoom out of the per-feature expressions (iOS crashes on ["zoom"] in match/case)', () => {
    expect(JSON.stringify([pinLayout, pinPaint])).not.toContain('zoom');
  });
});
