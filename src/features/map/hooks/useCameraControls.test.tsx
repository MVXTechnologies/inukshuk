import type { CameraRef, MapRef } from '@maplibre/maplibre-react-native';
import { act, renderHook } from '@testing-library/react-native';
import { useMapStore } from '@state/mapStore';
import { createRef } from 'react';

import { useCameraControls } from './useCameraControls';

/**
 * #710 — "On map" from a trail sets focusBounds and goes to the map tab. The
 * fit used to run at once: on the hidden map's camera, while it still
 * followed the GPS dot, so the trail was never framed.
 */
const BBOX = { minLat: 46.78, minLng: -71.3, maxLat: 46.84, maxLng: -71.18 };

async function harness(ready: boolean) {
  const fitBounds = jest.fn();
  const cameraRef = createRef<CameraRef | null>() as { current: CameraRef | null };
  cameraRef.current = { flyTo: jest.fn(), fitBounds } as unknown as CameraRef;
  const mapRef = createRef<MapRef | null>();
  const hook = await renderHook(
    (p: { ready: boolean }) =>
      useCameraControls({ cameraRef, mapRef, overlays: [], ready: p.ready }),
    { initialProps: { ready } },
  );
  return { fitBounds, hook };
}

beforeEach(() => {
  useMapStore.setState({ followUser: true, focusBounds: null, focusPadding: null });
});

describe('a "fit these bounds" request (#710)', () => {
  it('waits for the map screen, turns follow off, then frames the trail once', async () => {
    const { fitBounds, hook } = await harness(false);
    // Asked from the trail screen: the map tab is not up yet.
    await act(async () => useMapStore.getState().setFocusBounds(BBOX));
    expect(fitBounds).not.toHaveBeenCalled();
    expect(useMapStore.getState().focusBounds).toEqual(BBOX);
    // The map is back: follow goes off first, then the fit.
    await hook.rerender({ ready: true });
    expect(useMapStore.getState().followUser).toBe(false);
    expect(fitBounds).toHaveBeenCalledTimes(1);
    expect(fitBounds).toHaveBeenCalledWith([-71.3, 46.78, -71.18, 46.84], {
      duration: 600,
      padding: { top: 60, right: 60, bottom: 220, left: 60 },
    });
    expect(useMapStore.getState().focusBounds).toBeNull();
    await hook.rerender({ ready: true });
    expect(fitBounds).toHaveBeenCalledTimes(1);
  });

  it('on a map already up and not following, fits at once', async () => {
    useMapStore.setState({ followUser: false });
    const { fitBounds } = await harness(true);
    await act(async () =>
      useMapStore.getState().setFocusBounds(BBOX, { top: 1, right: 2, bottom: 3, left: 4 }),
    );
    expect(fitBounds).toHaveBeenCalledWith([-71.3, 46.78, -71.18, 46.84], {
      duration: 600,
      padding: { top: 1, right: 2, bottom: 3, left: 4 },
    });
  });
});
