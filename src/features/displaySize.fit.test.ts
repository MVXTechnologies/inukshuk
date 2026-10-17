/**
 * "If it fits, it fits" (owner 2026-10-16, #760): the standard labels of the
 * key screens render on one line on a 360 dp phone at Small, Default and
 * Large, with the OS font up to the caps (Display size × OS font within 1.3
 * for screen text, `osFontCap`).
 *
 * Widths are real advances of Atkinson Hyperlegible Next, in em, measured
 * from `assets/fonts/*.ttf` (PIL `ImageFont.getlength`). The team screens and
 * the team pill have their own checks (`team/fit360.test.tsx`), the Display
 * size row its own (`settings/DisplaySizeSetting.test.tsx`).
 */
import { DISPLAY_SCALES, osFontCap } from '@core/display/displayScale';
import { fitsOneLine, rowRoomDp } from '@core/display/textFit';
import { mapChromeAt, teamPillLeft } from '@core/map/mapChrome';

const SCREEN = 360;

/** Measured advances, em (weight 400 unless noted). */
const EM = {
  searchPlaces500: 6.35,
  units: 2.29,
  coordinates: 5.33,
  displaySize: 5.17,
  pinSize: 3.37,
  theme: 3.04,
  displayMode: 5.98,
  compactMapChrome: 9.8,
  showTipButton: 8.66,
  montWrightLoop: 7.68,
  corridorDuLittoral: 8.44,
};

describe.each(DISPLAY_SCALES.map((k) => [k]))('one line at 360 dp, Display size %p', (k) => {
  /** The OS font scale a screen text gets at 1.3× (held at Large). */
  const os = Math.min(1.3, osFontCap(k) ?? 1.3);

  it('the search pill: "Search places" in its slot', () => {
    const chrome = mapChromeAt(k);
    const room = rowRoomDp(
      // At Large the slot runs from the left edge inset to the rail (owner, option a).
      SCREEN - teamPillLeft(chrome, k) - chrome.laneInset,
      { spacing: [16, 10, 16], boxes: [20] },
      k,
    );
    expect(fitsOneLine(EM.searchPlaces500, 16, room, k, os)).toBe(true);
  });

  it('Settings rows: every title beside its chevron or switch', () => {
    // Paper List.Item: 16 left, 24 right; a 52 dp switch and a 16 dp gap.
    const room = rowRoomDp(SCREEN, { spacing: [16, 24, 16], boxes: [52] }, k);
    for (const em of [
      EM.units,
      EM.coordinates,
      EM.displaySize,
      EM.pinSize,
      EM.theme,
      EM.displayMode,
      EM.compactMapChrome,
      EM.showTipButton,
    ]) {
      expect(fitsOneLine(em, 16, room, k, os)).toBe(true);
    }
  });

  it('Library rows: a trail name beside its thumbnail and menu', () => {
    // 16 left, 56 thumbnail + 16 gap, the 44 dp menu.
    const room = rowRoomDp(SCREEN, { spacing: [16, 16], boxes: [56, 44] }, k);
    expect(fitsOneLine(EM.montWrightLoop, 16, room, k, os)).toBe(true);
    expect(fitsOneLine(EM.corridorDuLittoral, 16, room, k, os)).toBe(true);
  });
});
