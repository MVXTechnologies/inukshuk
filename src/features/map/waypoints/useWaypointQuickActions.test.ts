import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { useWaypointMoveStore } from '@state/waypointMoveStore';
import { act, renderHook } from '@testing-library/react-native';

import { useActionSnackbar } from '../../common/useActionSnackbar';
import { useWaypointQuickActions } from './useWaypointQuickActions';
import { useWaypointClusterSheet } from './waypointTap';

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  newId: () => 'w_' + Math.random().toString(36).slice(2, 8),
  deleteFileAt: jest.fn(),
  writeIndex: jest.fn(),
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

const FIX = { latitude: 46.81394, longitude: -71.20761 };
const waypoints = () => useLibraryStore.getState().waypoints;

beforeEach(() => {
  useLibraryStore.setState({ hydrated: true, waypoints: [] });
  useWaypointMoveStore.setState({ moving: null });
  useMapStore.setState({ mapCenter: null });
});

type Options = Parameters<typeof useWaypointQuickActions>[0];

async function setup(over: Partial<Omit<Options, 'snack'>> = {}) {
  const options = {
    location: FIX,
    accuracyM: 5,
    units: 'metric' as const,
    onEdit: jest.fn(),
    onBeforeMove: jest.fn(),
    getCenter: jest.fn(async () => null),
    ...over,
  };
  const hook = await renderHook(() =>
    useWaypointQuickActions({ ...options, snack: useActionSnackbar(8000) }),
  );
  return { ...hook, options };
}

describe('one-tap Add waypoint (#671)', () => {
  it('saves at the fix immediately and offers EDIT and UNDO', async () => {
    const { result } = await setup();
    await act(async () => result.current.addAtFix());
    expect(waypoints()).toHaveLength(1);
    expect(waypoints()[0]).toMatchObject({ ...FIX, label: 'Waypoint 1' });
    const snack = result.current.snack.current;
    expect(snack?.message).toBe('Waypoint 1 added at your position');
    expect(snack?.actions.map((a) => a.label)).toEqual(['Edit', 'Undo']);
  });

  it('EDIT opens the editor on that waypoint', async () => {
    const { result, options } = await setup();
    await act(async () => result.current.addAtFix());
    const id = waypoints()[0]?.id;
    await act(async () => result.current.snack.current?.actions[0]?.onPress());
    expect(options.onEdit).toHaveBeenCalledWith(id);
  });

  it('UNDO deletes it', async () => {
    const { result } = await setup();
    await act(async () => result.current.addAtFix());
    await act(async () => result.current.snack.current?.actions[1]?.onPress());
    expect(waypoints()).toHaveLength(0);
  });

  it('warns only when the fix is worse than 10 m', async () => {
    const { result } = await setup({ accuracyM: 24 });
    await act(async () => result.current.addAtFix());
    expect(result.current.snack.current?.message).toBe(
      'Waypoint 1 added at your position · ±24 m, low accuracy',
    );
  });

  it('before a fix: says so, saves nothing, and never drops later', async () => {
    const { result, rerender } = await setup({ location: null });
    expect(result.current.addHint).toBe('Waiting for a GPS fix…');
    await act(async () => result.current.addAtFix());
    expect(result.current.snack.current?.message).toBe('Waiting for a GPS fix…');
    expect(result.current.snack.current?.actions).toEqual([]);
    await rerender({});
    expect(waypoints()).toHaveLength(0);
  });
});

