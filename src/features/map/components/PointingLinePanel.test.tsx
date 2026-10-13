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
  useSettingsStore.setState({ pointingLine: DEFAULT_POINTING_LINE });
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
      text: '500',
    });
    expect(screen.getByText('From you · heading · 500 m · ticks every 50 m')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Show pointing line'));
    expect(cfg().enabled).toBe(true);
    await fireEvent.press(screen.getByLabelText('Back to overlays'));
    expect(onBack).toHaveBeenCalledTimes(1);
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
  });
});
