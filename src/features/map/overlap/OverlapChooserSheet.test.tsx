import { METRIC } from '@core/format';
import type { Area, TrackSummary } from '@core/models';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { darkTheme, lightTheme } from '@ui/theme';
import { schemeTokens } from '@ui/tokens';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { OverlapChooserSheet } from './OverlapChooserSheet';
import { useOverlapChooser } from './overlapChooser';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

const trail = (id: string, name: string, category: string, km: number): TrackSummary =>
  ({
    id,
    name,
    category,
    startedAt: new Date(2026, 9, 12, 9).getTime(),
    stats: { distanceM: km * 1000, durationS: 3600 },
    fileUri: `file:///${id}.gpx`,
  }) as unknown as TrackSummary;

const AREA: Area = {
  id: 'camp',
  name: 'Camp zone',
  color: '#3E8E5A',
  ring: [
    [-71.2, 46.8],
    [-71.19, 46.8],
    [-71.19, 46.81],
  ],
  createdAt: 0,
};

const HITS = [
  { kind: 'trail' as const, id: 'mw', distanceM: 2 },
  { kind: 'trail' as const, id: 'ld', distanceM: 5 },
  { kind: 'area' as const, id: 'camp', sizeM2: 2_400_000 },
];

async function renderSheet(
  opts: {
    dark?: boolean;
    suppressed?: boolean;
    onPickTrail?: (id: string) => void;
    onPickArea?: (id: string) => void;
  } = {},
) {
  await render(
    <PaperProvider theme={opts.dark ? darkTheme : lightTheme}>
      <OverlapChooserSheet
        onPickTrail={opts.onPickTrail ?? (() => undefined)}
        onPickArea={opts.onPickArea ?? (() => undefined)}
        suppressed={opts.suppressed ?? false}
      />
    </PaperProvider>,
  );
}

beforeEach(() => {
  useSettingsStore.setState({ units: METRIC });
  useLibraryStore.setState({
    tracks: [
      trail('mw', 'Mont Wright loop', 'hike', 12.4),
      trail('ld', 'Lac-Delage ride', 'bike', 28.1),
    ],
    areas: [AREA],
    customCategories: [],
  });
  useOverlapChooser.setState({ hits: null });
});

describe('the overlap chooser (#745)', () => {
  it('renders nothing while closed, and never for a single hit', async () => {
    await renderSheet();
    expect(screen.queryByTestId('overlap-chooser')).toBeNull();
    await act(async () => useOverlapChooser.getState().open([HITS[0]!]));
    expect(useOverlapChooser.getState().hits).toBeNull();
    expect(screen.queryByTestId('overlap-chooser')).toBeNull();
  });

  it.each([['light'], ['dark']])('lists swatch, name, kind and size (%s)', async (theme) => {
    const dark = theme === 'dark';
    useOverlapChooser.getState().open(HITS);
    await renderSheet({ dark });
    expect(screen.getByText('3 here')).toBeTruthy();
    expect(screen.getByText('Mont Wright loop')).toBeTruthy();
    expect(screen.getByText(/^Hike · 12\.4 km · Oct 12/)).toBeTruthy();
    expect(screen.getByText('Lac-Delage ride')).toBeTruthy();
    expect(screen.getByText(/^Bike · 28\.1 km/)).toBeTruthy();
    expect(screen.getByText('Camp zone')).toBeTruthy();
    expect(screen.getByText('Area · 2.4 km²')).toBeTruthy();
    expect(screen.getAllByTestId('overlap-swatch-trail')).toHaveLength(2);
    expect(screen.getAllByTestId('overlap-swatch-area')).toHaveLength(1);
    const card = StyleSheet.flatten(screen.getByTestId('overlap-chooser').props.style);
    expect(card.backgroundColor).toBe(schemeTokens(dark).elevation.level2);
    expect(StyleSheet.flatten(screen.getByText('Camp zone').props.style).color).toBe(
      schemeTokens(dark).ink,
    );
  });

  it('gives an untimed trail no date (its date is when it was imported)', async () => {
    useLibraryStore.setState({
      tracks: [
        trail('mw', 'Mont Wright loop', 'hike', 12.4),
        {
          ...trail('nav', 'Ridge route', 'navigation', 3.1),
          stats: { distanceM: 3100, durationS: 0 },
        } as TrackSummary,
      ],
    });
    useOverlapChooser.getState().open([HITS[0]!, { kind: 'trail', id: 'nav', distanceM: 3 }]);
    await renderSheet();
    expect(screen.getByText(/^Navigation trail · 3\.1 km$/)).toBeTruthy();
  });

  it('a trail row selects the trail and closes the list', async () => {
    const onPickTrail = jest.fn();
    useOverlapChooser.getState().open(HITS);
    await renderSheet({ onPickTrail });
    await act(async () => fireEvent.press(screen.getByTestId('overlap-row-trail:ld')));
    expect(onPickTrail).toHaveBeenCalledWith('ld');
    expect(useOverlapChooser.getState().hits).toBeNull();
  });

  it('an area row opens the area (a larger area behind a smaller one is reachable)', async () => {
    const onPickArea = jest.fn();
    useOverlapChooser.getState().open(HITS);
    await renderSheet({ onPickArea });
    await act(async () => fireEvent.press(screen.getByTestId('overlap-row-area:camp')));
    expect(onPickArea).toHaveBeenCalledWith('camp');
  });

  it('drops rows whose item is gone; one left is no choice', async () => {
    useOverlapChooser.getState().open([HITS[0]!, { kind: 'trail', id: 'deleted', distanceM: 1 }]);
    await renderSheet();
    expect(screen.queryByTestId('overlap-chooser')).toBeNull();
  });

  it('closes with its ✕, and for good when another card takes the slot', async () => {
    useOverlapChooser.getState().open(HITS);
    await renderSheet();
    await act(async () => fireEvent.press(screen.getByTestId('overlap-chooser-close')));
    expect(useOverlapChooser.getState().hits).toBeNull();

    useOverlapChooser.getState().open(HITS);
    await renderSheet({ suppressed: true });
    expect(useOverlapChooser.getState().hits).toBeNull();
  });
});
