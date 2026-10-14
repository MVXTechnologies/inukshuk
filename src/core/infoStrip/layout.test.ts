import { DEFAULT_HERO_FIELDS } from '@core/recording/panel';

import {
  fitRow,
  ROW_SPACES,
  STACK_GAP_DP,
  stackOffsets,
  stripHeightDp,
  stripHeroMetrics,
  TAPE_H_DP,
  visibleRows,
  topChromeShiftDp,
  EDITOR_MAX_SHARE,
  editorMaxHeightDp,
} from './layout';
import { ref } from './presets';
import type { FieldRef } from './types';

const unknown: FieldRef = { field: 'weather:wind', params: { gusts: true } };

describe('fitRow (4 spaces, coordinates take 2)', () => {
  it('counts spaces and shows + only while one is free', () => {
    expect(fitRow([])).toEqual({ used: 0, free: 4, plus: true, overflow: false });
    expect(fitRow([ref('coords'), ref('elevation')])).toEqual({
      used: 3,
      free: 1,
      plus: true,
      overflow: false,
    });
    expect(fitRow([ref('coords'), ref('speed'), ref('elevation')])).toEqual({
      used: 4,
      free: 0,
      plus: false,
      overflow: false,
    });
    expect(ROW_SPACES).toBe(4);
  });

  it('skips unknown fields (they take no space) and flags an overflow', () => {
    expect(fitRow([unknown, ref('speed')]).used).toBe(1);
    expect(fitRow([ref('coords'), ref('coords'), ref('speed')])).toEqual({
      used: 5,
      free: 0,
      plus: false,
      overflow: true,
    });
  });
});

describe('visibleRows (the recording rule)', () => {
  const rows = [[ref('coords'), ref('speed'), ref('hero:gain')], [ref('hero:time')]];

  it('draws everything known when not recording', () => {
    expect(visibleRows([[unknown, ...rows[0]!], rows[1]!], DEFAULT_HERO_FIELDS, false)).toEqual(
      rows,
    );
  });

  it("drops the panel's hero metrics while recording; empty rows go", () => {
    // Time · Distance · Gain in the hero row: Gain and Time step aside.
    expect(visibleRows(rows, DEFAULT_HERO_FIELDS, true)).toEqual([[ref('coords'), ref('speed')]]);
    // Cycled to Speed: the strip's speed steps aside instead.
    expect(visibleRows(rows, ['time', 'distance', 'speed'], true)).toEqual([
      [ref('coords'), ref('hero:gain')],
    ]);
  });

  it('lists the hero metrics the strip shows (the hero cycle skips them)', () => {
    expect(stripHeroMetrics([[ref('speed'), ref('coords'), unknown], [ref('hero:pace')]])).toEqual(
      new Set(['speed', 'pace']),
    );
  });
});

describe('stripHeightDp', () => {
  it('30 dp rows, 1 dp dividers, 7 dp padding; +4 on the panel; 0 when empty', () => {
    expect(stripHeightDp(0)).toBe(0);
    expect(stripHeightDp(1)).toBe(37);
    expect(stripHeightDp(3)).toBe(99);
    expect(stripHeightDp(2, true)).toBe(72);
  });
});

describe('stackOffsets', () => {
  const TAB = 84;
  const STRIP = 37;

  it('bottom dock: panel, strip, tape, then the ⓘ + scale row on top', () => {
    expect(stackOffsets('bottom', STRIP, TAB, true)).toEqual({
      stripBottom: TAB,
      stripTop: null,
      tapeBottom: TAB + STRIP + STACK_GAP_DP,
      scaleRowBottom: TAB + STRIP + STACK_GAP_DP + TAPE_H_DP + STACK_GAP_DP,
      topChromeShift: 0,
    });
  });

  it('bottom dock without the tape: the scale row sits on the strip', () => {
    expect(stackOffsets('bottom', STRIP, TAB, false)).toMatchObject({
      tapeBottom: null,
      scaleRowBottom: TAB + STRIP + STACK_GAP_DP,
    });
  });

  it('every layer is lifted by the measured height, whatever the row count', () => {
    const one = stackOffsets('bottom', stripHeightDp(1), TAB, true);
    const three = stackOffsets('bottom', stripHeightDp(3), TAB, true);
    expect(three.scaleRowBottom - one.scaleRowBottom).toBe(stripHeightDp(3) - stripHeightDp(1));
    // On the recording panel instead of the tab bar.
    expect(stackOffsets('bottom', STRIP, 166, false).scaleRowBottom).toBe(166 + STRIP + 8);
  });

  it('top dock: the top chrome shifts down; the bottom keeps 2.5.1 (panel, tape, scale)', () => {
    expect(stackOffsets('top', 50, TAB, true)).toEqual({
      stripBottom: null,
      stripTop: 0,
      tapeBottom: TAB + STACK_GAP_DP,
      scaleRowBottom: TAB + STACK_GAP_DP + TAPE_H_DP + STACK_GAP_DP,
      topChromeShift: 50,
    });
    expect(stackOffsets('top', 50, TAB, false).scaleRowBottom).toBe(TAB + STACK_GAP_DP);
  });

  it('an empty strip lifts nothing', () => {
    expect(stackOffsets('bottom', 0, TAB, false).scaleRowBottom).toBe(TAB + STACK_GAP_DP);
    expect(stackOffsets('top', 0, TAB, false).topChromeShift).toBe(0);
  });
});

describe('topChromeShiftDp (the top dock counts the status bar once)', () => {
  it('moves the chrome by the strip below the status bar', () => {
    // A one-row strip measured with the 40 dp status bar it reaches behind.
    expect(topChromeShiftDp(40 + stripHeightDp(1), 40)).toBe(stripHeightDp(1));
  });

  it('never negative (nothing measured yet, or no strip)', () => {
    expect(topChromeShiftDp(0, 40)).toBe(0);
    expect(topChromeShiftDp(30, 40)).toBe(0);
  });
});

describe('editorMaxHeightDp (the editor fits between the status bar and the lifted bottom)', () => {
  const base = { windowH: 800, areaH: 740, statusBarH: 40, bottomLift: 0, dock: 'bottom' as const };

  it('its share of the window when there is room', () => {
    expect(editorMaxHeightDp(base)).toBe(800 * EDITOR_MAX_SHARE);
  });

  it('on the recording panel: never taller than the room above it, below the status bar', () => {
    expect(editorMaxHeightDp({ ...base, bottomLift: 300 })).toBe(740 - 300 - 40);
  });

  it('top dock: from the top edge down to the lift', () => {
    expect(editorMaxHeightDp({ ...base, dock: 'top', bottomLift: 300 })).toBe(740 - 300);
  });

  it('before the area is measured: the window; never negative', () => {
    expect(editorMaxHeightDp({ ...base, areaH: null, bottomLift: 500 })).toBe(800 - 500 - 40);
    expect(editorMaxHeightDp({ ...base, bottomLift: 900 })).toBe(0);
  });
});
