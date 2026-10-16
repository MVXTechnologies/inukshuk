/**
 * Settings › Display › Display size (#760): three segments, applied at once,
 * persisted; the row fits a 360 dp phone at every size, and every segment
 * keeps a 48 dp touch target at Small.
 *
 * Label widths are the real advances of Atkinson Hyperlegible Next, in em,
 * measured from `assets/fonts/*.ttf` (PIL `ImageFont.getlength`):
 *   Medium (500): Small 2.59, Default 3.29, Large 2.57; ExtraBold (800) "A" 0.70.
 */
import {
  DISPLAY_SCALES,
  scaleFontSize,
  scaleSpacing,
  type DisplayScale,
} from '@core/display/displayScale';
import { useSettingsStore } from '@state/settingsStore';
import { lightTheme, resolveTheme } from '@ui/theme';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import {
  DisplaySizeSetting,
  SIZE_GLYPH_GAP,
  SIZE_GLYPH_SP,
  SIZE_LABEL_FONT_CAP,
  SIZE_LABEL_SP,
  SIZE_SEGMENT_PAD,
} from './DisplaySizeSetting';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));
const storage = jest.requireMock('@data/storage') as { writeJson: jest.Mock };

function Host() {
  // The app's root: the Paper theme follows the setting.
  const k = useSettingsStore((s) => s.displayScale);
  return (
    <PaperProvider theme={resolveTheme('light', 'normal', k)}>
      <DisplaySizeSetting />
    </PaperProvider>
  );
}

const checked = (v: number) =>
  (screen.getByTestId(`display-size-${v}`).props.accessibilityState as { checked?: boolean })
    .checked;

const segmentStyle = (v: number) =>
  StyleSheet.flatten(screen.getByTestId(`display-size-${v}`).props.style) as {
    minHeight?: number;
    paddingHorizontal?: number;
  };

// Writes only start once the store has read its file.
beforeAll(async () => {
  await useSettingsStore.getState().hydrate();
});
beforeEach(() => useSettingsStore.getState().reset());

describe('Settings › Display › Display size (#760)', () => {
  it('shows Default selected out of the box', async () => {
    await render(<Host />);
    expect(screen.getByText('Display size')).toBeTruthy();
    expect(screen.getByText('Small')).toBeTruthy();
    expect(screen.getByText('Default')).toBeTruthy();
    expect(screen.getByText('Large')).toBeTruthy();
    expect([checked(0.85), checked(1), checked(1.15)]).toEqual([false, true, false]);
  });

  it('a tap applies and persists the size, and the row itself redraws at it', async () => {
    await render(<Host />);
    expect(segmentStyle(1).paddingHorizontal).toBe(SIZE_SEGMENT_PAD);
    await act(async () => fireEvent.press(screen.getByTestId('display-size-0.85')));
    expect(useSettingsStore.getState().displayScale).toBe(0.85);
    expect(storage.writeJson).toHaveBeenLastCalledWith(
      'settings.json',
      expect.objectContaining({ displayScale: 0.85 }),
    );
    expect(checked(0.85)).toBe(true);
    // The live preview: the Settings row is already at 85 %.
    expect(segmentStyle(0.85).paddingHorizontal).toBe(scaleSpacing(SIZE_SEGMENT_PAD, 0.85));
    await act(async () => fireEvent.press(screen.getByTestId('display-size-1.15')));
    expect(useSettingsStore.getState().displayScale).toBe(1.15);
    expect(segmentStyle(1.15).paddingHorizontal).toBe(scaleSpacing(SIZE_SEGMENT_PAD, 1.15));
  });

  it('names each segment with its size for screen readers', async () => {
    await render(<Host />);
    expect(screen.getByLabelText('Small, 85 %')).toBeTruthy();
    expect(screen.getByLabelText('Default, 100 %')).toBeTruthy();
    expect(screen.getByLabelText('Large, 115 %')).toBeTruthy();
  });

  it.each(DISPLAY_SCALES.map((v) => [v]))(
    'every segment keeps a 48 dp touch target at %p',
    async (k) => {
      useSettingsStore.getState().set('displayScale', k);
      await render(<Host />);
      for (const v of DISPLAY_SCALES) {
        expect(segmentStyle(v).minHeight).toBeGreaterThanOrEqual(48);
      }
    },
  );

  it('renders without a provider-scaled theme too (tests and previews)', async () => {
    await render(
      <PaperProvider theme={lightTheme}>
        <DisplaySizeSetting />
      </PaperProvider>,
    );
    expect(checked(1)).toBe(true);
  });
});

describe('360 dp fit at every size, OS font up to the cap', () => {
  const LABEL_EM: Record<DisplayScale, number> = { 0.85: 2.59, 1: 3.29, 1.15: 2.57 };
  const GLYPH_EM = 0.7;
  const SCREEN = 360;

  it.each(DISPLAY_SCALES.map((k) => [k]))('at %p the widest segment fits', (k) => {
    const os = SIZE_LABEL_FONT_CAP;
    // Row inset 16 a side and the 1 dp outline, split in three.
    const segment = (SCREEN - 2 * scaleSpacing(16, k) - 2) / 3;
    for (const v of DISPLAY_SCALES) {
      const content =
        2 * scaleSpacing(SIZE_SEGMENT_PAD, k) +
        GLYPH_EM * scaleFontSize(SIZE_GLYPH_SP[v], k) * os +
        scaleSpacing(SIZE_GLYPH_GAP, k) +
        LABEL_EM[v] * scaleFontSize(SIZE_LABEL_SP, k) * os;
      expect(content).toBeLessThanOrEqual(segment);
    }
  });
});
