/**
 * The G7 team screens fit a 360 dp phone at the font scales the owner checks
 * (1.15× for map chrome and chips, which cap there, and 1.3× for screen
 * text): nothing new is cut off (owner 2026-10-16).
 *
 * Widths are the real advances of Atkinson Hyperlegible Next, measured from
 * `assets/fonts/*.ttf` (PIL `ImageFont.getlength`, in em), not guesses:
 *
 *   python3 -c "from PIL import ImageFont; f=ImageFont.truetype(
 *     'assets/fonts/AtkinsonHyperlegibleNext_700Bold.ttf', 100);
 *     print(f.getlength('Out of reach') / 100)"
 */
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
};
const w = (key: string, sp: number, scale: number) => EM[key]! * sp * scale;

const SCREEN = 360;
const CHIP_SP = 11;
/** A link chip: icon 12, gap 3, padding 4 + 6, its text. */
const chip = (key: string, scale: number) =>
  12 + 3 + 10 + w(key, CHIP_SP, Math.min(scale, LINK_FONT_CAP));

describe('360 dp fit (G7)', () => {
  const pill = Math.min(1.15, PILL_FONT_CAP);

  // The status is one text, "6/6 online ·" (#756), then the glyph (G7).
  it('the pill: "6/6 online ·" and the glyph with three faces; "12/12 online ·" too', () => {
    const room = pillTextRoom(SCREEN, 3);
    const status = (count: string) =>
      w(count, 12, pill) + w('700  online ·', 12, pill) + PILL_STATUS_GAP + PILL_GLYPH;
    expect(status('800 6/6')).toBeLessThanOrEqual(room);
    expect(status('800 12/12')).toBeLessThanOrEqual(room);
  });

  it('the pill offline: one face, "Offline · 120 min"', () => {
    const room = pillTextRoom(SCREEN, 1);
    expect(PILL_GLYPH + PILL_STATUS_GAP + w('700 Offline · 120 min', 12, pill)).toBeLessThanOrEqual(
      room,
    );
  });

  it('a panel row at 1.3×: the chip and its age next to a distance', () => {
    // Panel 12 dp from each edge; row padding 14, avatar 36 + 12, chevron 20 + 12.
    const text = SCREEN - 24 - 28 - 48 - 32 - w('800 4.8 km S', 13.5, 1.3) - 12;
    expect(chip('700 Relayed', 1.3) + 5 + w('400 2 min', 12.5, 1.3)).toBeLessThanOrEqual(text);
    // An out-of-reach row shows the chip alone.
    expect(chip('700 Out of reach', 1.3)).toBeLessThanOrEqual(text);
  });

  it('the panel header chip at 1.3×', () => {
    // Panel 336, padding 14 + 6, faces 26 × 3 overlapped (≈ 64) + 12, close 44.
    const room = SCREEN - 24 - 20 - 64 - 12 - 44;
    expect(5 + 15 + 5 + w('400 No internet · nearby', 12.5, 1.3) + 15).toBeLessThanOrEqual(room);
  });

  it('a Manage team member line at 1.3×', () => {
    // Screen padding 16, avatar 40 + 12, role chip and its gap.
    const role = w('600 Member', 12, 1.3) + 16 + 12;
    const text = SCREEN - 32 - 52 - role;
    expect(chip('700 Relayed', 1.3) + 5 + w('400 48 kB in', 12, 1.3)).toBeLessThanOrEqual(text);
    expect(chip('700 Out of reach', 1.3) + 5 + w('400 34 min ago', 12, 1.3)).toBeLessThanOrEqual(
      text,
    );
    expect(chip('700 Needs update', 1.3)).toBeLessThanOrEqual(text);
  });
});
