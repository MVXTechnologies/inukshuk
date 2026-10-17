/**
 * Every segmented row in Settings fits a 360 dp phone at every Display size
 * without an ellipsis (owner: no clipped text). Screenshot review of run
 * 38999011874 caught "MG…" for MGRS at Large: Paper gives each segment an
 * equal share (76 dp at least) and pads its content 16 dp a side. The app's
 * SegmentedButtons (`@ui/paper`) sizes each segment to its label plus an
 * equal share of the rest and keeps SEGMENT_LABEL_PAD of the padding.
 *
 * Widths are the real advances of Atkinson Hyperlegible Next Medium (Paper's
 * labelLarge: 14 sp, weight 500, letter spacing 0.1), measured from
 * `assets/fonts/AtkinsonHyperlegibleNext_500Medium.ttf` (PIL
 * `ImageFont.getlength`, in em), not guesses.
 */
import {
  DISPLAY_SCALES,
  MIN_TEXT_SP,
  scaleFontSize,
  scaleSpacing,
} from '@core/display/displayScale';
import { PAPER_SEGMENT_PAD, SEGMENT_LABEL_PAD, SEGMENT_STYLE } from '@ui/paper';

/** Measured advances, em. */
const EM: Record<string, number> = {
  DD: 1.34,
  DMS: 2.1,
  DDM: 2.17,
  UTM: 2.09,
  MGRS: 2.75,
  '75 %': 2.33,
  '100 %': 2.95,
  '125 %': 2.81,
  '150 %': 2.9,
  System: 3.34,
  Light: 2.3,
  Dark: 2.11,
  '2 m': 1.72,
  '5 m': 1.76,
  '10 m': 2.24,
  '7 ft': 1.49,
  '16 ft': 2.02,
  '33 ft': 2.16,
  'Trail view only': 6.54,
  'Zoomed in': 4.85,
  Always: 3.16,
  'Optimized · 2048 px': 9.35,
  'Full size': 3.78,
  km: 1.4,
  mi: 1.14,
  NM: 1.53,
  m: 0.87,
  ft: 0.69,
};

/** Settings' segmented rows, as they read on screen. */
const ROWS: Record<string, readonly string[]> = {
  coordinates: ['DD', 'DMS', 'DDM', 'UTM', 'MGRS'],
  'pin size': ['75 %', '100 %', '125 %', '150 %'],
  theme: ['System', 'Light', 'Dark'],
  'GPS spacing (metric)': ['2 m', '5 m', '10 m'],
  'GPS spacing (imperial)': ['7 ft', '16 ft', '33 ft'],
  'trail photos on the map': ['Trail view only', 'Zoomed in', 'Always'],
  'photo quality': ['Optimized · 2048 px', 'Full size'],
  'distance units': ['km', 'mi', 'NM'],
  'elevation units': ['m', 'ft'],
};

const SCREEN = 360;
/** Settings rows sit 16 dp (spacing) from each edge. */
const ROW_INSET = 16;
/** Paper's segment border, each side. */
const BORDER = 1;
const LABEL_SP = 14;
const LETTER_SPACING = 0.1;

const labelWidth = (label: string, k: number) =>
  EM[label]! * scaleFontSize(LABEL_SP, k) + LETTER_SPACING * k * label.length;

describe('Settings segmented rows fit 360 dp without an ellipsis', () => {
  it('sizes each segment to its label (not Paper’s equal shares and 76 dp minimum)', () => {
    expect(SEGMENT_STYLE).toMatchObject({ flexBasis: 'auto', minWidth: 0, flexGrow: 1 });
    expect(SEGMENT_LABEL_PAD).toBeLessThan(PAPER_SEGMENT_PAD);
  });

  for (const k of DISPLAY_SCALES) {
    it.each(Object.entries(ROWS))(`at ${k * 100} %: %s`, (_row, labels) => {
      // Never below the 10 sp floor.
      expect(scaleFontSize(LABEL_SP, k)).toBeGreaterThanOrEqual(MIN_TEXT_SP);
      const room = SCREEN - 2 * scaleSpacing(ROW_INSET, k);
      const pad = scaleSpacing(SEGMENT_LABEL_PAD, k);
      // Every segment at its natural width: nothing has to shrink.
      const natural = labels.reduce((sum, l) => sum + labelWidth(l, k) + 2 * pad + 2 * BORDER, 0);
      expect(natural).toBeLessThanOrEqual(room);
    });
  }
});
