import { IMPERIAL, METRIC } from '@core/format';
/**
 * Map layers › Map › Pointing line (#681): every option writes the one
 * `pointingLine` setting, the preview and its caption follow, and the page
 * reads right in both themes.
 */
import { DEFAULT_POINTING_LINE } from '@core/map/pointingLineSettings';
import { useSettingsStore } from '@state/settingsStore';
import { darkTheme, lightTheme } from '@ui/theme';
import { darkScheme, lightScheme } from '@ui/tokens';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { PointingLinePanel } from './PointingLinePanel';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: async () => null }));

const onBack = jest.fn();
const cfg = () => useSettingsStore.getState().pointingLine;
const state = (label: string) => screen.getByLabelText(label).props.accessibilityState;

async function mount(dark = false) {
  await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <PointingLinePanel onBack={onBack} />
    </PaperProvider>,
  );
}

beforeEach(() => {
  onBack.mockClear();
  useSettingsStore.setState({ pointingLine: DEFAULT_POINTING_LINE, units: METRIC });
});

describe('PointingLinePanel', () => {
  it('starts with its switch (off), the defaults selected, and goes back', async () => {
    await mount();
    expect(state('Show pointing line').checked).toBe(false);
    expect(screen.getByText('Hidden on the map')).toBeTruthy();
    expect(state('You').selected).toBe(true);
    expect(state('Heading').selected).toBe(true);
    expect(state('Medium').selected).toBe(true);
    expect(state('50 m').selected).toBe(true);
    expect(state('Red').checked).toBe(true);
    expect(state('Label every 5th tick').checked).toBe(false);
    expect(screen.getByLabelText('Length').props.accessibilityValue).toMatchObject({
      now: 2,
      text: '500 m',
    });
    expect(screen.getByText('From you · heading · 500 m · ticks every 50 m')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Show pointing line'));
    expect(cfg().enabled).toBe(true);
    await fireEvent.press(screen.getByLabelText('Back to overlays'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('in imperial, the tick choices and the caption read in round feet', async () => {
    useSettingsStore.setState({ units: IMPERIAL });
    await mount();
    expect(state('200 ft').selected).toBe(true);
    expect(screen.getByLabelText('50 ft')).toBeTruthy();
    expect(screen.getByLabelText('500 ft')).toBeTruthy();
    expect(screen.queryByLabelText('50 m')).toBeNull();
    expect(screen.getByText('From you · heading · 0.5 mi · ticks every 200 ft')).toBeTruthy();
    // The choice is one setting: 500 ft is the 100 m choice.
    await fireEvent.press(screen.getByLabelText('500 ft'));
    expect(cfg().ticks).toBe(100);
  });

  it('in imperial, the length reads in feet and miles everywhere (2.5.1 final QA)', async () => {
    useSettingsStore.setState({ units: IMPERIAL });
    await mount();
    // The slider's value, the caption and the note: no metres anywhere.
    expect(screen.getByLabelText('Length').props.accessibilityValue).toMatchObject({
      now: 2,
      text: '0.5 mi',
    });
    expect(screen.getByText(/so 0\.5 mi is 0\.5 mi on the ground/)).toBeTruthy();
    expect(screen.queryByText(/\b500 m\b/)).toBeNull();
    expect(screen.queryByText(/ km\b/)).toBeNull();
    // Stepping down: 1000 ft, then 500 ft — the stored value stays the metric stop.
    const down = () =>
      act(async () => {
        fireEvent(screen.getByLabelText('Length'), 'accessibilityAction', {
          nativeEvent: { actionName: 'decrement' },
        });
      });
    await down();
    expect(cfg().length).toBe(250);
    expect(screen.getByLabelText('Length').props.accessibilityValue.text).toBe('1000 ft');
    await down();
    expect(cfg().length).toBe(100);
    expect(screen.getByText(/· 500 ft ·/)).toBeTruthy();
    // Back to metric: the same choice, in metres.
    await act(async () => useSettingsStore.setState({ units: METRIC }));
    expect(screen.getByLabelText('Length').props.accessibilityValue.text).toBe('100 m');
    expect(screen.getByText(/so 100 m is 100 m on the ground/)).toBeTruthy();
  });

  it('a fixed bearing: picked, typed in whole degrees, normalised', async () => {
    await mount();
    expect(screen.queryByLabelText('Fixed bearing in degrees')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Fixed 000°'));
    expect(cfg().direction).toBe('fixed');
    const input = screen.getByLabelText('Fixed bearing in degrees');
    await fireEvent.changeText(input, '62');
    expect(cfg().fixedBearingDeg).toBe(62);
    expect(screen.getByLabelText('Fixed 062°')).toBeTruthy();
    // Non-digits are refused; 360 is north.
    await fireEvent.changeText(input, '3a60');
    expect(cfg().fixedBearingDeg).toBe(0);
    await fireEvent.changeText(input, '');
    expect(cfg().fixedBearingDeg).toBe(0);
    await fireEvent(input, 'blur');
    expect(input.props.value).toBe('0');
    expect(screen.getByText('From you · 000° · 500 m · ticks every 50 m')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Course'));
    expect(cfg().direction).toBe('course');
    expect(screen.queryByLabelText('Fixed bearing in degrees')).toBeNull();
  });

  it('length steps from 100 m to the screen edge', async () => {
    await mount();
    const step = (actionName: 'increment' | 'decrement') =>
      act(async () => {
        fireEvent(screen.getByLabelText('Length'), 'accessibilityAction', {
          nativeEvent: { actionName },
        });
      });
    await step('increment');
    expect(cfg().length).toBe(1000);
    await step('increment');
    await step('increment');
    expect(cfg().length).toBe('edge');
    expect(screen.getByText('From you · heading · to the edge · ticks every 50 m')).toBeTruthy();
    for (let i = 0; i < 6; i++) await step('decrement');
    expect(cfg().length).toBe(100);
  });

  it('Custom (#703): the last stop opens a distance field, typed and clamped', async () => {
    await mount();
    const step = () =>
      act(async () => {
        fireEvent(screen.getByLabelText('Length'), 'accessibilityAction', {
          nativeEvent: { actionName: 'increment' },
        });
      });
    expect(screen.queryByLabelText('Custom length in metres')).toBeNull();
    for (let i = 0; i < 4; i++) await step();
    expect(cfg().length).toBe('custom');
    expect(screen.getByLabelText('Length').props.accessibilityValue.text).toBe('Custom');
    const input = screen.getByLabelText('Custom length in metres');
    expect(input.props.value).toBe('750');
    await fireEvent.changeText(input, '1250');
    expect(cfg().customLengthM).toBe(1250);
    expect(screen.getByText('From you · heading · 1.25 km · ticks every 50 m')).toBeTruthy();
    expect(screen.getByText(/so 1\.25 km is 1\.25 km on the ground/)).toBeTruthy();
    // Not a number yet: nothing is written; too short: clamped, shown on leaving.
    await fireEvent.changeText(input, '');
    expect(cfg().customLengthM).toBe(1250);
    await fireEvent.changeText(input, '3');
    expect(cfg().customLengthM).toBe(10);
    await fireEvent(input, 'blur');
    expect(input.props.value).toBe('10');
    // A preset keeps the custom distance for next time.
    await act(async () => {
      fireEvent(screen.getByLabelText('Length'), 'accessibilityAction', {
        nativeEvent: { actionName: 'decrement' },
      });
    });
    expect(cfg().length).toBe('edge');
    expect(cfg().customLengthM).toBe(10);
    expect(screen.queryByLabelText('Custom length in metres')).toBeNull();
  });

  it('Custom in imperial: typed in feet, stored in metres', async () => {
    useSettingsStore.setState({
      units: IMPERIAL,
      pointingLine: { ...DEFAULT_POINTING_LINE, length: 'custom', customLengthM: 457.2 },
    });
    await mount();
    const input = screen.getByLabelText('Custom length in feet');
    expect(input.props.value).toBe('1500');
    expect(screen.getByText('From you · heading · 1500 ft · ticks every 200 ft')).toBeTruthy();
    await fireEvent.changeText(input, '5280');
    expect(cfg().customLengthM).toBeCloseTo(1609.344, 6);
    expect(screen.getByText(/· 1 mi ·/)).toBeTruthy();
  });

  it('colour, width, ticks and labels each write their field only', async () => {
    await mount();
    await fireEvent.press(screen.getByLabelText('Blue'));
    await fireEvent.press(screen.getByLabelText('Bold'));
    await fireEvent.press(screen.getByLabelText('Auto'));
    await fireEvent.press(screen.getByLabelText('Label every 5th tick'));
    expect(cfg()).toEqual({
      ...DEFAULT_POINTING_LINE,
      color: '#1E64C8',
      width: 'bold',
      ticks: 'auto',
      labelEvery5th: true,
    });
    expect(state('Blue').checked).toBe(true);
    expect(state('Red').checked).toBe(false);
    await fireEvent.press(screen.getByLabelText('Off'));
    expect(cfg().ticks).toBe('off');
    expect(screen.getByText('From you · heading · 500 m · no ticks')).toBeTruthy();
  });

  it.each([
    ['light', false, lightScheme],
    ['dark', true, darkScheme],
  ] as const)('reads right in the %s theme', async (_name, dark, scheme) => {
    await mount(dark);
    const preview = StyleSheet.flatten(screen.getByTestId('pointing-line-preview').props.style);
    expect(preview.backgroundColor).toBe(scheme.surfaceVariant);
    // The selected swatch is ringed in the scheme's ink, so it shows on either surface.
    const red = StyleSheet.flatten(screen.getByLabelText('Red').props.style);
    expect(red.borderColor).toBe(scheme.ink);
    const caption = StyleSheet.flatten(
      screen.getByText('From you · heading · 500 m · ticks every 50 m').props.style,
    );
    expect(caption.color).toBe(scheme.inkMuted);
    await fireEvent.press(screen.getByLabelText('Fixed 000°'));
    const input = StyleSheet.flatten(screen.getByLabelText('Fixed bearing in degrees').props.style);
    expect(input.color).toBe(scheme.ink);
    expect(input.backgroundColor).toBe(scheme.surfaceVariant);
    await act(async () =>
      useSettingsStore.setState({
        pointingLine: { ...useSettingsStore.getState().pointingLine, length: 'custom' },
      }),
    );
    const custom = StyleSheet.flatten(screen.getByLabelText('Custom length in metres').props.style);
    expect(custom.color).toBe(scheme.ink);
    expect(custom.backgroundColor).toBe(scheme.surfaceVariant);
  });
});
