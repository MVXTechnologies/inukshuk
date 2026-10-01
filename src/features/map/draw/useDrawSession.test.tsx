/**
 * The drawing session's on-screen half (#502/#503): the live drag preview,
 * committing a drag as a move, a midpoint drag/tap as an insert, a vertex tap
 * as select (whose delete button removes it), and the handles' revision.
 */
import type { LngLat } from '@core/models';
import { act, renderHook } from '@testing-library/react-native';

import { useDrawSession } from './useDrawSession';

const A: LngLat = [-71.21, 46.81];
const B: LngLat = [-71.2, 46.812];
const C: LngLat = [-71.19, 46.811];

async function setup(vertices: LngLat[] = [A, C]) {
  const hook = await renderHook(() => useDrawSession());
  await act(async () => hook.result.current.start({ kind: 'route' }, vertices));
  return hook;
}

describe('useDrawSession', () => {
  it('is closed until started, and exit closes it', async () => {
    const hook = await renderHook(() => useDrawSession());
    expect(hook.result.current.state).toBeNull();
    await act(async () => hook.result.current.start({ kind: 'area', areaId: 'a1' }, [A, B, C]));
    expect(hook.result.current.state?.vertices).toEqual([A, B, C]);
    expect(hook.result.current.target).toEqual({ kind: 'area', areaId: 'a1' });
    await act(async () => hook.result.current.exit());
    expect(hook.result.current.state).toBeNull();
    expect(hook.result.current.target).toBeNull();
  });

  it('a vertex drag previews live, then commits one undoable move', async () => {
    const { result } = await setup();
    const rev = result.current.revision;
    await act(async () => result.current.handles.onVertexDrag(1, B));
    expect(result.current.shown).toEqual([A, B]);
    expect(result.current.state?.vertices).toEqual([A, C]); // not committed yet
    await act(async () => result.current.handles.onVertexDragEnd(1, B));
    expect(result.current.state?.vertices).toEqual([A, B]);
    expect(result.current.shown).toEqual([A, B]);
    expect(result.current.revision).toBeGreaterThan(rev);
    await act(async () => result.current.dispatch({ type: 'undo' }));
    expect(result.current.state?.vertices).toEqual([A, C]);
  });

  it('a midpoint drag previews an inserted vertex and commits an insert', async () => {
    const { result } = await setup();
    await act(async () => result.current.handles.onMidpointDrag(1, B));
    expect(result.current.shown).toEqual([A, B, C]);
    await act(async () => result.current.handles.onMidpointDragEnd(1, B));
    expect(result.current.state?.vertices).toEqual([A, B, C]);
  });

  it('a midpoint tap inserts at the midpoint', async () => {
    const { result } = await setup();
    await act(async () => result.current.handles.onMidpointPress(1, [-71.2, 46.8105]));
    expect(result.current.state?.vertices).toEqual([A, [-71.2, 46.8105], C]);
  });

  it('a vertex tap toggles its selection (re-keying the handles); delete removes it', async () => {
    const { result } = await setup([A, B, C]);
    const rev = result.current.revision;
    await act(async () => result.current.handles.onVertexPress(1));
    expect(result.current.state?.selected).toBe(1);
    expect(result.current.revision).toBeGreaterThan(rev);
    await act(async () => result.current.handles.onVertexPress(1));
    expect(result.current.state?.selected).toBeNull();
    await act(async () => result.current.handles.onVertexPress(2));
    await act(async () => result.current.dispatch({ type: 'remove', index: 2 }));
    expect(result.current.state?.vertices).toEqual([A, B]);
    expect(result.current.state?.selected).toBeNull();
  });

  it('dispatch is a no-op while closed', async () => {
    const hook = await renderHook(() => useDrawSession());
    await act(async () => hook.result.current.dispatch({ type: 'add', at: A }));
    expect(hook.result.current.state).toBeNull();
    await act(async () => hook.result.current.handles.onVertexPress(0));
    expect(hook.result.current.state).toBeNull();
  });
});
