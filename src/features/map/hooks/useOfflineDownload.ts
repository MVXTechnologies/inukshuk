import { dedupeLabel } from '@core/geo/regionName';
import { screenPointToLngLat, screenRectToBounds, type ScreenRect } from '@core/geo/screenBounds';
import { overviewZoomFor, packZoomRange, type Basemap } from '@core/geo/tiles';
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

/** Tolerance (degrees) within which the camera counts as flat and north-up. */
const FLAT_EPSILON = 0.5;
/** How long to wait for a camera flatten to settle before re-reading bounds. */
const FLATTEN_MS = 350;

const isFlat = (bearing: number, pitch: number): boolean => {
  const off = Math.abs(((((bearing + 180) % 360) + 360) % 360) - 180); // → [0, 180]
  return pitch <= FLAT_EPSILON && off <= FLAT_EPSILON;
};

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

  // Cache of the map's visible bounds [west, south, east, north]. Kept fresh by
  // onRegionDidChange, so the screen→geo conversion below is SYNCHRONOUS —
  // letting the region-select estimate update live as the box is reshaped
  // (getBounds() is async, which forced a debounce that only landed the estimate
  // after the drag released).
  //
  // Only bounds read from a FLAT, NORTH-UP camera are cached. On a pitched map
  // the visible region is a trapezoid running to the horizon and its bounding
  // box is far bigger than the viewport rectangle; on a rotated map it is the
  // bbox of a tilted rectangle. Mapping the drawn box against either yields a
  // geographic region much larger than what the user framed — which is exactly
  // what shipped: `beginRegionSelect` kicked off the flatten animation and read
  // the bounds in the same tick, so the box was measured against the *pre-
  // flatten* camera and the download overshot the selection.
  const boundsRef = useRef<[number, number, number, number] | null>(null);
  // Bumped whenever the cached bounds change, so consumers can recompute geometry
  // for an unchanged box (e.g. the map panned, or the flatten finally settled).
  const [boundsVersion, setBoundsVersion] = useState(0);

  const refreshBounds = useCallback(async () => {
    const view = await mapRef.current?.getViewState().catch(() => undefined);
    if (!view || !isFlat(view.bearing, view.pitch)) return;
    const next = view.bounds as [number, number, number, number];
    const prev = boundsRef.current;
    if (prev && prev.every((v, i) => v === next[i])) return;
    boundsRef.current = next;
    setBoundsVersion((v) => v + 1);
  }, [mapRef]);

  /**
   * The visible bounds of a flat, north-up camera — flattening it first if the
   * user tilted/rotated the map while the selector was open. `null` when the map
   * won't report a flat viewport (nothing trustworthy to convert the box with).
   */
  const flatBounds = useCallback(async (): Promise<[number, number, number, number] | null> => {
    const view = await mapRef.current?.getViewState().catch(() => undefined);
    if (view && !isFlat(view.bearing, view.pitch)) {
      await cameraRef.current
        ?.setStop({ bearing: 0, pitch: 0, duration: 0 })
        .catch(() => undefined);
      await delay(FLATTEN_MS);
    }
    await refreshBounds();
    return boundsRef.current;
  }, [mapRef, cameraRef, refreshBounds]);

  // Screen point (px) → [lng, lat], synchronously, from the cached flat bounds.
  const toGeo = useCallback(
    (point: { x: number; y: number }): [number, number] | null => {
      const b = boundsRef.current;
      if (!b) return null;
      return screenPointToLngLat(point, mapSize, b);
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
    // The region box maps screen→geo through the visible bounds, which is only
    // valid for a north-up, unpitched 2D map — so flatten the camera and seed the
    // bounds cache only AFTER the flatten has settled (refreshBounds ignores a
    // non-flat camera anyway; the overlay retries until the first bounds land).
    boundsRef.current = null;
    void (async () => {
      await cameraRef.current
        ?.setStop({ bearing: 0, pitch: 0, duration: 300 })
        .catch(() => undefined);
      await delay(FLATTEN_MS);
      await refreshBounds();
    })();
    setSelecting(true);
  };

  const cancelRegionSelect = () => setSelecting(false);

  /**
   * Download the drawn rectangle. The bounds are re-derived HERE, from freshly
   * read flat-camera bounds, rather than trusting the estimate the overlay
   * computed while the box was being drawn — so what is downloaded is what is
   * on screen, even if the map moved or the flatten settled late.
   */
  const confirmDownload = (rect: ScreenRect, basemaps: Basemap[], maxZoom: number) => {
    setSelecting(false);

    void (async () => {
      const visible = await flatBounds();
      const bounds = visible && screenRectToBounds(rect, mapSize, visible);
      if (!bounds) {
        showSnack('Could not read the map area — try again');
        return;
      }

      const baseId = storage.newId();
      const minZoom = overviewZoomFor(bounds);

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

      try {
        await useOfflineStore.getState().downloadMany({
          baseId,
          label: 'Offline map',
          bounds,
          // Each basemap's tile service tops out at a different zoom, so each
          // layer downloads its own clamped range (relief can't go past z15).
          layers: basemaps.map((bm) => ({
            basemap: bm,
            styleJSON: JSON.stringify(buildOsmStyle(tileUrl, false, bm)),
            ...packZoomRange(bm, minZoom, maxZoom),
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showSnack(message);
      }
    })();
  };

  return {
    selecting,
    downloadProgress,
    toGeo,
    boundsVersion,
    refreshBounds,
    onMapLayout,
    beginRegionSelect,
    cancelRegionSelect,
    confirmDownload,
  };
}
