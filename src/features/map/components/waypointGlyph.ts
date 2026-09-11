import { waypointIconGlyph } from '@core/library/waypointIcons';
import type { WaypointIcon } from '@core/models';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

/** The glyph names `MaterialCommunityIcons` actually ships, as a type. */
export type MciGlyph = keyof typeof MaterialCommunityIcons.glyphMap;

/**
 * Bridge between the pure icon catalogue (`@core/library/waypointIcons`, which
 * must not import the font) and the component that draws it: narrow a
 * catalogue glyph name to one the bundled font really has.
 *
 * `null` means "draw the default pin" — for a waypoint with no icon, and for
 * the should-never-happen glyph that went missing from the font, which is far
 * better than a tofu box on a map. `waypointGlyph.test.ts` fails CI before it
 * can come to that.
 */
export function mciGlyph(icon: WaypointIcon | undefined): MciGlyph | null {
  const glyph = waypointIconGlyph(icon);
  return glyph !== null && isMciGlyph(glyph) ? glyph : null;
}

export function isMciGlyph(glyph: string): glyph is MciGlyph {
  return Object.prototype.hasOwnProperty.call(MaterialCommunityIcons.glyphMap, glyph);
}
