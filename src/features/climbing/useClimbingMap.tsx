/**
 * Climbing crags on the main map (DESIGN §6.4, mockup 05; owner decision
 * Q3-A): once the extension is installed and on, the saved crags draw from a
 * local GeoJSON source — no network — with sector pins from z13 and route
 * starts from z17; "Show every crag" adds every crag streamed from the tiles.
 * A tap (below waypoints and trail notes, above geodetic points) opens the
 * crag's card: Open topo, Navigate (the existing destination flow), Share.
 *
 * The map screen wires four things: the style option, the images, the tap
 * and the card. Offline-only mode also keeps the saved crags' 2 km maps out
 * of the "not downloaded" mask (`maskBounds`).
 */
import { summaryFromDetail } from '@core/climbing/card';
import { parseCragTile, type CragSummary } from '@core/climbing/crag';
import type { CragDetail } from '@core/climbing/detail';
import { cragMapBounds, savedCragsGeoJSON } from '@core/climbing/saved';
import type { BoundingBox } from '@core/models';
import { CRAG_TAP_LAYERS } from '@core/map/climbingStyle';
import { cragTilesUrl, readSavedTopo } from '@data/climbing';
import { Images, type MapRef } from '@maplibre/maplibre-react-native';
import { useClimbingStore } from '@state/climbingStore';
import { useSettingsStore } from '@state/settingsStore';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Share } from 'react-native';

import { climbingImages } from './climbingImages';
import { cragHref } from './climbingRoutes';
import { CragMapCard } from './CragMapCard';

const HIT_PX = 14;

export interface ClimbingMapOption {
  dark: boolean;
  tiles?: string;
  saved?: GeoJSON.FeatureCollection;
  savedUids?: readonly string[];
}

export function useClimbingMap({ dark, mapLoaded }: { dark: boolean; mapLoaded: boolean }) {
  const router = useRouter();
  const installed = useSettingsStore((s) => s.climbingInstalledAt > 0);
  const show = useSettingsStore((s) => s.showClimbing);
  const showAll = useSettingsStore((s) => s.climbingShowAll);
  const saved = useClimbingStore((s) => s.saved);
  const [selected, setSelected] = useState<{ crag: CragSummary; detail: CragDetail | null } | null>(
    null,
  );

  useEffect(() => {
    if (mapLoaded) void useClimbingStore.getState().hydrate();
  }, [mapLoaded]);

  const tiles = cragTilesUrl();
  const on = installed && show && tiles !== null;
  const savedData = useMemo(() => savedCragsGeoJSON(saved), [saved]);
  const savedUids = useMemo(() => saved.map((s) => s.uid), [saved]);
  const styleOption = useMemo((): ClimbingMapOption | null => {
    if (!on) return null;
    return {
      dark,
      ...(showAll && tiles !== null ? { tiles } : {}),
      saved: savedData,
      savedUids,
    };
  }, [on, dark, showAll, tiles, savedData, savedUids]);

  /** The saved crags' map packs, for the offline-only mask's holes. */
  const maskBounds = useMemo((): BoundingBox[] => {
    return saved
      .filter((c) => c.packId !== null)
      .map((c) =>
        cragMapBounds([[c.lng, c.lat], ...c.sectors.flatMap((s) => (s.pt ? [s.pt] : []))]),
      );
  }, [saved]);

  /** A tap at (px, py): true when it opened a crag's card. */
  const tap = useCallback(
    async (map: MapRef, px: number, py: number): Promise<boolean> => {
      if (!on) return false;
      let features: GeoJSON.Feature[] = [];
      try {
        features = await map.queryRenderedFeatures(
          [
            [px - HIT_PX, py - HIT_PX],
            [px + HIT_PX, py + HIT_PX],
          ],
          { layers: [...CRAG_TAP_LAYERS] },
        );
      } catch {
        return false;
      }
      for (const f of features) {
        const props = (f.properties ?? {}) as Record<string, unknown>;
        if (typeof props.kind === 'string' && typeof props.uid === 'string') {
          const topo = await readSavedTopo(props.uid);
          if (topo) {
            setSelected({ crag: summaryFromDetail(topo.detail), detail: topo.detail });
            return true;
          }
        }
        const crag = parseCragTile(f as Parameters<typeof parseCragTile>[0]);
        if (crag) {
          const topo = saved.some((s) => s.uid === crag.uid) ? await readSavedTopo(crag.uid) : null;
          setSelected({ crag, detail: topo?.detail ?? null });
          return true;
        }
      }
      return false;
    },
    [on, saved],
  );

  const close = useCallback(() => setSelected(null), []);

  const images = on ? <Images images={climbingImages(dark ? 'dark' : 'light')} /> : null;

  const card = (opts: {
    floating: boolean;
    onNavigate: (to: { latitude: number; longitude: number }) => void;
  }) =>
    selected === null ? null : (
      <CragMapCard
        crag={selected.crag}
        detail={selected.detail}
        saved={saved.some((s) => s.uid === selected.crag.uid)}
        floating={opts.floating}
        onOpenTopo={() => {
          router.push(cragHref(selected.crag.uid));
          setSelected(null);
        }}
        onNavigate={() => {
          opts.onNavigate({ latitude: selected.crag.lat, longitude: selected.crag.lng });
          setSelected(null);
        }}
        onShare={() => {
          const { name, lat, lng } = selected.crag;
          void Share.share({
            message: `${name} (climbing crag) · ${lat.toFixed(5)}, ${lng.toFixed(5)} · https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lng.toFixed(5)}#map=16/${lat.toFixed(5)}/${lng.toFixed(5)}`,
          }).catch(() => undefined);
        }}
        onClose={() => setSelected(null)}
      />
    );

  return { on, styleOption, maskBounds, tap, selected, close, images, card };
}
