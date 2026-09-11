import { WAYPOINT_ICONS } from '@core/library/waypointIcons';
import { isMciGlyph, mciGlyph } from './waypointGlyph';

/**
 * The catalogue in `@core` is pure and cannot import the icon font, so nothing
 * there can tell a real glyph name from a typo — this is the guard that can.
 * Without it a mistyped glyph ships as a tofu box on a map, on a device, in
 * the woods.
 */
describe('waypoint icon glyphs', () => {
  it('names a glyph MaterialCommunityIcons actually ships, for every catalogue icon', () => {
    for (const spec of WAYPOINT_ICONS) {
      expect([spec.id, isMciGlyph(spec.glyph)]).toEqual([spec.id, true]);
      expect(mciGlyph(spec.id)).toBe(spec.glyph);
    }
  });

  it('asks for the default pin when the waypoint has no icon', () => {
    expect(mciGlyph(undefined)).toBeNull();
  });

  it('rejects a name the font does not have', () => {
    expect(isMciGlyph('definitely-not-a-glyph')).toBe(false);
    expect(isMciGlyph('hasOwnProperty')).toBe(false);
  });
});