describe('one-tap Add waypoint at the centre cursor (#709)', () => {
  const CENTRE = { latitude: 46.815, longitude: -71.205 };

  it('saves at the centre read from the camera, with EDIT and UNDO', async () => {
    useMapStore.setState({ followUser: false });
    const { result } = await setup({ getCenter: jest.fn(async () => CENTRE) });
    await act(async () => result.current.addAtCursor());
    expect(waypoints()[0]).toMatchObject({ ...CENTRE, label: 'Waypoint 1' });
    const snack = result.current.snack.current;
    expect(snack?.message).toBe('Waypoint 1 added at the map centre');
    expect(snack?.actions.map((a) => a.label)).toEqual(['Edit', 'Undo']);
    await act(async () => result.current.snack.current?.actions[1]?.onPress());
    expect(waypoints()).toHaveLength(0);
  });

  it('needs no GPS fix', async () => {
    useMapStore.setState({ followUser: false });
    const { result } = await setup({ location: null, getCenter: jest.fn(async () => CENTRE) });
    await act(async () => result.current.addAtCursor());
    expect(waypoints()[0]).toMatchObject(CENTRE);
  });

  it('falls back to the settled centre when the camera cannot be read', async () => {
    useMapStore.setState({ followUser: false, mapCenter: CENTRE });
    const { result } = await setup({ getCenter: jest.fn(async () => Promise.reject(new Error())) });
    await act(async () => result.current.addAtCursor());
    expect(waypoints()[0]).toMatchObject(CENTRE);
  });

  it('before any camera: says so and saves nothing', async () => {
    useMapStore.setState({ followUser: false, mapCenter: null });
    const { result } = await setup();
    await act(async () => result.current.addAtCursor());
    expect(waypoints()).toHaveLength(0);
    expect(result.current.snack.current?.message).toBe(
      'The map is still loading. Try again in a moment.',
    );
  });

  it('while the map follows you, the cursor is you: the same drop as Pin my location', async () => {
    useMapStore.setState({ followUser: true });
    const getCenter = jest.fn(async () => CENTRE);
    const { result } = await setup({ getCenter });
    await act(async () => result.current.addAtCursor());
    expect(waypoints()[0]).toMatchObject(FIX);
    expect(result.current.snack.current?.message).toBe('Waypoint 1 added at your position');
    expect(getCenter).not.toHaveBeenCalled();
  });
});

describe('Move (#676)', () => {
  async function withWaypoint() {
    const id = useLibraryStore.getState().addWaypoint(FIX.latitude, FIX.longitude, 'Camp lac');
    useLibraryStore.getState().updateWaypoint(id, { icon: 'camp', color: '#E8612C', size: 'L' });
    return id;
  }

  it('starts on a saved waypoint, bringing it under the centre first', async () => {
    const id = await withWaypoint();
    const { result, options } = await setup();
    // A cluster list left open (the pin was picked from it) closes as Move starts.
    useWaypointClusterSheet.getState().open(['saved-x', 'saved-y']);
    await act(async () => result.current.startMove(id));
    expect(useWaypointClusterSheet.getState().keys).toBeNull();
    expect(options.onBeforeMove).toHaveBeenCalledWith(FIX);
    expect(useWaypointMoveStore.getState().moving).toEqual({
      id,
      label: 'Camp lac',
      from: FIX,
      icon: 'camp',
      color: '#E8612C',
      size: 'L',
    });
  });

  it('Confirm saves the map centre and offers UNDO back to the old place', async () => {
    const id = await withWaypoint();
    const to = { latitude: 46.81418, longitude: -71.20726 };
    const { result } = await setup({ getCenter: jest.fn(async () => to) });
    await act(async () => result.current.startMove(id));
    await act(async () => result.current.confirmMove());
    expect(useWaypointMoveStore.getState().moving).toBeNull();
    expect(waypoints()[0]).toMatchObject(to);
    expect(result.current.snack.current?.message).toBe('Moved 38 m');
    await act(async () => result.current.snack.current?.actions[0]?.onPress());
    expect(waypoints()[0]).toMatchObject(FIX);
  });

  it('falls back to the settled centre when the camera cannot be read', async () => {
    const id = await withWaypoint();
    const to = { latitude: 46.815, longitude: -71.207 };
    useMapStore.setState({ mapCenter: to });
    const { result } = await setup({ getCenter: jest.fn(async () => Promise.reject(new Error())) });
    await act(async () => result.current.startMove(id));
    await act(async () => result.current.confirmMove());
    expect(waypoints()[0]).toMatchObject(to);
  });

  it('Confirm without moving says nothing and changes nothing', async () => {
    const id = await withWaypoint();
    const { result } = await setup({ getCenter: jest.fn(async () => FIX) });
    await act(async () => result.current.startMove(id));
    await act(async () => result.current.confirmMove());
    expect(result.current.snack.current).toBeNull();
    expect(waypoints()[0]).toMatchObject(FIX);
  });

  it('Cancel leaves the waypoint where it was', async () => {
    const id = await withWaypoint();
    const { result } = await setup();
    await act(async () => result.current.startMove(id));
    await act(async () => result.current.cancelMove());
    expect(useWaypointMoveStore.getState().moving).toBeNull();
    expect(waypoints()[0]).toMatchObject(FIX);
  });

  it('keeps its handlers’ identity across renders (MapScreen memo deps)', async () => {
    const { result, rerender } = await setup();
    const first = result.current;
    await rerender({});
    expect(result.current.addAtFix).toBe(first.addAtFix);
    expect(result.current.startMove).toBe(first.startMove);
    expect(result.current.confirmMove).toBe(first.confirmMove);
  });
});
