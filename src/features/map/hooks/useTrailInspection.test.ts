/**
 * `inspect` must keep one identity across renders: the drawing tool closes the
 * inspect panel through it (MapScreen's `closeForDrawing`), and a fresh
 * function each render re-armed — and so cancelled — the deferred
 * "Edit route" request from the panel on every map re-render.
 */
import type { TrackSummary } from '@core/models';
import { act, renderHook } from '@testing-library/react-native';

import { useTrailInspection } from './useTrailInspection';

jest.mock('@data/storage', () => ({
  readFileText: jest.fn(async () => '<gpx></gpx>'),
}));

const TRACKS: TrackSummary[] = [];

describe('useTrailInspection', () => {
  it('keeps inspect stable across renders and state changes', async () => {
    const { result, rerender } = await renderHook(() => useTrailInspection(TRACKS));
    const first = result.current.inspect;
    await rerender({});
    expect(result.current.inspect).toBe(first);
    await act(async () => {
      result.current.inspect('t1');
    });
    expect(result.current.inspectId).toBe('t1');
    expect(result.current.inspect).toBe(first);
  });
});
