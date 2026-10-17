/**
 * The G7 team screens fit a 360 dp phone at the font scales the owner checks
 * (1.15× for map chrome and chips, which cap there, and 1.3× for screen
 * text): nothing new is cut off (owner 2026-10-16), at every Display size
 * (#760: Small 85 %, Default 100 %, Large 115 %; text scales by the size,
 * spacing by its 1.5 power, boxes by the size).
 *
 * Widths are the real advances of Atkinson Hyperlegible Next, measured from
 * `assets/fonts/*.ttf` (PIL `ImageFont.getlength`, in em), not guesses:
 *
 *   python3 -c "from PIL import ImageFont; f=ImageFont.truetype(
 *     'assets/fonts/AtkinsonHyperlegibleNext_700Bold.ttf', 100);
 *     print(f.getlength('Out of reach') / 100)"
 */
import {
  DISPLAY_SCALES,
  osFontCap,
  scaleFontSize,
  scaleSize,
  scaleSpacing,
} from '@core/display/displayScale';

import { PILL_FONT_CAP, PILL_GLYPH, PILL_STATUS_GAP, pillTextRoom } from './bar/TeamStatusBar';
import { LINK_FONT_CAP } from './components';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: async () => null }));
jest.mock('@data/team/appTeam', () => ({
  teamAvailability: () => 'ok',
  appTeamService: () => null,
}));
jest.mock('expo-router', () => ({ useRouter: () => ({}), useLocalSearchParams: () => ({}) }));

/** Measured advances, em (weight in the key). */
const EM: Record<string, number> = {
  '800 6/6': 1.74,
  '800 12/12': 2.54,
  '700  online ·': 3.83,
  '700 Offline · 120 min': 7.92,
  '700 Out of reach': 5.84,
  '700 Needs update': 6.56,
  '700 Relayed': 3.78,
  '400 2 min': 2.47,
  '400 34 min ago': 5.04,
  '400 48 kB in': 3.69,
  '800 4.8 km S': 4.33,
  '400 Internet + nearby': 7.73,
  '400 No internet · nearby': 8.75,
  '600 Member': 3.87,
  '700 Julie Lapointe': 6.72,
  '700 Marc-André': 5.48,
  '700 Marc-André (you)': 8.12,
};

const SCREEN = 360;
const CHIP_SP = 11;

