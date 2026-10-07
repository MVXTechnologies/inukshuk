import { contrastRatio } from '@core/color/contrast';
import { compositeOver, isPurple, parseRgba, toHsl } from '@core/color/hsl';

import {
  darkScheme,
  lightScheme,
  MIN_FONT_SIZE,
  nightScheme,
  palette,
  sunlightScheme,
  type SchemeTokens,
  type,
} from './tokens';

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

  it.each([
    ...colourEntries(darkScheme, 'dark'),
    ...colourEntries(sunlightScheme, 'sunlight'),
    ...colourEntries(nightScheme, 'night'),
  ])('%s %s', (_path, colour) => {
    expect(isPurple(colour)).toBe(false);
  });
});

describe('night red keeps night vision (decision 4: no blue or green)', () => {
  it.each(colourEntries(nightScheme, 'night'))('%s %s is red or neutral', (_path, colour) => {
    const { h, s } = toHsl(colour);
    const neutral = s < 0.08 || parseRgba(colour).a === 0;
    expect(neutral || h <= 20 || h >= 340).toBe(true);
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
    // Logbook statistics.
    ['streak flame on background', t.stats.flame, t.background, GRAPHIC],
    ['current bar on surface', t.stats.barCurrent, t.surface, GRAPHIC],
    ['NEW badge ink on its badge', t.stats.onNewBadge, t.stats.newBadge, TEXT],
    // Map chrome (translucent: judged over light and dark tiles).
    ['chrome ink on map chrome', t.map.chromeInk, t.map.chrome, TEXT],
    ['chrome ink on the mini recording pill', t.map.chromeInk, t.map.chromeMini, TEXT],
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
    ['crag accent on surface', t.data.crag, t.surface, GRAPHIC],
    ['crag accent on background', t.data.crag, t.background, GRAPHIC],
    ['ascent on surface', t.data.ascent, t.surface, GRAPHIC],
    ['descent on surface', t.data.descent, t.surface, GRAPHIC],
    // Control borders.
    ['outline on surface', t.outline, t.surface, GRAPHIC],
    // Library (After-Library.html).
    ['thumbnail route on its ground', t.data.route, t.library.thumb, GRAPHIC],
    ['thumbnail route on its casing', t.data.route, t.library.thumbCasing, GRAPHIC],
    ['thumbnail start dot on its ground', t.library.thumbStart, t.library.thumb, GRAPHIC],
    ['map placeholder sheet edge', t.library.mapSheetEdge, t.library.mapSheet, GRAPHIC],
    ['selected type chip label', t.library.chipOnInk, t.library.chipOn, TEXT],
    ['selected type chip count', t.library.chipOnCount, t.library.chipOn, TEXT],
    ['type chip label', t.library.chipInk, t.library.chip, TEXT],
    ['type chip count', t.library.chipCount, t.library.chip, TEXT],
    ['on-map chip label', t.library.onMapInk, t.library.onMap, TEXT],
    ['muted on background (row captions)', t.inkMuted, t.background, TEXT],
    ['ink variant on background (row names)', t.inkVariant, t.background, TEXT],
    // Connected sources (#432/#435).
    ['Strava glyph on its tile', t.connect.onBrand, t.connect.brand, GRAPHIC],
    ['source mark on surface', t.connect.mark, t.surface, TEXT],
    ['source mark on background', t.connect.mark, t.background, TEXT],
    ['pause notice text', t.connect.noticeInk, t.connect.notice, TEXT],
    ['pause notice icon', t.status.pausedInk, t.connect.notice, GRAPHIC],
    ['import progress on its track', t.connect.progress, t.connect.progressTrack, GRAPHIC],
    ['scope pill label', t.library.onMapInk, t.library.onMap, TEXT],
    // Map explorer (#447).
    ...Object.entries(t.explore.terrain).map(([name, ground]): [string, string, string, number] => [
      `terrain tile label on ${name}`,
      t.explore.terrainInk,
      ground,
      TEXT,
    ]),
    ['collection badge glyph', t.explore.collectionBadgeInk, t.explore.collectionBadge, GRAPHIC],
    ...t.explore.sourceBadges.map((ground, i): [string, string, string, number] => [
      `publisher badge initials ${i}`,
      t.explore.sourceBadgeInk,
      ground,
      TEXT,
    ]),
    ['activity glyph on surface', t.explore.accent, t.surface, GRAPHIC],
    ['explorer link on background', t.explore.accent, t.background, TEXT],
    ['cluster count on cluster', t.explore.clusterInk, t.explore.cluster, TEXT],
    ['cluster ring around cluster', t.explore.clusterRing, t.explore.cluster, GRAPHIC],
    // Long-distance trails (#467).
    ['trail stage number on its disc', t.explore.trailBadgeInk, t.explore.trailBadge, TEXT],
    ['trail line on its thumbnail', t.explore.trail, t.explore.trailThumb, GRAPHIC],
    ['trail line on its halo', t.explore.trail, t.explore.trailHalo, GRAPHIC],
    ['selected stage on its halo', t.explore.trailStage, t.explore.trailHalo, GRAPHIC],
    // Support Inukshuk (#476).
    ['support card / Tip button label', t.support.onAccent, t.support.accent, TEXT],
    ['support link on background', t.support.link, t.background, TEXT],
    ['tip icon on a tier', t.support.link, t.surface, GRAPHIC],
    ['tip icon on the chosen tier', t.support.link, t.support.selected, GRAPHIC],
    ['tier name on the chosen tier', t.ink, t.support.selected, TEXT],
    ['tier blurb on the chosen tier', t.inkMuted, t.support.selected, TEXT],
    ['chosen tier border', t.support.selectedBorder, t.surface, GRAPHIC],
    ['progress fill on its track', t.support.progress, t.support.progressTrack, GRAPHIC],
    ['thank-you stones on background', t.support.stone, t.background, GRAPHIC],
    ['thank-you deep stones on background', t.support.stoneDeep, t.background, GRAPHIC],
    ['tip button cairn on stone', t.support.cairnLight, palette.stone, GRAPHIC],
    ['tip button coin on stone', t.support.coin, palette.stone, GRAPHIC],
    ['tip button heart on surface', t.support.heart, t.surface, GRAPHIC],
    ['tip button stone heart on surface', t.support.stone, t.surface, GRAPHIC],
  ];
}

describe.each([
  ['light', lightScheme],
  ['stone night', darkScheme],
  ['sunlight', sunlightScheme],
  ['night red', nightScheme],
])('%s contrast, as used', (_name, scheme) => {
  it.each(pairs(scheme))('%s', (_label, fg, bg, min) => {
    for (const ground of asDrawn(fg, bg)) {
      expect(contrastRatio(fg, ground)).toBeGreaterThanOrEqual(min);
    }
  });
});

describe('year-in-review empty days read on dark cards', () => {
  it.each([
    ['stone night', darkScheme],
    ['sunlight', sunlightScheme],
    ['night red', nightScheme],
  ])('%s: the empty-day outline is 3:1 on the card', (_name, scheme) => {
    expect(contrastRatio(scheme.stats.dayEmptyOutline, scheme.surface)).toBeGreaterThanOrEqual(
      GRAPHIC,
    );
  });
});

describe('type scale', () => {
  it.each(Object.entries(type))('%s is at least the 12 dp floor', (_name, style) => {
    expect(style.fontSize).toBeGreaterThanOrEqual(MIN_FONT_SIZE);
  });
});
