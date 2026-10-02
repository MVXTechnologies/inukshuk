import { cameraTargetFor } from '@core/search/camera';
import type { Place } from '@core/search/place';
import type { CameraRef, MapRef } from '@maplibre/maplibre-react-native';
import { act, render, renderHook, screen } from '@testing-library/react-native';
import { useMapStore } from '@state/mapStore';
import { createRef } from 'react';
import { useCameraControls } from '../hooks/useCameraControls';
import { SearchHitMarker } from './SearchHitMarker';

/**
 * What a pick does to the map (#496): the camera command (a fly-to at the
 * type's zoom, or the outline framed) through `useCameraControls.flyToPlace`
 * — exactly the call MapScreen's `onPickPlace` makes with
 * `cameraTargetFor(place)` — and the highlight marker it drops.
 */

const PEAK: Place = {
  id: 'osm:N1',
  source: 'index',
  type: 'peak',
  name: 'Mont Sainte-Anne',
  latitude: 47.0874,
  longitude: -70.932,
};

const LAKE: Place = {
  id: 'osm:R2',
  source: 'index',
  type: 'lake',
  name: 'Lac Saint-Jean',
  latitude: 48.6,
  longitude: -72.1,
  bbox: [-72.4, 48.4, -71.8, 48.9],
};

async function cameraHarness() {
  const flyTo = jest.fn();
  const fitBounds = jest.fn();
  const cameraRef = createRef<CameraRef | null>() as { current: CameraRef | null };
  cameraRef.current = { flyTo, fitBounds } as unknown as CameraRef;
  const mapRef = createRef<MapRef | null>();
  const hook = await renderHook(() => useCameraControls({ cameraRef, mapRef, overlays: [] }));
  return { flyTo, fitBounds, flyToPlace: hook.result.current.flyToPlace };
}

beforeEach(() => {
  useMapStore.setState({ followUser: true });
});

describe('picking a place', () => {
  it('flies to a peak at z14 and stops following the user', async () => {
    const { flyTo, fitBounds, flyToPlace } = await cameraHarness();
    await act(async () => flyToPlace(cameraTargetFor(PEAK)));
    expect(flyTo).toHaveBeenCalledWith({ center: [-70.932, 47.0874], zoom: 14, duration: 800 });
    expect(fitBounds).not.toHaveBeenCalled();
    expect(useMapStore.getState().followUser).toBe(false);
  });

  it('frames a lake by its outline', async () => {
    const { flyTo, fitBounds, flyToPlace } = await cameraHarness();
    await act(async () => flyToPlace(cameraTargetFor(LAKE)));
    expect(fitBounds).toHaveBeenCalledWith(
      [-72.4, 48.4, -71.8, 48.9],
      expect.objectContaining({ duration: 800 }),
    );
    expect(flyTo).not.toHaveBeenCalled();
  });

  it('marks the spot with the place name', async () => {
    await render(<SearchHitMarker place={PEAK} />);
    expect(screen.getByLabelText('Search result: Mont Sainte-Anne')).toBeTruthy();
    expect(screen.getByText('Mont Sainte-Anne')).toBeTruthy();
  });
});