describe.each(DISPLAY_SCALES.map((k) => [k]))('360 dp fit (G7) at Display size %p', (k) => {
  /**
   * A text's advance: its size at the Display size, times the OS font scale,
   * which at Large is held so the two together stay within the caps (#760).
   */
  const os = (scale: number, cap?: number) => Math.min(scale, osFontCap(k, cap) ?? scale);
  const w = (key: string, sp: number, scale: number, cap?: number) =>
    EM[key]! * scaleFontSize(sp, k) * os(scale, cap);
  const s = (n: number) => scaleSpacing(n, k);
  const b = (n: number) => scaleSize(n, k);
  /** A link chip: icon 12, gap 3, padding 4 + 6, its text. */
  const chip = (key: string, scale: number) =>
    b(12) + s(3) + s(10) + w(key, CHIP_SP, Math.min(scale, LINK_FONT_CAP), LINK_FONT_CAP);
  const pill = Math.min(1.15, PILL_FONT_CAP);
  /** Pill text: capped at PILL_FONT_CAP. */
  const wp = (key: string) => w(key, 12, pill, PILL_FONT_CAP);

  // The status is one text, "6/6 online ·" (#756), then the glyph (G7).
  it('the pill: "6/6 online ·" and the glyph with three faces; "12/12 online ·" too', () => {
    const room = pillTextRoom(SCREEN, 3, k);
    const status = (count: string) =>
      wp(count) + wp('700  online ·') + s(PILL_STATUS_GAP) + b(PILL_GLYPH);
    expect(status('800 6/6')).toBeLessThanOrEqual(room);
    expect(status('800 12/12')).toBeLessThanOrEqual(room);
  });

  it('the pill offline: one face, "Offline · 120 min"', () => {
    const room = pillTextRoom(SCREEN, 1, k);
    expect(b(PILL_GLYPH) + s(PILL_STATUS_GAP) + wp('700 Offline · 120 min')).toBeLessThanOrEqual(
      room,
    );
  });

  /**
   * Owner rule (#760): if it fits, it fits. A secondary line (a link chip and
   * its age) stays on one line at Small and Default; at Large it may wrap to
   * a second line at full size, since there it truly does not fit. Names and
   * distances stay on one line at every size.
   */
  const maxLines = k > 1 ? 2 : 1;
  /** Lines a wrapping row of `parts` takes in `room` (greedy, `gap` between). */
  const wrapLines = (parts: number[], gap: number, room: number) => {
    let lines = 1;
    let used = 0;
    for (const part of parts) {
      expect(part).toBeLessThanOrEqual(room);
      if (used > 0 && used + gap + part > room) {
        lines += 1;
        used = part;
      } else used += (used > 0 ? gap : 0) + part;
    }
    return lines;
  };

  it('a panel row at 1.3×: the name and distance on one line; the chip and its age', () => {
    // Panel 12 dp from each edge; row padding 14, avatar 36 + 12, chevron 20 + 12.
    const text =
      SCREEN -
      2 * s(12) -
      2 * s(14) -
      b(36) -
      s(12) -
      b(20) -
      s(12) -
      w('800 4.8 km S', 13.5, 1.3) -
      s(12);
    // A 14-character name on one line: at 1.3× at Small and Default; at Large
    // at the default OS font (at 1.3× there, names past ~10 characters, like
    // "Marc-André", ellipsize: a long user-entered name may).
    const nameRoom = (os: number) =>
      SCREEN -
      2 * s(12) -
      2 * s(14) -
      b(36) -
      s(12) -
      b(20) -
      s(12) -
      w('800 4.8 km S', 13.5, os) -
      s(12);
    expect(w('700 Julie Lapointe', 15, 1)).toBeLessThanOrEqual(nameRoom(1));
    if (k <= 1) expect(w('700 Julie Lapointe', 15, 1.3)).toBeLessThanOrEqual(text);
    else expect(w('700 Marc-André', 15, 1.3)).toBeLessThanOrEqual(text);
    expect(
      wrapLines([chip('700 Relayed', 1.3), w('400 2 min', 12.5, 1.3)], s(5), text),
    ).toBeLessThanOrEqual(maxLines);
    // An out-of-reach row shows the chip alone, on one line at every size.
    expect(chip('700 Out of reach', 1.3)).toBeLessThanOrEqual(text);
  });

  it('the panel header chip at 1.3×', () => {
    // Panel 336, padding 14 + 6, faces 26 × 3 overlapped (≈ 64) + 12, close 44.
    const room = SCREEN - 2 * s(12) - s(14) - s(6) - b(64) - s(12) - b(44);
    // The chip: padding 5, glyph 15, gap 5, its text (up to two lines), chevron 15.
    const textRoom = room - s(5) - b(15) - s(5) - b(15);
    const lines = Math.ceil(w('400 No internet · nearby', 12.5, 1.3) / textRoom);
    expect(lines).toBeLessThanOrEqual(maxLines);
  });

  it('a Manage team member line at 1.3×', () => {
    // Screen padding 16, avatar 40 + 12, role chip and its gap.
    const role = w('600 Member', 12, 1.3) + s(16) + s(12);
    const text = SCREEN - 2 * s(16) - b(40) - s(12) - role;
    expect(w('700 Marc-André (you)', 14, 1.3)).toBeLessThanOrEqual(text);
    for (const [link, line] of [
      ['700 Relayed', '400 48 kB in'],
      ['700 Out of reach', '400 34 min ago'],
    ] as const) {
      expect(wrapLines([chip(link, 1.3), w(line, 12, 1.3)], s(5), text)).toBeLessThanOrEqual(
        maxLines,
      );
    }
    expect(chip('700 Needs update', 1.3)).toBeLessThanOrEqual(text);
  });
});
