import type { StripValue } from '@core/infoStrip/types';
import { darkScheme, lightScheme } from '@ui/tokens';
import { darkTheme, lightTheme } from '@ui/theme';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
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

function Tree({ value, dark = false }: { value: StripValue; dark?: boolean }) {
  return (
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <StripField value={value} testID="f" textTestID="t" />
    </PaperProvider>
  );
}

const ink = () => StyleSheet.flatten(screen.getByTestId('t').props.style).color as string;

describe('StripField (the one renderer)', () => {
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
