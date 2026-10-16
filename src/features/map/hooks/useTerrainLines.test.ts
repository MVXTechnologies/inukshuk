/**
 * #735: every line overlay hands its lines to the 3D scene as its own group
 * (a change re-sends that group only), clears it when it goes, and sends
 * nothing in 2D; taps land on the relief through the native unprojection.
 * Measured in native calls.
 */
import { groupIndex, groupLines } from '@core/terrain3d/lineGroups';
import { useTerrainViewStore } from '@state/terrainViewStore';
import { act, renderHook } from '@testing-library/react-native';
import { terrainLngLat, useTerrainLineGroup, useTerrainView } from './useTerrainLines';

const mockSetLineGroup = jest.fn((_tag: number, _group: number, _lines: unknown[]) => undefined);
const mockUnproject = jest.fn((_tag: number, x: number, y: number): [number, number] | null =>
  y < 100 ? null : [7 + x / 1000, 46 + y / 1000],
);
jest.mock('@lib/nativeTerrain', () => ({
  nativeTerrain: () => ({ setLineGroup: mockSetLineGroup, unproject: mockUnproject }),
}));

const style = { color: '#c2410c', halo: '#ffffff', haloOpacity: 1, width: 3, haloAdd: 2, order: 0 };
const lines = (n: number) =>
  groupLines(
    'teamDrawings',
    [
      {
        geometry: {
          type: 'LineString',
          coordinates: Array.from({ length: n }, (_, i) => [7 + i * 0.001, 46]),
        },
      },
    ],
    style,
  );

beforeEach(() => {
  mockSetLineGroup.mockClear();
  mockUnproject.mockClear();
  useTerrainViewStore.getState().setViewTag(null);
});

describe('useTerrainLineGroup', () => {
  it('sends nothing in 2D', async () => {
    await renderHook(() => useTerrainLineGroup('teamDrawings', lines(3)));
    expect(mockSetLineGroup).not.toHaveBeenCalled();
  });

  it('sends its group once per change, and clears it on unmount', async () => {
    useTerrainViewStore.getState().setViewTag(9);
    const a = lines(3);
    const { rerender, unmount } = await renderHook(
      ({ l }: { l: ReturnType<typeof lines> }) => useTerrainLineGroup('teamDrawings', l),
      { initialProps: { l: a } },
    );
    expect(mockSetLineGroup).toHaveBeenCalledTimes(1);
    expect(mockSetLineGroup).toHaveBeenLastCalledWith(9, groupIndex('teamDrawings'), a);
    await rerender({ l: a }); // same lines: nothing sent
    expect(mockSetLineGroup).toHaveBeenCalledTimes(1);
    const b = lines(4);
    await rerender({ l: b });
    expect(mockSetLineGroup).toHaveBeenCalledTimes(2);
    expect(mockSetLineGroup).toHaveBeenLastCalledWith(9, groupIndex('teamDrawings'), b);
    await unmount();
    expect(mockSetLineGroup).toHaveBeenLastCalledWith(9, groupIndex('teamDrawings'), []);
  });

  it('follows 3D on and off', async () => {
    const { result } = await renderHook(() => useTerrainView());
    expect(result.current).toBeNull();
    await act(async () => useTerrainViewStore.getState().setViewTag(4));
    expect(result.current).toBe(4);
  });
});

describe('terrainLngLat', () => {
  it('is the relief point under the screen point in 3D, null in 2D or the sky', () => {
    expect(terrainLngLat(null, 200, 300)).toBeNull();
    expect(mockUnproject).not.toHaveBeenCalled();
    expect(terrainLngLat(9, 200, 300)).toEqual([7.2, 46.3]);
    expect(terrainLngLat(9, 200, 50)).toBeNull(); // the sky: the caller keeps MapLibre's answer
  });
});
