/**
 * Map chrome at every Display size (#760): the 40 dp disc scales, its touch
 * box never drops under 48; the search pill is drawn at the size and touched
 * at 48 or more; a hold button smaller than 48 answers through its hitSlop.
 */
import { DISPLAY_SCALES, scaleSize } from '@core/display/displayScale';
import { useSettingsStore } from '@state/settingsStore';
import { render, screen } from '@testing-library/react-native';
import { resolveTheme } from '@ui/theme';
import { pressableCount, smallTouchTargets } from '@ui/touchTargets.testUtils';
import { StyleSheet, View } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { HoldButton } from './HoldButton';
import { MapButton } from './MapButton';
import { MapSearchPill } from './MapSearchPill';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: async () => null }));

afterEach(() => useSettingsStore.getState().reset());

describe.each(DISPLAY_SCALES.map((k) => [k]))('map chrome at Display size %p', (k) => {
  async function show() {
    useSettingsStore.setState({ displayScale: k as 1 });
    await render(
      <PaperProvider theme={resolveTheme('dark', 'normal', k)}>
        <View>
          <MapButton icon="crosshairs" accessibilityLabel="Locate" onPress={() => {}} />
          <MapSearchPill onPress={() => {}} />
          <HoldButton
            size={40}
            onConfirm={() => {}}
            accessibilityLabel="Hold to delete"
            accessibilityHint="Touch and hold"
            trackColor="#444"
            fillColor="#f00"
            background="#000"
          >
            <View />
          </HoldButton>
        </View>
      </PaperProvider>,
    );
  }

  it('every pressable keeps a 48 dp touch target', async () => {
    await show();
    expect(pressableCount(screen.toJSON() as never)).toBeGreaterThanOrEqual(3);
    expect(smallTouchTargets(screen.toJSON() as never)).toEqual([]);
  });

  it('the map button draws its disc at the size inside a 48+ dp box', async () => {
    await show();
    const disc = StyleSheet.flatten(screen.getByTestId('map-button-disc').props.style);
    expect(disc.width).toBe(scaleSize(40, k));
    const box = StyleSheet.flatten(screen.getByLabelText('Locate').props.style);
    expect(box.width).toBe(Math.max(48, scaleSize(48, k)));
  });
});
