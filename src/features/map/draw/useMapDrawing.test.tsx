/**
 * The map's drawing tools end to end, minus the map (#502/#503): taps build
 * the shape, the panel's Undo/Clear/Save drive the editor, Save writes a
 * planned route (untimed GPX + plan) or an area to the library, and the area
 * card's hold-to-delete removes it. The native map is stood in for by a
 * `project` stub; the drag handles' callbacks are exercised directly.
 */
import type { LngLat } from '@core/models';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { forwardRef, useImperativeHandle, type Ref } from 'react';
import { Animated } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { HOLD_MS } from '../components/HoldButton';
import { useMapDrawing, type MapDrawing } from './useMapDrawing';

const mockWriteTrackGpx = jest.fn((id: string, _xml: string) => `file:///doc/tracks/${id}.gpx`);
let mockId = 0;
jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  newId: () => `id${++mockId}`,
  writeTrackGpx: (id: string, xml: string) => mockWriteTrackGpx(id, xml),
  writeIndex: jest.fn(),
  deleteFileAt: jest.fn(),
  importPhoto: jest.fn(),
  createCacheFileWriter: jest.fn(),
}));
jest.mock('@data/trackGeometry', () => ({ primeTrackGeometry: jest.fn() }));
// Offline: no DEM tile can be read, so the climb is unavailable (never guessed).
jest.mock('@features/map/dem', () => ({
  fetchDemTile: jest.fn(() => Promise.reject(new Error('offline'))),
}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('expo-image-picker', () => ({}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
/** The draggable handles DrawLayers mounted, by annotation id (props kept for the test). */
const mockHandles = new Map<string, Record<string, unknown>>();
jest.mock('@maplibre/maplibre-react-native', () => {
  const passthrough = ({ children }: { children?: unknown }) => children ?? null;
  return {
    GeoJSONSource: passthrough,
    Layer: () => null,
    ViewAnnotation: (props: Record<string, unknown> & { id: string; children?: unknown }) => {
      mockHandles.set(props.id, props);
      return props.children ?? null;
    },
  };
});

/** The current handle whose id starts with `prefix` (revision suffix varies). */
function handle(prefix: string): Record<string, (e: unknown) => void> {
  const keys = [...mockHandles.keys()].filter((k) => k.startsWith(prefix));
  const latest = keys[keys.length - 1];
  if (latest === undefined) throw new Error(`no handle ${prefix}`);
  return mockHandles.get(latest) as Record<string, (e: unknown) => void>;
}
const dragEvent = (at: LngLat) => ({ nativeEvent: { lngLat: at, point: [0, 0], id: 'x' } });

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

// Québec City, a few hundred metres apart.
const P1: LngLat = [-71.215, 46.81];
const P2: LngLat = [-71.21, 46.812];
const P3: LngLat = [-71.205, 46.811];
const P4: LngLat = [-71.208, 46.807];

const snack = jest.fn();
const beforeStart = jest.fn();
/** Every vertex projects to (lng·10⁵, lat·10⁵) px — enough for the long-press hit-test. */
const mapRef = {
  current: {
    project: jest.fn(async (p: LngLat) => [p[0] * 1e5, p[1] * 1e5] as [number, number]),
  },
};

const Harness = forwardRef(function Harness(_: object, ref: Ref<MapDrawing>) {
  const drawing = useMapDrawing({
    mapRef: mapRef as never,
    showSnack: snack,
    units: 'metric',
    topInset: 47,
    onBeforeStart: beforeStart,
  });
  useImperativeHandle(ref, () => drawing);
  return (
    <>
      {drawing.mapLayers}
      {drawing.chrome}
    </>
  );
});

let api: MapDrawing | null = null;

async function mount() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <PaperProvider>
        <Harness
          ref={(d: MapDrawing | null) => {
            api = d;
          }}
        />
      </PaperProvider>
    </SafeAreaProvider>,
  );
}

const drawing = (): MapDrawing => {
  if (api === null) throw new Error('not mounted');
  return api;
};

async function tap(at: LngLat | null) {
  await act(async () => {
    drawing().onMapTap(at);
  });
}

async function press(label: string) {
  await fireEvent.press(screen.getByLabelText(label));
}

async function flush(ms = 0) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

jest.useFakeTimers();

beforeEach(() => {
  mockId = 0;
  api = null;
  mockHandles.clear();
  snack.mockReset();
  beforeStart.mockReset();
  mockWriteTrackGpx.mockClear();
  useLibraryStore.setState({
    hydrated: true,
    tracks: [],
    areas: [],
    activeTrackIds: [],
    customCategories: [],
  });
  useMapStore.setState({ drawRequest: null, focusBounds: null });
  jest.spyOn(Animated, 'timing').mockReturnValue({
    start: jest.fn(),
    stop: jest.fn(),
    reset: jest.fn(),
    _isUsingNativeDriver: () => false,
  } as unknown as Animated.CompositeAnimation);
});
afterEach(() => jest.restoreAllMocks());

describe('route drawing (#502)', () => {
  it('owns map taps only while open', async () => {
    await mount();
    expect(drawing().onMapTap(P1)).toBe(false);
    await act(async () => drawing().startRoute());
    expect(beforeStart).toHaveBeenCalled();
    expect(drawing().active).toBe(true);
    expect(drawing().onMapTap(null)).toBe(true);
    expect(screen.getByText('Draw a route')).toBeOnTheScreen();
    // Trails and Roads are promised but not yet available.
    expect(screen.getByLabelText('Trails, coming soon')).toBeDisabled();
    expect(screen.getByLabelText('Roads, coming soon')).toBeDisabled();
    expect(screen.getByText('Freehand')).toBeOnTheScreen();
  });

  it('adds, undoes, clears and saves an untimed planned route', async () => {
    await mount();
    await act(async () => drawing().startRoute());
    expect(screen.getByLabelText('Save route')).toBeDisabled();
    await tap(P1);
    await tap(P2);
    await tap(P3);
    expect(screen.getByText(/Drag a point/)).toBeOnTheScreen();
    // ~0.8 km, and the climb is unavailable offline (never a guess).
    expect(screen.getByLabelText(/^distance \d+ m$/)).toBeOnTheScreen();
    await flush(400);
    await flush(0);
    expect(screen.getByLabelText('climb unavailable')).toBeOnTheScreen();

    await press('Undo');
    await press('Clear');
    expect(screen.getByLabelText('Save route')).toBeDisabled();
    await press('Undo'); // a clear is undoable
    expect(screen.getByLabelText('Save route')).not.toBeDisabled();

    await press('Save route');
    expect(screen.getByLabelText('Route name').props.value).toBe('Route 1');
    await press('Activity Hike');
    expect(screen.getByTestId('save-route-summary')).toHaveTextContent(/≈ \d+ min$/);
    await press('Save route to Library');
    await flush(0);

    const [saved] = useLibraryStore.getState().tracks;
    expect(saved).toMatchObject({ name: 'Route 1', category: 'hike' });
    expect(saved?.plan).toEqual({ mode: 'freehand', vertices: [P1, P2] });
    expect(saved?.stats.durationS).toBe(0);
    // Stored like an imported untimed route: a <trk> with no <time>.
    const xml = mockWriteTrackGpx.mock.calls[0]?.[1] ?? '';
    expect(xml).toContain('<trk>');
    expect(xml).not.toContain('<time>');
    // The new route is shown on the map, and the tool closes.
    expect(useLibraryStore.getState().activeTrackIds).toContain(saved?.id);
    expect(drawing().active).toBe(false);
    expect(snack).toHaveBeenCalledWith('Route "Route 1" saved to Library');
  });

  it('drags a point, inserts by dragging a midpoint, and deletes a tapped point', async () => {
    await mount();
    await act(async () => drawing().startRoute());
    await tap(P1);
    await tap(P3);
    // Drag the second point onto P4 (DrawLayers' native handle callbacks).
    await act(async () => handle('draw-v-1-').onDragEnd?.(dragEvent(P4)));
    // Drag the segment's midpoint handle onto P2: a vertex is inserted there.
    await act(async () => handle('draw-mid-1-').onDragEnd?.(dragEvent(P2)));
    // Tap the last point: it is selected and its delete row shows.
    await act(async () => handle('draw-v-2-').onPress?.(dragEvent(P4)));
    expect(screen.getByText('Point 3 selected')).toBeOnTheScreen();
    // A map tap while a point is selected only deselects it.
    await tap(P3);
    expect(screen.queryByText('Point 3 selected')).toBeNull();
    await act(async () => handle('draw-v-2-').onPress?.(dragEvent(P4)));
    await press('Delete point');
    await press('Save route');
    await press('Save route to Library');
    await flush(0);
    expect(useLibraryStore.getState().tracks[0]?.plan?.vertices).toEqual([P1, P2]);
  });

  it('a long-press near a vertex deletes it; elsewhere it does nothing', async () => {
    await mount();
    await act(async () => drawing().startRoute());
    await tap(P1);
    await tap(P2);
    await tap(P3);
    await act(async () => {
      await drawing().onMapLongPress([P2[0] * 1e5 + 5, P2[1] * 1e5 - 5]);
    });
    await act(async () => {
      await drawing().onMapLongPress([0, 0]);
    });
    await press('Save route');
    await press('Save route to Library');
    await flush(0);
    expect(useLibraryStore.getState().tracks[0]?.plan?.vertices).toEqual([P1, P3]);
  });

  it('the first ✕ on a dirty drawing warns; the second discards', async () => {
    await mount();
    await act(async () => drawing().startRoute());
    await tap(P1);
    await press('Exit drawing');
    expect(drawing().active).toBe(true);
    expect(snack).toHaveBeenCalledWith('Tap ✕ again to discard this drawing');
    await press('Exit drawing');
    expect(drawing().active).toBe(false);
  });

  it('"Edit route" reopens a saved route on its vertices and saves in place', async () => {
    await mount();
    await act(async () => {
      useLibraryStore.setState({
        tracks: [
          {
            id: 'r1',
            name: 'Old line',
            startedAt: 1,
            fileUri: 'file:///doc/tracks/r1.gpx',
            category: 'bike',
            stats: {
              distanceM: 1,
              ascentM: 0,
              descentM: 0,
              durationS: 0,
              movingTimeS: 0,
              avgSpeedMps: 0,
              maxSpeedMps: 0,
              pointCount: 2,
            },
            plan: { mode: 'freehand', vertices: [P1, P2] },
          },
        ],
      });
    });
    await act(async () => {
      useMapStore.getState().setDrawRequest({ kind: 'edit-route', trackId: 'r1' });
    });
    await flush(0);
    expect(useMapStore.getState().drawRequest).toBeNull();
    expect(screen.getByText('Edit route · Old line')).toBeOnTheScreen();
    expect(useMapStore.getState().focusBounds).not.toBeNull();
    await tap(P3);
    await press('Save changes');
    expect(screen.getByLabelText('Route name').props.value).toBe('Old line');
    await press('Save route to Library');
    await flush(0);
    const [edited] = useLibraryStore.getState().tracks;
    expect(useLibraryStore.getState().tracks).toHaveLength(1);
    expect(edited?.id).toBe('r1');
    expect(edited?.category).toBe('bike');
    expect(edited?.plan?.vertices).toEqual([P1, P2, P3]);
    expect(edited?.fileUri).not.toBe('file:///doc/tracks/r1.gpx');
  });

  it('refuses to "edit" a trail that was not drawn', async () => {
    await mount();
    await act(async () => {
      useLibraryStore.setState({
        tracks: [
          {
            id: 'rec',
            name: 'Recorded',
            startedAt: 1,
            fileUri: 'file:///doc/tracks/rec.gpx',
            stats: {
              distanceM: 1,
              ascentM: 0,
              descentM: 0,
              durationS: 10,
              movingTimeS: 0,
              avgSpeedMps: 0,
              maxSpeedMps: 0,
              pointCount: 2,
            },
          },
        ],
      });
    });
    await act(async () => {
      useMapStore.getState().setDrawRequest({ kind: 'edit-route', trackId: 'rec' });
    });
    await flush(0);
    expect(drawing().active).toBe(false);
    expect(snack).toHaveBeenCalledWith(
      'This trail was not drawn on the map, so it has no route to edit',
    );
  });
});

describe('area drawing (#503)', () => {
  async function drawSquare() {
    await act(async () => drawing().startArea());
    expect(screen.getByText('Tap the map to place the first corner')).toBeOnTheScreen();
    await tap(P1);
    await tap(P2);
    expect(screen.getByLabelText('Done')).toBeDisabled();
    await tap(P3);
    await tap(P4);
  }

  it('closes the polygon at three corners, then saves it with a note and colour', async () => {
    await mount();
    await drawSquare();
    expect(screen.getByLabelText(/^area \d[\d.,]* (m²|ha|km²)$/)).toBeOnTheScreen();
    expect(screen.getByLabelText('corners 4')).toBeOnTheScreen();
    await press('Done');
    expect(screen.getByLabelText('Area name').props.value).toBe('Area 1');
    await fireEvent.changeText(screen.getByLabelText('Area name'), 'Blueberry slope');
    await fireEvent.changeText(screen.getByLabelText('Area notes'), 'Lots of berries mid-August.');
    await fireEvent.changeText(screen.getByLabelText('Add tags'), 'Berries, private');
    await press('Colour Green');
    await press('Save area');

    const [area] = useLibraryStore.getState().areas;
    expect(area).toMatchObject({
      name: 'Blueberry slope',
      note: 'Lots of berries mid-August.',
      color: '#3E8E5A',
      tags: ['Berries', 'private'],
    });
    expect(area?.ring).toEqual([P1, P2, P3, P4]);
    expect(drawing().active).toBe(false);
    // The new area's card opens.
    expect(screen.getByTestId('area-card')).toBeOnTheScreen();
    expect(screen.getByTestId('area-note')).toHaveTextContent('Lots of berries mid-August.');
    expect(screen.getByText('Berries')).toBeOnTheScreen();
  });

  it('warns about crossing edges', async () => {
    await mount();
    await act(async () => drawing().startArea());
    await tap(P1);
    await tap(P3);
    await tap(P2);
    await tap(P4);
    expect(screen.getByText(/Edges cross/)).toBeOnTheScreen();
  });

  it('a tap inside an area opens its card; a second tap closes it; hold deletes', async () => {
    await mount();
    await drawSquare();
    await press('Done');
    await press('Save area');
    await act(async () => drawing().closeAreaCard());
    expect(screen.queryByTestId('area-card')).toBeNull();

    const inside: LngLat = [-71.209, 46.81];
    let hit = false;
    await act(async () => {
      hit = drawing().onAreaTap(inside);
    });
    expect(hit).toBe(true);
    expect(screen.getByTestId('area-card')).toBeOnTheScreen();
    await act(async () => {
      hit = drawing().onAreaTap(inside);
    });
    expect(hit).toBe(false);
    expect(screen.queryByTestId('area-card')).toBeNull();
    await act(async () => {
      hit = drawing().onAreaTap([-70, 45]);
    });
    expect(hit).toBe(false);

    await act(async () => {
      drawing().onAreaTap(inside);
    });
    await fireEvent(screen.getByLabelText('Delete area'), 'pressIn');
    await flush(HOLD_MS + 100);
    expect(useLibraryStore.getState().areas).toEqual([]);
    expect(snack).toHaveBeenCalledWith('Area deleted');
  });

  it('"Edit shape" re-draws a saved area and updates it in place', async () => {
    await mount();
    await drawSquare();
    await press('Done');
    await press('Save area');
    const id = useLibraryStore.getState().areas[0]?.id ?? '';
    await act(async () => {
      useMapStore.getState().setDrawRequest({ kind: 'edit-area-shape', areaId: id });
    });
    await flush(0);
    expect(screen.getByText('Edit area shape')).toBeOnTheScreen();
    await press('Undo'); // nothing to undo on a freshly loaded shape
    await act(async () => {
      drawing().onMapTap([-71.212, 46.806]);
    });
    await press('Done');
    expect(useLibraryStore.getState().areas).toHaveLength(1);
    expect(useLibraryStore.getState().areas[0]?.ring).toHaveLength(5);
    expect(snack).toHaveBeenCalledWith('Area updated');
  });

  it("the card's Edit opens the editor on the saved fields", async () => {
    await mount();
    await drawSquare();
    await press('Done');
    await press('Save area');
    await press('Edit area');
    expect(screen.getByText('Edit area')).toBeOnTheScreen();
    expect(screen.getByLabelText('Area name').props.value).toBe('Area 1');
    await fireEvent.changeText(screen.getByLabelText('Area name'), 'Renamed');
    await press('Save area');
    expect(useLibraryStore.getState().areas[0]?.name).toBe('Renamed');
  });
});
