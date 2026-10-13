import { useSettingsStore } from '@state/settingsStore';
import { darkTheme, lightTheme } from '@ui/theme';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { CoordinateFormatSetting, coordinateFormatDescription } from './CoordinateFormatSetting';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

async function renderSetting(dark = false) {
  await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <CoordinateFormatSetting />
    </PaperProvider>,
  );
}

describe('Settings › Display › Coordinates (#677)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ coordinateFormat: 'dd' });
  });

  it.each([['light'], ['dark']])(
    'offers the five formats, DD selected, with a live sample (%s)',
    async (theme) => {
      await renderSetting(theme === 'dark');
      for (const label of ['DD', 'DMS', 'DDM', 'UTM', 'MGRS']) {
        expect(screen.getByText(label)).toBeOnTheScreen();
      }
      expect(screen.getByText('Decimal degrees · 46.81394, -71.20761')).toBeOnTheScreen();
      const checked = (id: string) =>
        (
          screen.getByTestId(`coordinate-format-${id}`).props.accessibilityState as {
            checked?: boolean;
          }
        ).checked;
      expect(checked('dd')).toBe(true);
      expect(checked('mgrs')).toBe(false);
    },
  );

  it('picking a format stores it and updates the sample', async () => {
    await renderSetting();
    await act(async () => {
      fireEvent.press(screen.getByTestId('coordinate-format-mgrs'));
    });
    expect(useSettingsStore.getState().coordinateFormat).toBe('mgrs');
    expect(screen.getByText('MGRS · 19T CM 31586 86854')).toBeOnTheScreen();
  });

  it('describes every format with its name and a sample', () => {
    expect(coordinateFormatDescription('dms')).toBe(
      'Degrees, minutes, seconds · 46°48′50.2″N, 71°12′27.4″W',
    );
    expect(coordinateFormatDescription('ddm')).toBe(
      'Degrees, decimal minutes · 46°48.836′N, 71°12.457′W',
    );
    expect(coordinateFormatDescription('utm')).toBe('UTM · 19T 331586 5186854');
  });
});
