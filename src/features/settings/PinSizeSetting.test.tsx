import { WAYPOINT_PIN_DIAMETER } from '@core/library/waypointStyle';
import { useSettingsStore } from '@state/settingsStore';
import { darkTheme, lightTheme } from '@ui/theme';
import { schemeTokens } from '@ui/tokens';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { PinSizeSetting } from './PinSizeSetting';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

async function renderSetting(dark = false) {
  await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <PinSizeSetting />
    </PaperProvider>,
  );
}

const checked = (v: number) =>
  (screen.getByTestId(`pin-size-${v}`).props.accessibilityState as { checked?: boolean }).checked;

/** The preview pins' head diameters (WaypointPinView's head is the first width×width box). */
function previewDiameters(): number[] {
  const preview = screen.getByTestId('pin-size-preview');
  const out: number[] = [];
  const walk = (node: { props?: { style?: unknown }; children?: unknown[] } | string) => {
    if (typeof node === 'string') return;
    const s = StyleSheet.flatten(node.props?.style as never) as {
      width?: number;
      height?: number;
      borderRadius?: number;
    } | null;
    if (s && s.width !== undefined && s.width === s.height && s.borderRadius !== undefined) {
      out.push(s.width);
    }
    for (const c of (node.children ?? []) as never[]) walk(c);
  };
  walk(preview as never);
  return out;
}

describe('Settings › Display › Pin size (#686)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ pinScale: 100 });
  });

  it.each([['light'], ['dark']])(
    'offers 75 / 100 / 125 / 150 %, 100 selected, with a preview (%s)',
    async (theme) => {
      await renderSetting(theme === 'dark');
      for (const label of ['75 %', '100 %', '125 %', '150 %']) {
        expect(screen.getByText(label)).toBeOnTheScreen();
      }
      expect(checked(100)).toBe(true);
      expect(checked(150)).toBe(false);
      expect(screen.getByText(/^100 % · scales every pin on the map$/)).toBeOnTheScreen();
      // The preview well is the theme's own variant surface.
      const well = StyleSheet.flatten(screen.getByTestId('pin-size-preview').props.style) as {
        backgroundColor?: string;
      };
      expect(well.backgroundColor).toBe(schemeTokens(theme === 'dark').surfaceVariant);
    },
  );

  it('picking a step stores it and scales the preview', async () => {
    await renderSetting();
    const before = previewDiameters();
    expect(before).toHaveLength(4);
    await act(async () => {
      fireEvent.press(screen.getByTestId('pin-size-150'));
    });
    expect(useSettingsStore.getState().pinScale).toBe(150);
    expect(checked(150)).toBe(true);
    const after = previewDiameters();
    expect(after[3]).toBe(Math.round(WAYPOINT_PIN_DIAMETER.XL * 1.5 * 0.7));
    after.forEach((d, i) => expect(d).toBeGreaterThan(before[i]!));
    // One short line at 150 % too (2.5.2 QA: the subtitle wrapped and pushed the controls).
    const line = screen.getByText('150 % · scales every pin on the map');
    expect(line.props.numberOfLines).toBe(1);
  });

  it('shows a junk stored value as 100 %', async () => {
    useSettingsStore.setState({ pinScale: 110 as never });
    await renderSetting();
    expect(screen.getByText(/^100 % · scales every pin on the map$/)).toBeOnTheScreen();
  });
});
