import { WAYPOINT_ICONS } from '@core/library/waypointIcons';
import {
  DEFAULT_GLYPH_IMAGE,
  PHOTO_IMAGE,
  PIN_IMAGE,
  glyphImageName,
  glyphSpriteSize,
  pinSpriteSize,
} from '@core/map/waypointPinStyle';
import { readFileSync } from 'fs';
import { join } from 'path';

import { WAYPOINT_PIN_IMAGES } from './waypointPinImages';

const DIR = join(__dirname, '../../../../assets/map/waypoints');

/** Width and height from a PNG's IHDR. */
function pngSize(name: string): [number, number] {
  const buf = readFileSync(join(DIR, `${name}.png`));
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

/**
 * The sprites are generated (`scripts/map/build-waypoint-icons.mjs`); the
 * map layer's offsets and sizes are computed from constants in
 * `@core/map/waypointPinStyle`. This holds the two together.
 */
describe('waypoint pin sprites (#675)', () => {
  it('has a glyph for every catalogue icon, the inukshuk, the body and the badge', () => {
    for (const spec of WAYPOINT_ICONS) {
      expect([spec.id, glyphImageName(spec.id) in WAYPOINT_PIN_IMAGES]).toEqual([spec.id, true]);
    }
    for (const name of [DEFAULT_GLYPH_IMAGE, PIN_IMAGE, PHOTO_IMAGE]) {
      expect(name in WAYPOINT_PIN_IMAGES).toBe(true);
    }
    expect(Object.keys(WAYPOINT_PIN_IMAGES)).toHaveLength(WAYPOINT_ICONS.length + 3);
  });

  it('draws the sprites at the size the layer style assumes', () => {
    const pin = pinSpriteSize();
    expect(pngSize(PIN_IMAGE)).toEqual([pin.width, pin.height]);
    const g = glyphSpriteSize();
    expect(pngSize(DEFAULT_GLYPH_IMAGE)).toEqual([g, g]);
    expect(pngSize('wpg-camp')).toEqual([g, g]);
  });
});
