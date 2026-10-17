import { act, render, screen } from '@testing-library/react-native';
import { useSettingsStore } from '@state/settingsStore';
import { StyleSheet, Text } from 'react-native';

import { DisplayScaleProvider, useDisplayScale, useScaledStyles } from './displayScale';
import { lightTheme, resolveTheme, scaleTheme } from './theme';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: async () => null }));

const sheet = StyleSheet.create({
  row: { minHeight: 48, paddingHorizontal: 16, borderWidth: 1 },
  label: { fontSize: 16, lineHeight: 22 },
});

function Probe() {
  const styles = useScaledStyles(sheet);
  const { factor, sz, sp, touch, slop } = useDisplayScale();
  return (
    <Text testID="probe">
      {JSON.stringify({
        factor,
        row: styles.row,
        label: styles.label,
        sz: sz(48),
        sp: sp(16),
        touch: touch(48),
        slop: slop(48),
        same: styles === sheet,
      })}
    </Text>
  );
}

const read = () => JSON.parse(String(screen.getByTestId('probe').props.children));

afterEach(() => useSettingsStore.getState().reset());

describe('useScaledStyles / useDisplayScale', () => {
  it('at 100 % hands back the very same sheet', async () => {
    await render(<Probe />);
    expect(read()).toMatchObject({ factor: 1, same: true, sz: 48, sp: 16, touch: 48, slop: 0 });
  });

  it('follows the saved setting without a provider', async () => {
    await render(<Probe />);
    await act(async () => useSettingsStore.getState().set('displayScale', 0.85));
    expect(read()).toEqual({
      factor: 0.85,
      // The tap row keeps its 48 dp; padding shrinks; the hairline doesn't.
      row: { minHeight: 48, paddingHorizontal: 12.5, borderWidth: 1 },
      label: { fontSize: 13.5, lineHeight: 18.5 },
      sz: 41,
      sp: 12.5,
      touch: 48,
      slop: 4,
      same: false,
    });
  });

  it('a provider factor (the live preview) overrides the saved one', async () => {
    useSettingsStore.getState().set('displayScale', 0.85);
    await render(
      <DisplayScaleProvider factor={1.15}>
        <Probe />
      </DisplayScaleProvider>,
    );
    expect(read()).toMatchObject({
      factor: 1.15,
      row: { minHeight: 55, paddingHorizontal: 19.5, borderWidth: 1 },
      label: { fontSize: 18.5, lineHeight: 25.5 },
      sp: 19.5,
      touch: 55,
      slop: 0,
    });
  });

  it('a provider without a factor reads the saved setting', async () => {
    useSettingsStore.getState().set('displayScale', 1.15);
    await render(
      <DisplayScaleProvider>
        <Probe />
      </DisplayScaleProvider>,
    );
    expect(read().factor).toBe(1.15);
  });
});

describe('the Paper theme at a Display size', () => {
  it('is the same theme object at 100 %', () => {
    expect(resolveTheme('light')).toBe(lightTheme);
    expect(resolveTheme('light', 'normal', 1)).toBe(lightTheme);
  });

  it('scales every MD3 variant and keeps the colours', () => {
    const t = resolveTheme('light', 'normal', 0.85);
    expect(t.colors).toBe(lightTheme.colors);
    expect(t.fonts.bodyLarge.fontSize).toBe(13.5);
    expect(t.fonts.bodyLarge.lineHeight).toBe(20.5);
    expect(t.fonts.bodyLarge.fontFamily).toBe(lightTheme.fonts.bodyLarge.fontFamily);
    expect(t.fonts.titleLarge.fontSize).toBe(18.5);
    expect(t.fonts.default).toBe(lightTheme.fonts.default);
  });

  it('is cached per theme and factor, and ignores a junk factor', () => {
    expect(scaleTheme(lightTheme, 1.15)).toBe(scaleTheme(lightTheme, 1.15));
    expect(scaleTheme(lightTheme, NaN)).toBe(lightTheme);
    expect(scaleTheme(lightTheme, 0)).toBe(lightTheme);
    expect(scaleTheme(lightTheme, 1.15).fonts.bodyLarge.fontSize).toBe(18.5);
  });
});
