import { DEFAULT_CURSOR, DEFAULT_STRIP } from '@core/infoStrip/presets';
import { normaliseInfoStripSettings } from '@core/infoStrip/settings';
import type { CursorSettings } from '@core/infoStrip/types';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { darkScheme, lightScheme } from '@ui/tokens';
import { darkTheme, lightTheme } from '@ui/theme';
import { act, render, screen } from '@testing-library/react-native';
import { Profiler } from 'react';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { CenterCursor, CURSOR_DOT, DOT_DP } from './CenterCursor';

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

/** Put a cursor on the current strip (as the editor does). */
const setCursor = (patch: Partial<CursorSettings>) => {
  const all = useSettingsStore.getState().infoStrip;
  useSettingsStore.setState({
    infoStrip: {
      ...all,
      current: {
        ...all.current,
        aids: { ...all.current.aids, cursor: { ...all.current.aids.cursor, ...patch } },
      },
    },
  });
};

const hidden = { includeHiddenElements: true };
const dot = () => screen.queryByTestId('map-center-dot', hidden);

describe('CenterCursor (#677, 2.6.0 map aid #673)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ infoStrip: normaliseInfoStripSettings(undefined) });
    useMapStore.setState({ followUser: false, mapCenter: null });
  });

  it("is 2.5.1's dot by default: 7 dp, centred and touch-transparent", async () => {
    await renderCursor();
    const host = screen.getByTestId('map-center-cursor', hidden);
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
    expect(DEFAULT_STRIP.aids.cursor).toEqual(DEFAULT_CURSOR);
  });

  it.each(['cross', 'reticle', 'ring', 'x'] as const)('draws the %s icon', async (kind) => {
    setCursor({ kind, size: 'M' });
    await renderCursor();
    expect(screen.getByTestId(`map-center-${kind}`, hidden)).toBeTruthy();
    expect(dot()).toBeNull();
  });

  it('sizes the dot S–XL', async () => {
    setCursor({ size: 'XL' });
    await renderCursor();
    expect(StyleSheet.flatten(dot()?.props.style as never)).toMatchObject({
      width: DOT_DP.XL,
    });
  });

  it('hides while the camera follows the user, unless told to stay', async () => {
    await renderCursor();
    expect(dot()).not.toBeNull();
    await act(async () => useMapStore.setState({ followUser: true }));
    expect(dot()).toBeNull();
    await act(async () => setCursor({ hideWhileFollowing: false }));
    expect(dot()).not.toBeNull();
  });

  it('hides when switched off (and a 2.5.1 user who had it off)', async () => {
    useSettingsStore.setState({
      infoStrip: normaliseInfoStripSettings(undefined, { showCenterCursor: false }),
    });
    await renderCursor();
    expect(dot()).toBeNull();
    await act(async () => setCursor({ enabled: true }));
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
  ] as const)('draws a stone dot in a paper halo in %s', async (_n, dark, scheme) => {
    await renderCursor(false, dark);
    expect(StyleSheet.flatten(dot()?.props.style as never)).toMatchObject({
      backgroundColor: DEFAULT_CURSOR.color,
    });
    expect(DEFAULT_CURSOR.color).toBe(scheme.map.cursor);
    expect(StyleSheet.flatten(dot()?.parent?.props.style as never)).toMatchObject({
      backgroundColor: scheme.map.cursorRing,
    });
  });

  it('drops the halo when asked', async () => {
    setCursor({ halo: false });
    await renderCursor();
    expect(StyleSheet.flatten(dot()?.parent?.props.style as never)).toMatchObject({
      backgroundColor: 'transparent',
    });
  });
});
