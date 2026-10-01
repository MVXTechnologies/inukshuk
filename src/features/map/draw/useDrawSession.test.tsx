/**
 * The drawing session's on-screen half (#502/#503): taps routed by what they
 * hit (vertex → select, midpoint → insert + select, elsewhere → add or
 * deselect), the live drag preview, and a drag committed as one move.
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

  it('a bare tap adds; a tap on a vertex toggles its selection; a tap away deselects', async () => {
    const { result } = await setup([A]);
    await act(async () => result.current.tap(B, null));
    expect(result.current.state?.vertices).toEqual([A, B]);
    await act(async () => result.current.tap(B, { kind: 'vertex', index: 1 }));
    expect(result.current.state?.selected).toBe(1);
    await act(async () => result.current.tap(C, null)); // deselects, adds nothing
    expect(result.current.state?.selected).toBeNull();
    expect(result.current.state?.vertices).toEqual([A, B]);
    await act(async () => result.current.tap(A, { kind: 'vertex', index: 0 }));
    await act(async () => result.current.tap(A, { kind: 'vertex', index: 0 }));
    expect(result.current.state?.selected).toBeNull();
  });

  it('a tap on a midpoint inserts a vertex there and selects it', async () => {
    const { result } = await setup();
    await act(async () => result.current.tap(B, { kind: 'midpoint', index: 0 }));
    expect(result.current.state?.vertices).toEqual([A, [(A[0] + C[0]) / 2, (A[1] + C[1]) / 2], C]);
    expect(result.current.state?.selected).toBe(1);
    // A stale midpoint index is ignored.
    await act(async () => result.current.tap(B, { kind: 'midpoint', index: 9 }));
    expect(result.current.state?.vertices).toHaveLength(3);
  });

  it('a drag previews live, then commits one undoable move (point stays selected)', async () => {
    const { result } = await setup();
    await act(async () => result.current.dragTo(1, B));
    expect(result.current.shown).toEqual([A, B]);
    expect(result.current.state?.vertices).toEqual([A, C]); // not committed yet
    await act(async () => result.current.dragEnd(1, B));
    expect(result.current.state?.vertices).toEqual([A, B]);
    expect(result.current.shown).toEqual([A, B]);
    expect(result.current.state?.selected).toBe(1);
    await act(async () => result.current.dispatch({ type: 'undo' }));
    expect(result.current.state?.vertices).toEqual([A, C]);
  });

  it('a cancelled drag drops the preview and changes nothing', async () => {
    const { result } = await setup();
    await act(async () => result.current.dragTo(0, B));
    await act(async () => result.current.dragEnd(0, null));
    expect(result.current.shown).toEqual([A, C]);
    expect(result.current.state?.past).toHaveLength(0);
  });

  it('is a no-op while closed', async () => {
    const hook = await renderHook(() => useDrawSession());
    await act(async () => hook.result.current.tap(A, null));
    await act(async () => hook.result.current.dragEnd(0, A));
    await act(async () => hook.result.current.dispatch({ type: 'add', at: A }));
    expect(hook.result.current.state).toBeNull();
  });
});
