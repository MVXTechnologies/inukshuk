import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { darkScheme, lightScheme } from '@ui/tokens';
import { darkTheme, lightTheme } from '@ui/theme';
import { act, render, screen } from '@testing-library/react-native';
import { Profiler } from 'react';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { CenterCursor, CURSOR_DOT } from './CenterCursor';

async function renderCursor(suppressed = false, dark = false, commits?: { n: number }) {
  await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <Profiler
        id="cursor"
        onRender={() => {
          if (commits) commits.n += 1;
        }}
      >
        <CenterCursor suppressed={suppressed} />
      </Profiler>
    </PaperProvider>,
  );
}

const dot = () => screen.queryByTestId('map-center-dot', { includeHiddenElements: true });

describe('CenterCursor (#677)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ showCenterCursor: true });
    useMapStore.setState({ followUser: false, mapCenter: null });
  });

  it('is on by default: a 7 dp dot, centred and touch-transparent', async () => {
    await renderCursor();
    const host = screen.getByTestId('map-center-cursor', { includeHiddenElements: true });
    expect(host).toHaveProp('pointerEvents', 'none');
    expect(StyleSheet.flatten(host.props.style as never)).toMatchObject({
      position: 'absolute',
      alignItems: 'center',
      justifyContent: 'center',
    });
    expect(StyleSheet.flatten(dot()?.props.style as never)).toMatchObject({
      width: CURSOR_DOT,
      height: CURSOR_DOT,
    });
    expect(CURSOR_DOT).toBe(7);
    expect(useSettingsStore.getInitialState().showCenterCursor).toBe(true);
  });

  it('hides while the camera follows the user (the puck marks the spot)', async () => {
    await renderCursor();
    expect(dot()).not.toBeNull();
    await act(async () => useMapStore.setState({ followUser: true }));
    expect(dot()).toBeNull();
    await act(async () => useMapStore.setState({ followUser: false }));
    expect(dot()).not.toBeNull();
  });

  it('hides with the setting off', async () => {
    useSettingsStore.setState({ showCenterCursor: false });
    await renderCursor();
    expect(dot()).toBeNull();
    await act(async () => useSettingsStore.setState({ showCenterCursor: true }));
    expect(dot()).not.toBeNull();
  });

  it('hides while suppressed (region selector, map maker)', async () => {
    await renderCursor(true);
    expect(dot()).toBeNull();
  });

  it('never re-renders for camera settles (it is static over a moving map)', async () => {
    const commits = { n: 0 };
    await renderCursor(false, false, commits);
    const mounted = commits.n;
    for (let i = 1; i <= 20; i++) {
      await act(async () =>
        useMapStore.getState().setMapCenter({ latitude: 46 + i / 100, longitude: -71 }),
      );
    }
    expect(commits.n - mounted).toBe(0);
  });

  it.each([
    ['light', false, lightScheme],
    ['dark', true, darkScheme],
  ] as const)('draws a stone dot in a paper ring in %s', async (_n, dark, scheme) => {
    await renderCursor(false, dark);
    expect(StyleSheet.flatten(dot()?.props.style as never)).toMatchObject({
      backgroundColor: scheme.map.cursor,
    });
    expect(scheme.map.cursor).toBe('#1E252C');
    expect(scheme.map.cursorRing).toBe('#F2ECE0');
  });
});
