import { IMPERIAL, METRIC, NAUTICAL } from '@core/format';
import { useSettingsStore } from '@state/settingsStore';
import { darkTheme, lightTheme } from '@ui/theme';
import { schemeTokens } from '@ui/tokens';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { UnitsSetting, unitsDescription, unitsSample } from './UnitsSetting';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

async function renderSetting(dark = false) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <PaperProvider theme={dark ? darkTheme : lightTheme}>
        <UnitsSetting />
      </PaperProvider>
    </SafeAreaProvider>,
  );
}

const checked = (id: string) =>
  (screen.getByTestId(id).props.accessibilityState as { checked?: boolean }).checked;

const colorOf = (node: { props: { style?: unknown } }) =>
  (StyleSheet.flatten(node.props.style as never) as { color?: string } | undefined)?.color;

describe('Settings › Display › Units (#702)', () => {
  beforeEach(async () => {
    await useSettingsStore.getState().hydrate();
    useSettingsStore.setState({ units: METRIC });
  });

  it.each([['light'], ['dark']])(
    'one row that opens a sub-panel with Distance and Elevation (%s)',
    async (theme) => {
      const dark = theme === 'dark';
      await renderSetting(dark);
      expect(screen.getByText('Units')).toBeOnTheScreen();
      expect(screen.getByText('Kilometres · metres')).toBeOnTheScreen();
      expect(screen.queryByTestId('units-panel')).toBeNull();

      await fireEvent.press(screen.getByTestId('units-row'));
      expect(screen.getByTestId('units-panel')).toBeOnTheScreen();
      for (const label of ['Distance', 'Elevation', 'km', 'mi', 'NM', 'm', 'ft']) {
        expect(screen.getByText(label)).toBeOnTheScreen();
      }
      expect(checked('units-distance-km')).toBe(true);
      expect(checked('units-elevation-m')).toBe(true);
      // Ink from the theme, so the panel reads in both schemes.
      const theme0 = dark ? darkTheme : lightTheme;
      expect(colorOf(screen.getByText('Distance'))).toBe(theme0.colors.onSurface);
      expect(colorOf(screen.getByText(/^Speed and pace follow/))).toBe(schemeTokens(dark).inkMuted);
    },
  );

  it('switches distance and elevation independently, and the sample follows', async () => {
    await renderSetting();
    await fireEvent.press(screen.getByTestId('units-row'));

    await fireEvent.press(screen.getByTestId('units-distance-nmi'));
    expect(useSettingsStore.getState().units).toEqual(NAUTICAL);
    expect(screen.getByTestId('units-sample')).toHaveTextContent(unitsSample(NAUTICAL));

    await fireEvent.press(screen.getByTestId('units-elevation-ft'));
    expect(useSettingsStore.getState().units).toEqual({ distance: 'nmi', elevation: 'ft' });
    expect(checked('units-distance-nmi')).toBe(true);
    expect(checked('units-elevation-ft')).toBe(true);

    await fireEvent.press(screen.getByTestId('units-distance-mi'));
    expect(useSettingsStore.getState().units).toEqual(IMPERIAL);
    expect(screen.getByText('Miles · feet')).toBeOnTheScreen();
  });

  it('closes with the back button', async () => {
    await renderSetting();
    await fireEvent.press(screen.getByTestId('units-row'));
    await fireEvent.press(screen.getByLabelText('Back to settings'));
    expect(screen.queryByTestId('units-panel')).toBeNull();
  });

  it('re-selecting the current unit writes nothing', async () => {
    const storage = jest.requireMock<{ writeJson: jest.Mock }>('@data/storage');
    await renderSetting();
    await fireEvent.press(screen.getByTestId('units-row'));
    storage.writeJson.mockClear();
    await act(async () => {
      useSettingsStore.getState().set('units', { distance: 'km', elevation: 'm' });
    });
    expect(storage.writeJson).not.toHaveBeenCalled();
  });

  it('describes and samples every pair', () => {
    expect(unitsDescription(NAUTICAL)).toBe('Nautical miles · metres');
    expect(unitsSample(METRIC)).toBe('8.42 km · 120 m away · climb 640 m · 4.5 km/h');
    expect(unitsSample(IMPERIAL)).toBe('5.23 mi · 394 ft away · climb 2100 ft · 2.8 mph');
    expect(unitsSample({ distance: 'nmi', elevation: 'ft' })).toBe(
      '4.55 NM · 394 ft away · climb 2100 ft · 2.4 kn',
    );
  });
});
