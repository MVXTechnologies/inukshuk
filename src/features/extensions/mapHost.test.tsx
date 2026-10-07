/**
 * The map's extension host: taps go to the extensions top-down, and each
 * card is wired to the map exactly as MapScreen wired it by hand before the
 * registry (same dock testIDs, same toasts, same close-on-navigate).
 */
import { GEODETIC_TAP_LAYERS } from '@core/map/geodeticStyle';
import type { GeodeticMark } from '@core/geodetic/record';
import type { TideStation } from '@core/tides/station';
import { render } from '@testing-library/react-native';
import { createRef } from 'react';
import type { View } from 'react-native';

import { ExtensionCardDock, extensionRecenters, hitTestExtensions } from './mapHost';
import type { ExtensionCardHost } from './types';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('@maplibre/maplibre-react-native', () => ({
  GeoJSONSource: () => null,
  Layer: () => null,
  Images: () => null,
}));
jest.mock('../map/hooks/useChs', () => ({ useChsStations: () => null }));
const mockStation = { current: null as TideStation | null };
jest.mock('../map/tideTap', () => ({ tideStationAt: async () => mockStation.current }));
const mockCards: Record<string, Record<string, (...args: never[]) => unknown>> = {};
jest.mock('../map/components/GeodeticPointCard', () => ({
  GeodeticPointCard: (p: Record<string, (...args: never[]) => unknown>) => {
    mockCards.geodetic = p;
    return null;
  },
}));
jest.mock('../map/components/TideStationCard', () => ({
  TideStationCard: (p: Record<string, (...args: never[]) => unknown>) => {
    mockCards.tides = p;
    return null;
  },
}));

const STATION = { id: 's1', lat: 46.8, lng: -71.2, name: 'Québec' } as TideStation;
const MARK = { id: 'm1', lat: 46.81, lng: -71.21, type: '3d' } as unknown as GeodeticMark;

/** A map whose rendered features are none; records which layers each query asked for. */
function fakeMap(queried: string[][]) {
  return {
    queryRenderedFeatures: async (_box: unknown, o: { layers: string[] }) => {
      queried.push(o.layers);
      return [];
    },
  };
}

beforeEach(() => {
  mockStation.current = null;
});

describe('hitTestExtensions', () => {
  const tap = { px: 10, py: 20, lngLat: [-71.2, 46.8] as const };

  it('asks the top extension first: a tide station wins over the marks round it', async () => {
    mockStation.current = STATION;
    const queried: string[][] = [];
    const hit = await hitTestExtensions(['geodetic', 'tides'], { ...tap, map: fakeMap(queried) });
    expect(hit).toEqual({ key: 'tides', value: STATION });
    expect(queried).toEqual([]); // geodetic never asked
    expect(extensionRecenters(hit!)).toBe(false);
  });

  it('falls through to the marks, then to nothing; asks only the drawn extensions', async () => {
    const queried: string[][] = [];
    expect(
      await hitTestExtensions(['geodetic', 'tides'], { ...tap, map: fakeMap(queried) }),
    ).toBeNull();
    expect(queried).toEqual([[...GEODETIC_TAP_LAYERS]]);
    expect(await hitTestExtensions([], { ...tap, map: fakeMap(queried) })).toBeNull();
    expect(queried).toHaveLength(1);
  });

  it('a mid-teardown map is no hit', async () => {
    const map = { queryRenderedFeatures: () => Promise.reject(new Error('gone')) };
    expect(await hitTestExtensions(['geodetic'], { ...tap, map })).toBeNull();
  });
});

describe('ExtensionCardDock', () => {
  type Fn = 'close' | 'navigateTo' | 'openLink' | 'copy' | 'openConvert';
  const host = (): Omit<ExtensionCardHost, Fn> & Record<Fn, jest.Mock> => ({
    floating: true,
    offline: false,
    close: jest.fn(),
    navigateTo: jest.fn(),
    openLink: jest.fn(),
    copy: jest.fn(),
    openConvert: jest.fn(),
  });

  async function dock(hit: Parameters<typeof ExtensionCardDock>[0]['hit'], h: ExtensionCardHost) {
    return render(
      <ExtensionCardDock
        hit={hit}
        host={h}
        style={{ bottom: 0 }}
        dockRef={createRef<View>()}
        onLayout={() => undefined}
      />,
    );
  }

  it('geodetic: its dock, datasheet toast, navigate, convert from the mark, "Copied …"', async () => {
    const h = host();
    const view = await dock({ key: 'geodetic', value: MARK }, h);
    expect(view.getByTestId('geodetic-card-dock')).toBeTruthy();
    expect(extensionRecenters({ key: 'geodetic', value: MARK })).toBe(true);
    const p = mockCards.geodetic!;
    expect(p.mark).toBe(MARK);
    expect(p.floating).toBe(true);
    (p.onOpenLink as (u: string) => void)('https://x');
    expect(h.openLink).toHaveBeenCalledWith('https://x', "Couldn't open the datasheet");
    (p.onNavigate as () => void)();
    expect(h.navigateTo).toHaveBeenCalledWith(46.81, -71.21);
    (p.onCopy as (t: string, w: string) => void)('19N 123', 'UTM zone 19N');
    expect(h.copy).toHaveBeenCalledWith('19N 123', 'Copied UTM zone 19N');
    (p.onClose as () => void)();
    expect(h.close).toHaveBeenCalled();
  });

  it('tides: its dock, agency toast, the long-copy ellipsis, convert passed through', async () => {
    const h = host();
    const view = await dock({ key: 'tides', value: STATION }, h);
    expect(view.getByTestId('tide-card-dock')).toBeTruthy();
    const p = mockCards.tides!;
    (p.onOpenLink as (u: string) => void)('https://y');
    expect(h.openLink).toHaveBeenCalledWith('https://y', "Couldn't open the agency page");
    (p.onCopy as (t: string) => void)('short');
    expect(h.copy).toHaveBeenLastCalledWith('short', 'Copied: short');
    const long = 'x'.repeat(100);
    (p.onCopy as (t: string) => void)(long);
    expect(h.copy).toHaveBeenLastCalledWith(long, `Copied: ${'x'.repeat(77)}…`);
    (p.onNavigate as () => void)();
    expect(h.navigateTo).toHaveBeenCalledWith(46.8, -71.2);
    expect(p.onConvert).toBe(h.openConvert);
  });
});
