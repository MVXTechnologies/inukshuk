import { render, screen, userEvent } from '@testing-library/react-native';
import { DefaultTheme, PlatformPressable, ThemeProvider } from 'expo-router/react-navigation';
import type { ReactElement } from 'react';
import { Text } from 'react-native';

import { TabBarButton } from './TabBarButton';

// The gnss.yaml flake: a quick tap whose release reaches JS more than 500 ms
// after its press-in, because the UI thread stalled between DOWN and UP. To
// Pressability that is a held press (its long-press timer is a JS timeout),
// which is exactly what a 600 ms press models here.
const LATE_RELEASE_MS = 600;
const LABEL = 'Library, tab, 2 of 4';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

async function renderInTheme(ui: ReactElement) {
  await render(<ThemeProvider value={DefaultTheme}>{ui}</ThemeProvider>);
  return userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
}

describe('TabBarButton', () => {
  it("reproduces the race on the library's own button: a late release is lost to onLongPress", async () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    const user = await renderInTheme(
      <PlatformPressable onPress={onPress} onLongPress={onLongPress} aria-label={LABEL}>
        <Text>Library</Text>
      </PlatformPressable>,
    );
    await user.longPress(screen.getByLabelText(LABEL), { duration: LATE_RELEASE_MS });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('switches the tab even when the release arrives late', async () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    const user = await renderInTheme(
      <TabBarButton onPress={onPress} onLongPress={onLongPress} aria-label={LABEL}>
        <Text>Library</Text>
      </TabBarButton>,
    );
    await user.longPress(screen.getByLabelText(LABEL), { duration: LATE_RELEASE_MS });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('switches the tab on a plain tap', async () => {
    const onPress = jest.fn();
    const user = await renderInTheme(
      <TabBarButton onPress={onPress} aria-label={LABEL}>
        <Text>Library</Text>
      </TabBarButton>,
    );
    await user.press(screen.getByLabelText(LABEL));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
