import { METRIC } from '@core/format';
/**
 * A field's settings page re-renders with every snapshot (the live preview),
 * so its distance-sorted lists — the target picker's waypoints and the tide
 * stations — sort once per ~50 m cell, never per tick (#673 review).
 */
import { ref } from '@core/infoStrip/presets';
import { snapshot } from '@core/infoStrip/testUtils';
import type { DepsSnapshot, InfoStrip } from '@core/infoStrip/types';
import { parseChsStationList } from '@core/tides/chs';
import { useLibraryStore } from '@state/libraryStore';
import { act, render, screen } from '@testing-library/react-native';

import { currentStrip, Providers, QC, resetStores } from '../testUtils';
import { FieldSettings } from './FieldSettings';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: jest.fn(async () => null) }));

const mockSorts = { waypoints: 0, stations: 0 };
jest.mock('@core/infoStrip/target', () => {
  const actual = jest.requireActual('@core/infoStrip/target');
  return {
    ...actual,
    nearestWaypoints: (...a: unknown[]) => {
      mockSorts.waypoints += 1;
      return actual.nearestWaypoints(...a);
    },
  };
});
jest.mock('@core/infoStrip/tides', () => {
  const actual = jest.requireActual('@core/infoStrip/tides');
  return {
    ...actual,
    nearbyStations: (...a: unknown[]) => {
      mockSorts.stations += 1;
      return actual.nearbyStations(...a);
    },
  };
});

/** SYNTHETIC live stations (names and ids made up). */
const mockList = parseChsStationList(
  [
    ['00001', 'Anse-Fictive', 46.8, -71.2],
    ['00003', 'Cap-Imaginaire', 47.5, -70.0],
  ].map(([code, name, lat, lng]) => ({
    id: `synth-${String(code)}`,
    code,
    officialName: name,
    latitude: lat,
    longitude: lng,
    operating: true,
    timeSeries: [{ code: 'wlo' }, { code: 'wlp-hilo' }],
  })),
);
jest.mock('../../hooks/useChs', () => ({
  useChsStations: (on: boolean) => (on ? mockList : null),
}));

const at = (i: number) => ({ latitude: QC.latitude + i * 1e-6, longitude: QC.longitude });

async function mountAndTick(strip: InfoStrip, steps: readonly number[]) {
  const page = (data: DepsSnapshot) => (
    <Providers>
      <FieldSettings
        strip={strip}
        at={{ row: 0, index: 0 }}
        data={data}
        ctx={{ units: METRIC, target: strip.target }}
        onParams={() => undefined}
        onStripTarget={() => undefined}
        onBack={() => undefined}
      />
    </Providers>
  );
  const view = await render(page(snapshot({ centre: QC, nowMs: 0 })));
  for (const [n, i] of steps.entries()) {
    const position = { ...at(i), altitudeM: null, accuracyM: 4, speedMps: 1 };
    await act(async () => view.rerender(page(snapshot({ centre: QC, position, nowMs: n }))));
  }
}

beforeEach(() => {
  resetStores();
  mockSorts.waypoints = 0;
  mockSorts.stations = 0;
  useLibraryStore.setState({
    waypoints: [
      { id: 'w1', label: 'Camp lac', latitude: 46.82, longitude: -71.2, createdAt: 0 },
      { id: 'w2', label: 'Belvédère', latitude: 46.9, longitude: -71.3, createdAt: 0 },
    ] as never,
  });
});

describe('sorted per cell, not per tick', () => {
  it('the target picker: 41 renders in one cell sort once; 110 m on sorts again', async () => {
    const strip: InfoStrip = {
      ...currentStrip(),
      rows: [[ref('targetDistance')]],
      target: { kind: 'waypoint', waypointId: 'w1' },
    };
    // The mount on the centre, then 40 ticks 0.1 m apart (1e-6°) around it: one cell.
    await mountAndTick(
      strip,
      Array.from({ length: 40 }, (_, i) => i),
    );
    expect(screen.getByLabelText('Camp lac')).toBeOnTheScreen();
    expect(mockSorts.waypoints).toBe(1);
    // A fresh mount, then 0.001° (~110 m) north: the next cell, one more sort.
    await mountAndTick(strip, [0, 1000]);
    expect(mockSorts.waypoints).toBe(1 + 2);
  });

  it('the tide station list: same budget', async () => {
    const strip: InfoStrip = { ...currentStrip(), rows: [[ref('tides:level')]] };
    await mountAndTick(
      strip,
      Array.from({ length: 40 }, (_, i) => i),
    );
    expect(screen.getByTestId('strip-station-100:00001')).toBeOnTheScreen();
    expect(mockSorts.stations).toBe(1);
  });
});
