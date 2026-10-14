import type { StripValue } from '@core/infoStrip/types';
import { darkScheme, lightScheme } from '@ui/tokens';
import { darkTheme, lightTheme } from '@ui/theme';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { PixelRatio, StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { StripField } from './StripField';

// The field reads the theme once per render: counting those reads counts its renders.
const renders = { n: 0 };
jest.mock('@ui/useSchemeTokens', () => {
  const actual = jest.requireActual('@ui/useSchemeTokens');
  return {
    ...actual,
    useSchemeTokens: () => {
      renders.n += 1;
      return actual.useSchemeTokens();
    },
  };
});

function Tree({
  value,
  dark = false,
  muted = false,
}: {
  value: StripValue;
  dark?: boolean;
  muted?: boolean;
}) {
  return (
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <StripField value={value} muted={muted} testID="f" textTestID="t" />
    </PaperProvider>
  );
}

const ink = () => StyleSheet.flatten(screen.getByTestId('t').props.style).color as string;

describe('StripField (the one renderer)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('draws tag, value and unit', async () => {
    await render(<Tree value={{ tag: 'ETE', value: '0:21' }} />);
    expect(screen.getByTestId('f')).toHaveTextContent('ETE0:21');
    await render(<Tree value={{ glyph: 'speed', value: '3.6', unit: 'km/h' }} />);
    expect(screen.getByTestId('t')).toHaveTextContent('3.6 km/h');
  });

  it.each([
    ['light', false, lightScheme],
    ['dark', true, darkScheme],
  ] as const)('inks plain, ok (sage) and warn (amber) values in %s', async (_n, dark, s) => {
    await render(<Tree value={{ value: '1.2' }} dark={dark} />);
    expect(ink()).toBe(s.ink);
    await render(<Tree value={{ value: 'On trail', tone: 'ok' }} dark={dark} />);
    expect(ink()).toBe(s.status.gnssFixed);
    await render(<Tree value={{ value: 'Off 62', unit: 'm', tone: 'warn' }} dark={dark} />);
    expect(ink()).toBe(s.status.pausedInk);
  });

  it.each([
    ['light', false, lightScheme],
    ['dark', true, darkScheme],
  ] as const)(
    'a muted value (not live) is muted italic, whatever its tone, in %s',
    async (_n, dark, s) => {
      await render(<Tree value={{ value: 'On trail', tone: 'ok' }} dark={dark} muted />);
      expect(StyleSheet.flatten(screen.getByTestId('t').props.style)).toMatchObject({
        color: s.inkMuted,
        fontStyle: 'italic',
      });
    },
  );

  it('fitted to a narrow cell, gives up its tag and keeps the value whole (QA 02b)', async () => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1);
    const cog = { glyph: 'navigation', tag: 'COG', value: '300°', unit: 'NW' };
    await render(
      <PaperProvider theme={lightTheme}>
        <StripField value={cog} fit testID="f" textTestID="t" />
      </PaperProvider>,
    );
    // Before layout: whole.
    expect(screen.getByText('COG')).toBeOnTheScreen();
    expect(screen.getByTestId('t')).toHaveTextContent('300° NW');
    await fireEvent(screen.getByTestId('f'), 'layout', {
      nativeEvent: { layout: { width: 84, height: 30 } },
    });
    expect(screen.getByTestId('t')).toHaveTextContent('300° NW');
    expect(screen.queryByText('COG')).toBeNull();
    expect(screen.getByTestId('t').props.adjustsFontSizeToFit).toBe(true);
    // Narrower: a type step and no compass point; the value itself is never cut.
    await fireEvent(screen.getByTestId('f'), 'layout', {
      nativeEvent: { layout: { width: 50, height: 30 } },
    });
    expect(screen.getByTestId('t')).toHaveTextContent(/^300°$/);
    expect(StyleSheet.flatten(screen.getByTestId('t').props.style).fontSize).toBeLessThan(13);
  });

  it('is memoised on the CONTENT of its value: an equal new object does not render', async () => {
    const { rerender } = await render(<Tree value={{ value: '3.6', unit: 'km/h' }} />);
    renders.n = 0;
    // Ten ticks that compute the same text: zero renders.
    for (let i = 0; i < 10; i++) await rerender(<Tree value={{ value: '3.6', unit: 'km/h' }} />);
    expect(renders.n).toBe(0);
    // One that changes it: one render.
    await rerender(<Tree value={{ value: '3.7', unit: 'km/h' }} />);
    expect(renders.n).toBe(1);
    expect(screen.getByTestId('t')).toHaveTextContent('3.7 km/h');
  });
});
