import { contrastRatio } from '@core/color/contrast';
import { compositeOver, isPurple, parseRgba } from '@core/color/hsl';

import { darkScheme, lightScheme, MIN_FONT_SIZE, palette, type SchemeTokens, type } from './tokens';

/** WCAG 2.1: text (SC 1.4.3) and graphics/UI components (SC 1.4.11). */
const TEXT = 4.5;
const GRAPHIC = 3;

/** Every colour string in a (nested) token object, with its path. */
function colourEntries(obj: object, prefix = ''): [string, string][] {
  return Object.entries(obj).flatMap(([k, v]): [string, string][] => {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') return [[path, v]];
    if (v && typeof v === 'object') return colourEntries(v as object, path);
    return [];
  });
}

/** Translucent colours are judged as drawn: over the lightest and darkest map. */
const MAP_EXTREMES = ['#FFFFFF', '#000000'];
function asDrawn(fg: string, bg: string): string[] {
  return parseRgba(bg).a < 1 ? MAP_EXTREMES.map((ground) => compositeOver(bg, ground)) : [bg];
}

describe('no purple (decision: Stone & Paper replaces Material lavender)', () => {
  it.each([...colourEntries(palette, 'palette'), ...colourEntries(lightScheme, 'light')])(
    '%s %s',
    (_path, colour) => {
      expect(isPurple(colour)).toBe(false);
    },
  );

  it.each(colourEntries(darkScheme, 'dark'))('%s %s', (_path, colour) => {
    expect(isPurple(colour)).toBe(false);
  });
});

/**
 * The fg/bg pairs the app actually draws, per scheme. Add a pair here when a
 * new token combination reaches the screen.
 */
function pairs(t: SchemeTokens): [string, string, string, number][] {
  return [
    // Text on the app's grounds.
    ['ink on surface', t.ink, t.surface, TEXT],
    ['ink on background', t.ink, t.background, TEXT],
    ['ink variant on surface', t.inkVariant, t.surface, TEXT],
    ['ink variant on elevation 5', t.inkVariant, t.elevation.level5, TEXT],
    ['muted on surface', t.inkMuted, t.surface, TEXT],
    ['muted on tab bar (level 2)', t.inkMuted, t.elevation.level2, TEXT],
    ['muted on elevation 3', t.inkMuted, t.elevation.level3, TEXT],
    // Map chrome (translucent: judged over light and dark tiles).
    ['chrome ink on map chrome', t.map.chromeInk, t.map.chrome, TEXT],
    ['follow ink on map chrome', t.map.followInk, t.map.chrome, GRAPHIC],
    ['follow ink on active chrome', t.map.followInk, t.map.chromeActive, GRAPHIC],
    ['compass north tip on map chrome', t.map.compassNorth, t.map.chrome, GRAPHIC],
    ['compass south tail on map chrome', t.map.compassSouth, t.map.chrome, GRAPHIC],
    ['chip ink on chip', t.map.chipInk, t.map.chip, TEXT],
    ['chip muted ink on chip', t.map.chipInkMuted, t.map.chip, TEXT],
    ['puck on its ring', t.map.puck, t.map.puckRing, GRAPHIC],
    // Status (text + shape).
    ['text on paused fill', t.status.onPaused, t.status.paused, TEXT],
    ['paused ink on surface', t.status.pausedInk, t.surface, TEXT],
    ['paused ink on elevation 5', t.status.pausedInk, t.elevation.level5, TEXT],
    ['weak-GPS ink on surface', t.status.gpsWeak, t.surface, TEXT],
    ['weak-GPS ink on elevation 5', t.status.gpsWeak, t.elevation.level5, TEXT],
    ['lost-GPS ink on elevation 5', t.status.gpsLostInk, t.elevation.level5, TEXT],
    ['text on lost-GPS fill', t.status.onGpsLost, t.status.gpsLost, TEXT],
    ['recording dot on recording chip', t.status.recordingDot, t.status.recording, GRAPHIC],
    // Data marks.
    ['route on its casing', t.data.route, t.data.routeCasing, GRAPHIC],
    ['route casing on paper', t.data.routeCasing, palette.paper, GRAPHIC],
    ['heading needle on surface', t.data.heading, t.surface, GRAPHIC],
    ['heading needle on elevation 2', t.data.heading, t.elevation.level2, GRAPHIC],
    ['info accent on surface', t.data.info, t.surface, GRAPHIC],
    ['ascent on surface', t.data.ascent, t.surface, GRAPHIC],
    ['descent on surface', t.data.descent, t.surface, GRAPHIC],
    // Control borders.
    ['outline on surface', t.outline, t.surface, GRAPHIC],
  ];
}

describe.each([
  ['light', lightScheme],
  ['stone night', darkScheme],
])('%s contrast, as used', (_name, scheme) => {
  it.each(pairs(scheme))('%s', (_label, fg, bg, min) => {
    for (const ground of asDrawn(fg, bg)) {
      expect(contrastRatio(fg, ground)).toBeGreaterThanOrEqual(min);
    }
  });
});

describe('type scale', () => {
  it.each(Object.entries(type))('%s is at least the 12 dp floor', (_name, style) => {
    expect(style.fontSize).toBeGreaterThanOrEqual(MIN_FONT_SIZE);
  });
});
