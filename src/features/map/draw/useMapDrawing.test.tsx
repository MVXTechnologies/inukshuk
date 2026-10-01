/**
 * The map's drawing tools end to end, minus the map (#502/#503): taps build
 * the shape, the panel's Undo/Clear/Save drive the editor, Save writes a
 * planned route (untimed GPX + plan) or an area to the library, and the area
 * card's hold-to-delete removes it. The native map is stood in for by a
 * `project` stub; the drag handles' callbacks are exercised directly.
 */
import { polylineLengthM } from '@core/draw/geometry';
import type { LegResult } from '@core/draw/legs';
import type { LngLat } from '@core/models';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { forwardRef, useImperativeHandle, type Ref } from 'react';
import { Animated } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { HOLD_MS } from '../components/HoldButton';
import { resetRouteModeMemory } from './useDrawSession';
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
const mockLoadGeometry = jest.fn();
jest.mock('@data/trackGeometry', () => ({
  primeTrackGeometry: jest.fn(),
  loadTrackGeometry: (...a: unknown[]) => mockLoadGeometry(...a),
}));
/** The routing proxy (#515): each call waits for the test to answer it. */
type Answer = (result: LegResult) => void;
const mockRouteCalls: { mode: string; from: LngLat; to: LngLat; answer: Answer }[] = [];
jest.mock('@data/routing', () => ({
  routeLeg: (mode: string, from: LngLat, to: LngLat) =>
    new Promise((resolve) => mockRouteCalls.push({ mode, from, to, answer: resolve })),
}));
// Offline by default: no DEM tile can be read, so the climb is unavailable
// (never guessed). The profile tests (last, as decoded tiles are cached for
// the session) hand out a sloping tile instead.
const mockFetchDem = jest.fn();
jest.mock('@features/map/dem', () => ({
  fetchDemTile: (...a: unknown[]) => mockFetchDem(...a),
}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('expo-image-picker', () => ({}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
/** Each map source's last GeoJSON, by id (the drawn shape is "draw-shape"). */
const mockSources = new Map<string, string>();
jest.mock('@maplibre/maplibre-react-native', () => ({
  GeoJSONSource: ({ id, data, children }: { id: string; data?: string; children?: unknown }) => {
    if (typeof data === 'string') mockSources.set(id, data);
    return children ?? null;
  },
  Layer: () => null,
}));
/** The selected point's grip, as last rendered (its callbacks drive a drag). */
const mockGrip: { current: Record<string, (...a: number[]) => void> | null } = { current: null };
jest.mock('./DragHandle', () => ({
  DragHandle: (props: Record<string, (...a: number[]) => void>) => {
    mockGrip.current = props;
    return null;
  },
}));

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
    unproject: jest.fn(async (p: [number, number]) => [p[0] / 1e5, p[1] / 1e5] as LngLat),
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

/** A map tap at `at`, with its screen point (so handles are hit-tested). */
async function tap(at: LngLat | null) {
  await act(async () => {
    drawing().onMapTap(at, at ? [at[0] * 1e5, at[1] * 1e5] : null);
  });
  await act(async () => {
    await Promise.resolve();
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
  mockSources.clear();
  mockFetchDem.mockReset();
  mockFetchDem.mockImplementation(() => Promise.reject(new Error('offline')));
  mockRouteCalls.length = 0;
  mockLoadGeometry.mockReset();
  resetRouteModeMemory();
  api = null;
  mockGrip.current = null;
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
  it('"Draw" opens a Route / Area chooser; picking one starts that tool', async () => {
    await mount();
    await act(async () => drawing().openChooser());
    expect(beforeStart).toHaveBeenCalled();
    expect(screen.getByTestId('draw-chooser')).toBeOnTheScreen();
    expect(screen.getByLabelText('Route')).toBeOnTheScreen();
    expect(screen.getByLabelText('Area')).toBeOnTheScreen();
    expect(screen.getByText('A line to follow, snapped to trails or roads')).toBeOnTheScreen();
    expect(drawing().ownsBottom).toBe(true);
    expect(drawing().active).toBe(false);
    // A tap on the map beside it closes it, and is not a map tap.
    expect(drawing().onMapTap(P1)).toBe(true);
    await flush(0);
    expect(screen.queryByTestId('draw-chooser')).toBeNull();

    await act(async () => drawing().openChooser());
    await press('Close');
    expect(screen.queryByTestId('draw-chooser')).toBeNull();

    await act(async () => drawing().openChooser());
    await press('Route');
    expect(screen.queryByTestId('draw-chooser')).toBeNull();
    expect(screen.getByText('Draw a route')).toBeOnTheScreen();
    // The mode picker sits in the top bar (the search pill's slot), right of the compass.
    const picker = screen.getByTestId('route-mode-picker');
    expect(picker).toHaveStyle({ top: 47 + 8, left: 76, right: 76 });
    await press('Exit drawing');

    await act(async () => drawing().openChooser());
    await press('Area');
    expect(screen.getByText('Draw an area')).toBeOnTheScreen();
    // An area has no modes: the slot stays empty.
    expect(screen.queryByTestId('route-mode-picker')).toBeNull();
  });

  it('owns map taps only while open', async () => {
    await mount();
    expect(drawing().onMapTap(P1)).toBe(false);
    await act(async () => drawing().startRoute());
    expect(beforeStart).toHaveBeenCalled();
    expect(drawing().active).toBe(true);
    expect(drawing().onMapTap(null)).toBe(true);
    expect(screen.getByText('Draw a route')).toBeOnTheScreen();
    // Trails · Roads · Freehand, all available; a new route starts Freehand.
    expect(screen.getByLabelText('Trails')).not.toBeDisabled();
    expect(screen.getByLabelText('Roads')).not.toBeDisabled();
    expect(screen.getByLabelText('Freehand')).toBeSelected();
  });

  it('adds, undoes, clears and saves an untimed planned route', async () => {
    await mount();
    await act(async () => drawing().startRoute());
    expect(screen.getByLabelText('Save route')).toBeDisabled();
    await tap(P1);
    await tap(P2);
    await tap(P3);
    expect(screen.getByText(/Tap a point to drag/)).toBeOnTheScreen();
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

  it('drags a selected point, inserts at a tapped midpoint, deletes a selected point', async () => {
    await mount();
    await act(async () => drawing().startRoute());
    await tap(P1);
    await tap(P3);
    // Tap the second point: it is selected, its grip and delete row show.
    await tap(P3);
    expect(screen.getByText('Point 2 selected')).toBeOnTheScreen();
    await flush(0);
    expect(mockGrip.current).not.toBeNull();
    // Drag the grip to P4 (screen px = lng/lat × 10⁵ in this stand-in).
    await act(async () => {
      mockGrip.current?.onMove?.(P4[0] * 1e5, P4[1] * 1e5);
      mockGrip.current?.onEnd?.(P4[0] * 1e5, P4[1] * 1e5);
    });
    await flush(0);
    // Tap the P1–P4 segment's midpoint: a vertex is inserted and selected.
    const mid: LngLat = [(P1[0] + P4[0]) / 2, (P1[1] + P4[1]) / 2];
    await tap(mid);
    expect(screen.getByText('Point 2 selected')).toBeOnTheScreen();
    // A map tap away only deselects.
    await tap(P2);
    expect(screen.queryByText(/selected$/)).toBeNull();
    // Select the inserted point again and delete it.
    await tap(mid);
    await press('Delete point');
    await press('Save route');
    await press('Save route to Library');
    await flush(0);
    const saved = useLibraryStore.getState().tracks[0]?.plan?.vertices ?? [];
    // P1 and the dragged point; the inserted one was deleted again.
    expect(saved).toHaveLength(2);
    expect(saved[0]).toEqual(P1);
    expect(saved[1]?.[0]).toBeCloseTo(P4[0], 9);
    expect(saved[1]?.[1]).toBeCloseTo(P4[1], 9);
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

/** A routed answer: a dog-leg off the straight chord (so it is longer). */
const bent = (from: LngLat, to: LngLat): LegResult => ({
  status: 'routed',
  coords: [from, [from[0], to[1]], to],
  attribution: '© OpenStreetMap contributors · routing BRouter',
});

/** Answer the oldest pending routing call. */
async function answer(result: (from: LngLat, to: LngLat) => LegResult) {
  const call = mockRouteCalls.shift();
  if (!call) throw new Error('no routing call pending');
  await act(async () => {
    call.answer(result(call.from, call.to));
  });
  await flush(0);
}

const distanceLabel = () =>
  Number(
    /^distance ([\d.]+) (k?m)$/.exec(
      screen.getByLabelText(/^distance /).props.accessibilityLabel,
    )?.[1],
  );

describe('route snapping (#515)', () => {
  it('Trails: a new leg shows straight while routing, then snaps; stats use the routed line', async () => {
    await mount();
    await act(async () => drawing().startRoute());
    await press('Trails');
    expect(screen.getByLabelText('Trails')).toBeSelected();
    await tap(P1);
    expect(screen.getByText(/follows trails/)).toBeOnTheScreen();
    await tap(P2);
    // Loading: the leg is a straight placeholder, and the route can't be saved yet.
    expect(screen.getByText('Finding the trail…')).toBeOnTheScreen();
    expect(screen.getByLabelText('Save route')).toBeDisabled();
    const straight = distanceLabel();
    await flush(400); // debounce
    expect(mockRouteCalls.map((c) => [c.mode, c.from, c.to])).toEqual([['trails', P1, P2]]);
    await answer(bent);
    expect(screen.queryByText('Finding the trail…')).toBeNull();
    expect(distanceLabel()).toBeGreaterThan(straight);
    expect(screen.getByText(/Routing BRouter · © OpenStreetMap/)).toBeOnTheScreen();
    expect(screen.getByLabelText('Report a map error')).toBeOnTheScreen();

    await press('Save route');
    await press('Save route to Library');
    await flush(0);
    const [saved] = useLibraryStore.getState().tracks;
    expect(saved?.plan).toEqual({ mode: 'trails', vertices: [P1, P2], legModes: ['trails'] });
    // The GPX holds the routed line: it passes the dog-leg's corner.
    const xml = mockWriteTrackGpx.mock.calls[0]?.[1] ?? '';
    expect(xml).toContain(`lat="${P2[1]}" lon="${P1[0]}"`);
  });

  it('a leg that cannot be routed falls back straight with a warning; Retry asks again', async () => {
    await mount();
    await act(async () => drawing().startRoute());
    await press('Roads');
    await tap(P1);
    await tap(P2);
    expect(screen.getByText('Finding the road…')).toBeOnTheScreen();
    await flush(400);
    await answer(() => ({ status: 'failed', reason: 'offline' }));
    expect(screen.getByText('One leg drawn straight (no connection)')).toBeOnTheScreen();
    // A straight fallback still saves.
    expect(screen.getByLabelText('Save route')).not.toBeDisabled();
    expect(mockRouteCalls).toHaveLength(0);

    await press('Retry');
    await flush(400);
    expect(mockRouteCalls).toHaveLength(1);
    expect(mockRouteCalls[0]?.mode).toBe('roads');
    await answer(bent);
    expect(screen.queryByText(/drawn straight/)).toBeNull();
  });

  it('switching modes keeps the legs drawn; undo restores routed legs without a request', async () => {
    await mount();
    await act(async () => drawing().startRoute());
    await press('Trails');
    await tap(P1);
    await tap(P2);
    await flush(400);
    await answer(bent);
    await press('Freehand');
    await tap(P3);
    await flush(400);
    // The new leg is straight (no request); the trail leg stays snapped.
    expect(mockRouteCalls).toHaveLength(0);
    expect(screen.getByText(/Routing BRouter/)).toBeOnTheScreen();
    await press('Undo');
    await press('Undo');
    await press('Undo');
    await press('Undo'); // back to nothing, then redo by hand
    await press('Trails');
    await tap(P1);
    await tap(P2);
    await flush(400);
    // P1→P2 by trail was answered before: drawn snapped at once.
    expect(mockRouteCalls).toHaveLength(0);
    expect(screen.queryByText(/Finding the/)).toBeNull();
    await press('Save route');
    await press('Save route to Library');
    await flush(0);
    expect(useLibraryStore.getState().tracks[0]?.plan?.legModes).toEqual(['trails']);
  });

  it('"Edit route" reopens snapped legs from the saved line, without asking the proxy', async () => {
    mockLoadGeometry.mockResolvedValue({
      parts: [[P1, [P1[0], P2[1]], P2, P3]],
    });
    await mount();
    await act(async () => {
      useLibraryStore.setState({
        tracks: [
          {
            id: 'r2',
            name: 'Snapped',
            startedAt: 1,
            fileUri: 'file:///doc/tracks/r2.gpx',
            stats: {
              distanceM: 1,
              ascentM: 0,
              descentM: 0,
              durationS: 0,
              movingTimeS: 0,
              avgSpeedMps: 0,
              maxSpeedMps: 0,
              pointCount: 4,
            },
            plan: { mode: 'roads', vertices: [P1, P2, P3], legModes: ['trails', 'freehand'] },
          },
        ],
      });
    });
    await act(async () => {
      useMapStore.getState().setDrawRequest({ kind: 'edit-route', trackId: 'r2' });
    });
    await flush(0);
    await flush(400);
    expect(screen.getByText('Edit route · Snapped')).toBeOnTheScreen();
    // The chip it was saved on, the trail leg snapped from the saved line.
    expect(screen.getByLabelText('Roads')).toBeSelected();
    expect(mockRouteCalls).toHaveLength(0);
    expect(screen.getByText(/© OpenStreetMap/)).toBeOnTheScreen();
  });
});

/** A DEM tile rising 1 m per pixel row towards the north (so the profile has relief). */
const slopingTile = () => {
  const data = new Float32Array(256 * 256);
  for (let i = 0; i < data.length; i++) data[i] = 400 - Math.floor(i / 256);
  return Promise.resolve(data);
};

/** A responder event at `x` px on the profile (PanResponder reads the touch history). */
const profileTouch = (x: number) => ({
  nativeEvent: { locationX: x, locationY: 10, pageX: x, pageY: 10, touches: [], timestamp: 1 },
  touchHistory: {
    numberActiveTouches: 1,
    indexOfSingleActiveTouch: 0,
    mostRecentTimeStamp: 1,
    touchBank: [
      {
        touchActive: true,
        startPageX: x,
        startPageY: 10,
        startTimeStamp: 1,
        currentPageX: x,
        currentPageY: 10,
        currentTimeStamp: 1,
        previousPageX: x,
        previousPageY: 10,
        previousTimeStamp: 1,
      },
    ],
  },
});

/** Let the debounced, tile-by-tile elevation run finish under fake timers. */
async function settleElevation() {
  for (let i = 0; i < 12; i++) await flush(i === 0 ? 400 : 10);
}

const profileLabel = () =>
  String(screen.getByTestId('route-profile').props.accessibilityLabel ?? '');

describe('elevation profile while drawing (#515)', () => {
  it('unavailable elevation: no chart, the amber note instead', async () => {
    await mount();
    await act(async () => drawing().startRoute());
    await tap(P1);
    await tap(P2);
    await settleElevation();
    expect(screen.queryByTestId('route-profile')).toBeNull();
    expect(screen.getByText(/Climb unavailable here/)).toBeOnTheScreen();
  });

  it('shows the profile, dims it while a new leg is measured, then redraws it', async () => {
    mockFetchDem.mockImplementation(slopingTile);
    await mount();
    await act(async () => drawing().startRoute());
    await tap(P1);
    expect(screen.queryByTestId('route-profile')).toBeNull(); // one point: no line yet
    await tap(P2);
    await settleElevation();
    const first = profileLabel();
    expect(first).toMatch(/^Elevation profile, \d+ m, \d+ m to \d+ m$/);
    // The chart matches the climb stat (same samples).
    expect(screen.getByLabelText(/^climb \d+ m$/)).toBeOnTheScreen();

    await tap(P3);
    // The previous profile stays, dimmed, while the new leg is measured.
    expect(profileLabel()).toBe(`${first}, updating`);
    expect(screen.getByTestId('route-profile')).toHaveStyle({ opacity: 0.45 });
    await settleElevation();
    expect(profileLabel()).not.toMatch(/updating/);
    expect(profileLabel()).not.toBe(first); // longer route, new profile

    // Undo goes back to the first profile.
    await press('Undo');
    await settleElevation();
    expect(profileLabel()).toBe(first);
  });

  it('scrubbing the profile puts a marker on the drawn line and a readout; release clears', async () => {
    mockFetchDem.mockImplementation(slopingTile);
    await mount();
    await act(async () => drawing().startRoute());
    await tap(P1);
    await tap(P2);
    await settleElevation();
    const strip = screen.getByTestId('route-profile');
    await act(async () => {
      fireEvent(strip, 'layout', { nativeEvent: { layout: { width: 300, height: 68 } } });
    });
    const scrubMarker = () => {
      const shape = JSON.parse(mockSources.get('draw-shape') ?? '{"features":[]}') as {
        features: { properties: { role: string }; geometry: { coordinates: number[] } }[];
      };
      return shape.features.find((f) => f.properties.role === 'scrub')?.geometry.coordinates;
    };
    expect(scrubMarker()).toBeUndefined();
    await act(async () => {
      fireEvent(strip, 'responderGrant', profileTouch(0));
    });
    // At the left edge: the start of the line.
    expect(scrubMarker()?.[0]).toBeCloseTo(P1[0], 6);
    expect(scrubMarker()?.[1]).toBeCloseTo(P1[1], 6);
    expect(screen.getByTestId('route-profile-readout')).toHaveTextContent(
      /^0 m · \d+ m · [+−]?\d+ %$/,
    );
    await act(async () => {
      fireEvent(strip, 'responderMove', profileTouch(300));
    });
    expect(scrubMarker()?.[0]).toBeCloseTo(P2[0], 6);
    expect(scrubMarker()?.[1]).toBeCloseTo(P2[1], 6);
    await act(async () => {
      fireEvent(strip, 'responderRelease', profileTouch(300));
    });
    expect(scrubMarker()).toBeUndefined();
    expect(screen.queryByTestId('route-profile-readout')).toBeNull();
  });

  it('an area has no profile', async () => {
    mockFetchDem.mockImplementation(slopingTile);
    await mount();
    await act(async () => drawing().startArea());
    await tap(P1);
    await tap(P2);
    await tap(P3);
    await settleElevation();
    expect(screen.getByText('Draw an area')).toBeOnTheScreen();
    expect(screen.queryByTestId('route-profile')).toBeNull();
  });
});

/** The distance stat in metres (it reads "850 m" or "1.2 km"). */
const distanceM = () => {
  const m = /^distance ([\d.]+) (k?m)$/.exec(
    String(screen.getByLabelText(/^distance /).props.accessibilityLabel),
  );
  return m ? Number(m[1]) * (m[2] === 'km' ? 1000 : 1) : Number.NaN;
};
const estimateMin = () => {
  const label = String(screen.getByLabelText(/^estimated /).props.accessibilityLabel);
  const h = /(\d+) h/.exec(label);
  const min = /(\d+) min/.exec(label);
  return (h ? Number(h[1]) * 60 : 0) + (min ? Number(min[1]) : 0);
};

/** Open the Return chip's menu and pick an option. */
async function chooseFinish(label: 'One way' | 'Back and forth' | 'Loop') {
  await fireEvent.press(screen.getByTestId('return-chip'));
  await press(label);
}

describe('Back & forth (#515)', () => {
  it('doubles the route from the outbound line: stats, profile, no new routing; edits carry over', async () => {
    mockFetchDem.mockImplementation(slopingTile);
    await mount();
    await act(async () => drawing().startRoute());
    await press('Trails');
    await tap(P1);
    // One point: nothing to come back along yet.
    expect(screen.getByTestId('return-chip')).toBeDisabled();
    await tap(P2);
    await flush(400);
    await answer(bent);
    await settleElevation();
    const oneWay = distanceM();
    const oneWayMin = estimateMin();
    expect(screen.queryByTestId('route-profile-turnaround')).toBeNull();

    await chooseFinish('Back and forth');
    expect(screen.getByLabelText('Return, Back and forth')).toBeOnTheScreen();
    await settleElevation();
    // The return is the snapped outbound reversed: no routing request for it.
    expect(mockRouteCalls).toHaveLength(0);
    expect(distanceM()).toBeCloseTo(2 * oneWay, -2); // the stat rounds (1.2 km)
    expect(estimateMin()).toBeGreaterThan(oneWayMin);
    expect(profileLabel()).toMatch(/^Elevation profile, 1\.\d km/);
    await act(async () => {
      fireEvent(screen.getByTestId('route-profile'), 'layout', {
        nativeEvent: { layout: { width: 300, height: 68 } },
      });
    });
    expect(screen.getByTestId('route-profile-turnaround')).toBeTruthy();
    expect(profileLabel()).toMatch(/, out and back$/);

    // Extending the outbound routes only the new leg; the return follows.
    await tap(P3);
    await flush(400);
    expect(mockRouteCalls.map((c) => [c.from, c.to])).toEqual([[P2, P3]]);
    await answer(bent);
    await settleElevation();
    const longer = distanceM();
    expect(longer).toBeGreaterThan(2 * oneWay);
    await press('Undo');
    await settleElevation();
    expect(distanceM()).toBeCloseTo(2 * oneWay, -2); // the stat rounds (1.2 km)
    expect(mockRouteCalls).toHaveLength(0);

    await press('Save route');
    await press('Save route to Library');
    await flush(0);
    const [saved] = useLibraryStore.getState().tracks;
    expect(saved?.plan).toEqual({
      mode: 'trails',
      vertices: [P1, P2],
      legModes: ['trails'],
      finish: 'backforth',
    });
    // The GPX holds the whole there-and-back: it ends where it started.
    const xml = mockWriteTrackGpx.mock.calls[0]?.[1] ?? '';
    const pts = [...xml.matchAll(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)"/g)];
    expect(pts[0]?.slice(1)).toEqual(pts[pts.length - 1]?.slice(1));
    expect(pts.length % 2).toBe(1);
  });

  it('"Edit route" restores it on, with the outbound points editable, and asks for nothing', async () => {
    const corner: LngLat = [P1[0], P2[1]];
    mockLoadGeometry.mockResolvedValue({ parts: [[P1, corner, P2, corner, P1]] });
    await mount();
    await act(async () => {
      useLibraryStore.setState({
        tracks: [
          {
            id: 'r3',
            name: 'There and back',
            startedAt: 1,
            fileUri: 'file:///doc/tracks/r3.gpx',
            stats: {
              distanceM: 1,
              ascentM: 0,
              descentM: 0,
              durationS: 0,
              movingTimeS: 0,
              avgSpeedMps: 0,
              maxSpeedMps: 0,
              pointCount: 5,
            },
            plan: { mode: 'trails', vertices: [P1, P2], legModes: ['trails'], finish: 'backforth' },
          },
        ],
      });
    });
    await act(async () => {
      useMapStore.getState().setDrawRequest({ kind: 'edit-route', trackId: 'r3' });
    });
    await flush(0);
    await flush(400);
    expect(screen.getByText('Edit route · There and back')).toBeOnTheScreen();
    expect(screen.getByLabelText('Return, Back and forth')).toBeOnTheScreen();
    expect(mockRouteCalls).toHaveLength(0);
    // The leg came back snapped (via the corner), counted out and back.
    const legM = polylineLengthM([P1, corner, P2]);
    expect(distanceM()).toBeCloseTo(2 * legM, -2); // the stat rounds (1.2 km)
    // Turning it off: one way again.
    await chooseFinish('One way');
    expect(distanceM()).toBeCloseTo(legM, -2); // the stat rounds (1.2 km)
  });

  it('is not offered for an area', async () => {
    await mount();
    await act(async () => drawing().startArea());
    await tap(P1);
    await tap(P2);
    await tap(P3);
    expect(screen.queryByTestId('return-chip')).toBeNull();
  });
});

/** ~45 m east of P1: a last point near the start. */
const NEAR_P1: LngLat = [P1[0] + 0.0006, P1[1] + 0.0001];
/** ~30 m from P1 (40 px here, off its handle): too close for a two-point loop. */
const BY_P1: LngLat = [P1[0] + 0.0004, P1[1]];

describe('Return menu and Loop (#515)', () => {
  it('the Return chip opens a menu of three; Loop waits for a real way back', async () => {
    await mount();
    await act(async () => drawing().startRoute());
    await tap(P1);
    expect(screen.getByTestId('return-chip')).toBeDisabled();
    await tap(BY_P1);
    expect(screen.getByLabelText('Return, One way')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('return-chip'));
    expect(screen.getByTestId('return-menu')).toBeOnTheScreen();
    expect(screen.getByLabelText('One way')).toBeSelected();
    expect(screen.getByLabelText('Back and forth')).not.toBeDisabled();
    // Two points ~20 m apart: no loop yet, and the menu says why.
    expect(screen.getByLabelText('Loop')).toBeDisabled();
    expect(screen.getByText('Add a third point first')).toBeOnTheScreen();
    // A tap elsewhere on the panel closes it; so does a map tap.
    await fireEvent.press(screen.getByTestId('return-menu-backdrop'));
    expect(screen.queryByTestId('return-menu')).toBeNull();
    await fireEvent.press(screen.getByTestId('return-chip'));
    expect(drawing().onMapTap(P3, [P3[0] * 1e5, P3[1] * 1e5])).toBe(true);
    await flush(0);
    expect(screen.queryByTestId('return-menu')).toBeNull();
    // The map tap only closed the menu: no point was added.
    await tap(P3);
    await chooseFinish('Loop');
    expect(screen.queryByTestId('return-menu')).toBeNull();
    expect(screen.getByLabelText('Return, Loop')).toBeOnTheScreen();
    await chooseFinish('One way');
    expect(screen.getByLabelText('Return, One way')).toBeOnTheScreen();
  });

  it('a Freehand loop closes with a straight leg, counted in the stats and the profile', async () => {
    mockFetchDem.mockImplementation(slopingTile);
    await mount();
    await act(async () => drawing().startRoute());
    await tap(P1);
    await tap(P2);
    await tap(P3);
    await settleElevation();
    const open = distanceM();
    const openProfile = profileLabel();
    await chooseFinish('Loop');
    await settleElevation();
    expect(mockRouteCalls).toHaveLength(0);
    expect(distanceM()).toBeCloseTo(open + polylineLengthM([P3, P1]), -2);
    expect(profileLabel()).not.toBe(openProfile);
    await press('Save route');
    await press('Save route to Library');
    await flush(0);
    const [saved] = useLibraryStore.getState().tracks;
    expect(saved?.plan).toEqual({ mode: 'freehand', vertices: [P1, P2, P3], finish: 'loop' });
    // The GPX closes the loop.
    const xml = mockWriteTrackGpx.mock.calls[0]?.[1] ?? '';
    const pts = [...xml.matchAll(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)"/g)];
    expect(pts[pts.length - 1]?.slice(1)).toEqual(pts[0]?.slice(1));
  });

  it('a Trails loop routes its closing leg; failed, it is straight with Retry; edits re-route only it', async () => {
    await mount();
    await act(async () => drawing().startRoute());
    await press('Trails');
    await tap(P1);
    await tap(P2);
    await tap(P3);
    await flush(400);
    await answer(bent);
    await answer(bent);
    await chooseFinish('Loop');
    await flush(400);
    expect(mockRouteCalls.map((c) => [c.mode, c.from, c.to])).toEqual([['trails', P3, P1]]);
    await answer(() => ({ status: 'failed', reason: 'offline' }));
    expect(screen.getByText('One leg drawn straight (no connection)')).toBeOnTheScreen();
    await press('Retry');
    await flush(400);
    expect(mockRouteCalls.map((c) => [c.from, c.to])).toEqual([[P3, P1]]);
    await answer(bent);
    expect(screen.queryByText(/drawn straight/)).toBeNull();

    // Moving a middle point re-routes its two legs, not the closing leg.
    const mid: LngLat = [P2[0] + 0.001, P2[1] + 0.0005];
    await tap(P2);
    await act(async () => {
      mockGrip.current?.onMove?.(mid[0] * 1e5, mid[1] * 1e5);
      mockGrip.current?.onEnd?.(mid[0] * 1e5, mid[1] * 1e5);
    });
    await flush(400);
    // One at a time: P1→mid, then mid→P3 — and never the closing leg P3→P1.
    expect(mockRouteCalls.map((c) => [c.from, c.to])).toEqual([[P1, mid]]);
    await answer(bent);
    expect(mockRouteCalls.map((c) => [c.from, c.to])).toEqual([[mid, P3]]);
    await answer(bent);
    await flush(400);
    expect(mockRouteCalls).toHaveLength(0);
  });

  it('tapping the start closes the loop (not a new point); again does nothing; the tip shows once', async () => {
    await mount();
    await act(async () => drawing().startRoute());
    await tap(P1);
    await tap(P2);
    expect(screen.queryByTestId('loop-tip')).toBeNull();
    await tap(NEAR_P1);
    // The last point is near the start: the one-time tip.
    expect(screen.getByText('Tap the start to close the loop')).toBeOnTheScreen();
    await tap(P1);
    expect(screen.getByLabelText('Return, Loop')).toBeOnTheScreen();
    expect(screen.queryByTestId('loop-tip')).toBeNull();
    // No fourth point was added, and nothing got selected.
    expect(screen.queryByText(/selected$/)).toBeNull();
    await tap(P1);
    expect(screen.getByLabelText('Return, Loop')).toBeOnTheScreen();
    expect(screen.queryByText(/selected$/)).toBeNull();
    await press('Undo'); // undoes the last point, not the loop
    await press('Save route');
    await press('Save route to Library');
    await flush(0);
    expect(useLibraryStore.getState().tracks[0]?.plan).toMatchObject({
      vertices: [P1, P2],
      finish: 'loop',
    });
    // Retired: a new near-start route shows no tip.
    await act(async () => drawing().startRoute());
    await tap(P1);
    await tap(P2);
    await tap(NEAR_P1);
    expect(screen.queryByTestId('loop-tip')).toBeNull();
  });

  it('with fewer than 3 points, tapping the start selects it as before', async () => {
    await mount();
    await act(async () => drawing().startRoute());
    await tap(P1);
    await tap(P2);
    await tap(P1);
    expect(screen.getByText('Point 1 selected')).toBeOnTheScreen();
    expect(screen.getByLabelText('Return, One way')).toBeOnTheScreen();
  });

  it('"Edit route" restores a loop with its snapped closing leg, asking for nothing', async () => {
    const c1: LngLat = [P1[0], P2[1]];
    const c2: LngLat = [P2[0], P3[1]];
    const c3: LngLat = [P3[0], P1[1]];
    mockLoadGeometry.mockResolvedValue({ parts: [[P1, c1, P2, c2, P3, c3, P1]] });
    await mount();
    await act(async () => {
      useLibraryStore.setState({
        tracks: [
          {
            id: 'r4',
            name: 'Round',
            startedAt: 1,
            fileUri: 'file:///doc/tracks/r4.gpx',
            stats: {
              distanceM: 1,
              ascentM: 0,
              descentM: 0,
              durationS: 0,
              movingTimeS: 0,
              avgSpeedMps: 0,
              maxSpeedMps: 0,
              pointCount: 7,
            },
            plan: {
              mode: 'trails',
              vertices: [P1, P2, P3],
              legModes: ['trails', 'trails'],
              finish: 'loop',
            },
          },
        ],
      });
    });
    await act(async () => {
      useMapStore.getState().setDrawRequest({ kind: 'edit-route', trackId: 'r4' });
    });
    await flush(0);
    await flush(400);
    expect(screen.getByText('Edit route · Round')).toBeOnTheScreen();
    expect(screen.getByLabelText('Return, Loop')).toBeOnTheScreen();
    expect(mockRouteCalls).toHaveLength(0);
    const loopM = polylineLengthM([P1, c1, P2, c2, P3, c3, P1]);
    expect(distanceM()).toBeCloseTo(loopM, -2);
  });
});
