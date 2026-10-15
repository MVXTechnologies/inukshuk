/**
 * The "On map" trail chip (#710): name + ✕ on the map's fixed dark slab (both
 * themes), ✕ closes the look, the name reopens the trail; no chip while
 * following that trail (#678).
 */
import type { TrackSummary } from '@core/models';
import { useLibraryStore } from '@state/libraryStore';
import { useNavigationStore } from '@state/navigationStore';
import { useOnMapTrailStore } from '@state/onMapTrailStore';
import { darkTheme, lightTheme } from '@ui/theme';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { weatherChrome } from '../weather/weatherChrome';
import { OnMapTrailChip, useOnMapTrailChip } from './OnMapTrailChip';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: mockPush, back: jest.fn(), replace: jest.fn() }),
}));

const trail = (id: string, name: string) => ({ id, name }) as TrackSummary;

const mockRender = jest.fn();
function Harness() {
  mockRender();
  const chip = useOnMapTrailChip();
  return chip === null ? null : <OnMapTrailChip trail={chip} />;
}

const mount = (theme = lightTheme) =>
  render(
    <PaperProvider theme={theme}>
      <Harness />
    </PaperProvider>,
  );

beforeEach(() => {
  mockPush.mockReset();
  mockRender.mockClear();
  useLibraryStore.setState({
    tracks: [trail('t1', 'Sentier des Crêtes'), trail('t2', 'Lac-Beauport')],
    activeTrackIds: ['t2'],
  });
  useNavigationStore.setState({ destination: null, following: null });
  useOnMapTrailStore.setState({ trackId: 't1' });
});

describe('OnMapTrailChip', () => {
  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ])('names the trail on the fixed dark slab (%s theme)', async (_n, theme) => {
    await mount(theme);
    const text = screen.getByText('Sentier des Crêtes');
    expect(StyleSheet.flatten(text.props.style).color).toBe(weatherChrome.ink);
    const chip = screen.getByTestId('onmap-trail-chip');
    expect(StyleSheet.flatten(chip.props.style).backgroundColor).toBe(weatherChrome.panel);
  });

  it('✕ closes it and leaves the Library set as it was', async () => {
    await mount();
    const close = screen.getByTestId('onmap-trail-close');
    expect(close.props.accessibilityLabel).toBe('Close trail on map');
    await act(async () => fireEvent.press(close));
    expect(useOnMapTrailStore.getState().trackId).toBeNull();
    expect(useLibraryStore.getState().activeTrackIds).toEqual(['t2']);
    expect(screen.queryByTestId('onmap-trail-chip')).toBeNull();
  });

  it('tapping the name reopens the trail', async () => {
    await mount();
    await act(async () => fireEvent.press(screen.getByLabelText('Open trail Sentier des Crêtes')));
    expect(mockPush).toHaveBeenCalledWith('/trail3d/t1');
  });

  it('shows no chip while following that trail, and again once following stops', async () => {
    useNavigationStore.setState({ following: { trackId: 't1', name: 'Sentier des Crêtes' } });
    await mount();
    expect(screen.queryByTestId('onmap-trail-chip')).toBeNull();
    await act(async () => useNavigationStore.getState().stopFollowing());
    expect(screen.getByTestId('onmap-trail-chip')).toBeTruthy();
  });

  it('shows no chip without an "On map" trail, or once that trail is deleted', async () => {
    useOnMapTrailStore.setState({ trackId: null });
    await mount();
    expect(screen.queryByTestId('onmap-trail-chip')).toBeNull();
    await act(async () => useOnMapTrailStore.setState({ trackId: 'gone' }));
    expect(screen.queryByTestId('onmap-trail-chip')).toBeNull();
  });

  it('does not re-render the map for library edits that leave the name alone', async () => {
    await mount();
    const before = mockRender.mock.calls.length;
    await act(async () =>
      useLibraryStore.setState((s) => ({ tracks: [...s.tracks, trail('t3', 'New')] })),
    );
    expect(mockRender).toHaveBeenCalledTimes(before);
  });
});
