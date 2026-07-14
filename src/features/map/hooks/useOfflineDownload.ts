import { dedupeLabel } from '@core/geo/regionName';
import type { Basemap } from '@core/geo/tiles';
import type { BoundingBox } from '@core/models';
import { setOfflineOnly } from '@data/offline';
import * as storage from '@data/storage';
import type { CameraRef, MapRef } from '@maplibre/maplibre-react-native';
import { useOfflineStore } from '@state/offlineStore';
import { useSettingsStore } from '@state/settingsStore';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { buildOsmStyle } from '../mapStyle';
import { resolveRegionName } from '../regionNaming';

/**
 * Offline-region download orchestration for the map screen: region-select
 * state, the cached-bounds screen→geo conversion that feeds the live size
 * estimate, the camera flatten on entry, and the download kick-off + progress.
 */
export function useOfflineDownload({
  mapRef,
  cameraRef,
  showSnack,
}: {
  mapRef: RefObject<MapRef | null>;
  cameraRef: RefObject<CameraRef | null>;
  showSnack: (message: string) => void;
}) {
  const [mapSize, setMapSize] = useState({ w: 0, h: 0 });
  const [selecting, setSelecting] = useState(false);
  const tileUrl = useSettingsStore((s) => s.tileUrl);
  const offlineOnly = useSettingsStore((s) => s.offlineOnly);
  const settingsHydrated = useSettingsStore((s) => s.hydrated);
  const downloadProgress = useOfflineStore((s) => s.progress);

  // Convert a screen point (px) to [lng, lat] using the current map bounds.
  // Cache of the map's visible bounds [west, south, east, north]. Kept fresh by
  // onRegionDidChange and seeded when the download overlay opens, so the
  // screen→geo conversion below is SYNCHRONOUS — letting the region-select
  // estimate update live as the box is reshaped (getBounds() is async, which
  // forced a debounce that only landed the estimate after the drag released).
  const boundsRef = useRef<[number, number, number, number] | null>(null);
  const refreshBounds = useCallback(async () => {
    const b = await mapRef.current?.getBounds();
    if (b) boundsRef.current = b as [number, number, number, number];
  }, [mapRef]);

  // Screen point (px) → [lng, lat], synchronously, from the cached bounds.
  const toGeo = useCallback(
    ({ x, y }: { x: number; y: number }): [number, number] | null => {
      const b = boundsRef.current;
      if (!b || mapSize.w === 0 || mapSize.h === 0) return null;
      const [w, s, e, n] = b;
      const fx = Math.max(0, Math.min(1, x / mapSize.w));
      const fy = Math.max(0, Math.min(1, y / mapSize.h));
      return [w + fx * (e - w), n - fy * (n - s)]; // north at top; linear approx
    },
    [mapSize],
  );

  // Apply the persisted offlineOnly flag once settings hydrate. Child effects
  // run before RootLayout's, so a mount-only effect always saw the default
  // (false) and a persisted "Locally downloaded only" was silently ignored
  // until manually re-toggled. Re-runs on later changes to stay in sync.
  useEffect(() => {
    if (settingsHydrated) setOfflineOnly(offlineOnly);
  }, [settingsHydrated, offlineOnly]);
  // Hydrate offline tile regions on mount.
  useEffect(() => {
    void useOfflineStore.getState().hydrate();
  }, []);

  const onMapLayout = useCallback((e: LayoutChangeEvent) => {
    setMapSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  }, []);

  const beginRegionSelect = () => {
    // "Locally downloaded only" cuts MapLibre's network process-wide, which
    // would stall a download (it can't fetch tiles). Rather than fight that
    // at runtime, require the user to turn it off first.
    if (offlineOnly) {
      showSnack("Turn off 'Locally downloaded only' to download a new area");
      return;
    }
    // The region box uses a linear screen→geo projection that is only
    // valid for a north-up, unpitched 2D map, so flatten the camera first.
    cameraRef.current?.setStop({ bearing: 0, pitch: 0, duration: 300 });
    void refreshBounds(); // seed the bounds cache so the estimate is ready
    setSelecting(true);
  };

  const cancelRegionSelect = () => setSelecting(false);

  const confirmDownload = (
    bounds: BoundingBox,
    basemaps: Basemap[],
    minZoom: number,
    maxZoom: number,
  ) => {
    setSelecting(false);
    const baseId = storage.newId();

    // Resolve a memorable name for the region (nearest village / named lake)
    // in the background — the user is online right now by definition. Naming
    // never blocks or fails the download: the "Offline map" placeholder simply
    // stays if both geocoders come up empty. All the download's layers share
    // the resolved name (they're one region to the user).
    void (async () => {
      try {
        const name = await resolveRegionName({
          lat: (bounds.minLat + bounds.maxLat) / 2,
          lng: (bounds.minLng + bounds.maxLng) / 2,
        });
        if (name === null) return;
        const store = useOfflineStore.getState();
        const label = dedupeLabel(
          name,
          store.regions.map((r) => r.label),
        );
        await store.rename(
          basemaps.map((bm) => `${baseId}-${bm}`),
          label,
        );
      } catch {
        // Naming is strictly best-effort.
      }
    })();

    void (async () => {
      try {
        await useOfflineStore.getState().downloadMany({
          baseId,
          label: 'Offline map',
          bounds,
          minZoom,
          maxZoom,
          layers: basemaps.map((bm) => ({
            basemap: bm,
            styleJSON: JSON.stringify(buildOsmStyle(tileUrl, false, bm)),
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showSnack('Download failed: ' + message);
      }
    })();
  };

  return {
    selecting,
    downloadProgress,
    toGeo,
    refreshBounds,
    onMapLayout,
    beginRegionSelect,
    cancelRegionSelect,
    confirmDownload,
  };
}
