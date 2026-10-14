import {
  CLUSTER_FILTER,
  countLayout,
  initialSprites,
  leafIds,
  mapPhotos,
  orderOfSprite,
  PHOTO_CLUSTER_MAX_ZOOM,
  PHOTO_CLUSTER_RADIUS,
  photoSetKey,
  readPhotoPress,
  selectedRingLayout,
  selectedSpriteLayout,
  spritePixelRatio,
  spriteLayout,
  spritePrefix,
  stackTapAction,
  touchSprites,
} from '@core/photos/mapStyle';
import { liveLayerAnchor } from '@core/map/liveLayerOrder';
import type { TrackPhoto } from '@core/photos/model';
import { PHOTO_CLUSTER_PROPERTIES, photoFeatureCollection } from '@core/photos/stack';
import {
  GeoJSONSource,
  type GeoJSONSourceRef,
  Images,
  type ImageEntry,
  Layer,
} from '@maplibre/maplibre-react-native';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { NativeSyntheticEvent } from 'react-native';

import { photoFileUri } from './photoUri';

/**
 * A trail's photos on a MapLibre map (#587): round thumbnails ON the line,
 * clustered natively into stacks covered by their first photo in time (owner
 * Q11) with a count badge, plus the selected photo (profile cursor, "Show on
 * map") larger, on a sage ring. GL symbols, never RN Markers: hundreds of
 * photos must pan like nothing is there.
 *
 * Several instances can share a map (the trail view, each trail on the main
 * map, the live recording): every source, layer and sprite name is prefixed
 * with `id`. Sprites are registered lazily through `onImageMissing` and kept
 * to an LRU of at most 150 (≈10 MB of texture); with clustering a view needs
 * far fewer. Note photos are not drawn here (their note has its own pin).
 * The style logic is in `@core/photos/mapStyle`.
 *
 * Every layer sits at its kind's live anchor (`@core/map/liveLayerOrder`):
 * under the waypoint pins and the location puck on the main map, whatever
 * order MapLibre re-inserts layers in after a style reload. Without one a
 * photo circle landed on top of the stack and hid the blue dot (2.5.1 QA).
 */
export interface TrailPhotoLayersProps {
  /** Unique per map: source and layer ids are prefixed with it. */
  id: string;
  photos: readonly TrackPhoto[];
  /** The photo to ring (profile cursor, viewer "Show on map"). */
  selectedId?: string | null;
  /** Below this zoom nothing is drawn (main map setting); 0 = always. */
  minZoom?: number;
  /** A single photo, or a stack that cannot be split further (its photos, time order). */
  onPhotoPress?: (photoIds: string[]) => void;
  /**
   * Called first with the tap's screen point: resolve `true` when something
   * with priority there (a waypoint or note pin) took the tap instead.
   */
  pressGuard?: (point: [number, number]) => Promise<boolean>;
  /** The map's zoom now, and a camera move: a stack tap zooms to where it splits. */
  getZoom?: () => Promise<number>;
  zoomTo?: (center: [number, number], zoom: number) => void;
  /**
   * Instead of taking the tap, let it reach the map's own press handler and
   * hand it this tap's photo action to run if nothing with priority claims
   * it first (the main map's waypoint pins and point chip).
   */
  deferPress?: (run: () => void) => void;
}

type PressEvent = NativeSyntheticEvent<{
  features: GeoJSON.Feature[];
  point?: [number, number];
}>;

export function TrailPhotoLayers({
  id,
  photos,
  selectedId,
  minZoom = 0,
  onPhotoPress,
  pressGuard,
  getZoom,
  zoomTo,
  deferPress,
}: TrailPhotoLayersProps) {
  const drawn = useMemo(() => mapPhotos(photos), [photos]);
  const prefix = useMemo(() => spritePrefix(id, photoSetKey(drawn)), [id, drawn]);
  const data = useMemo(() => photoFeatureCollection(drawn), [drawn]);
  const sourceRef = useRef<GeoJSONSourceRef>(null);

  // Sprite LRU, reset whenever the drawn set (and so the names) changes.
  const [lru, setLru] = useState<{ prefix: string; names: string[] }>({ prefix: '', names: [] });
  const sprites = lru.prefix === prefix ? lru.names : initialSprites(prefix, drawn.length);

  const images = useMemo(() => {
    const out: Record<string, ImageEntry> = {};
    for (const name of sprites) {
      const order = orderOfSprite(prefix, name);
      const photo = order === null ? undefined : drawn[order];
      // 264 px sprites at 6 px per point (older 132 px ones at 3): a 44 pt circle
      // at icon-size 1 either way.
      if (photo) {
        out[name] = {
          source: { uri: photoFileUri(photo.sprite), scale: spritePixelRatio(photo.sprite) },
        };
      }
    }
    // The count pills and the selected ring are shared with the waypoint
    // clusters: the map's one registration (`MapImages`) owns them, never this
    // instance, which mounts and unmounts with its trail.
    return out;
  }, [sprites, prefix, drawn]);

  const onImageMissing = useCallback(
    (e: NativeSyntheticEvent<{ image: string }>) => {
      const name = e.nativeEvent.image;
      if (orderOfSprite(prefix, name) !== null) {
        setLru((prev) => ({
          prefix,
          names: touchSprites(
            prev.prefix === prefix ? prev.names : initialSprites(prefix, drawn.length),
            [name],
          ),
        }));
      }
      // Anything else belongs to another layer or instance (a count pill: `MapImages`).
    },
    [prefix, drawn.length],
  );

  const selectedFeature = useMemo((): GeoJSON.FeatureCollection => {
    const order = selectedId ? drawn.findIndex((p) => p.id === selectedId) : -1;
    const photo = order >= 0 ? drawn[order] : undefined;
    return {
      type: 'FeatureCollection',
      features: photo
        ? [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [photo.lngLat[0], photo.lngLat[1]] },
              properties: { id: photo.id, order },
            },
          ]
        : [],
    };
  }, [selectedId, drawn]);

  const onPress = useCallback(
    (e: PressEvent) => {
      // Read everything now: React Native recycles the event once we await.
      const feature = e.nativeEvent.features[0];
      const point = e.nativeEvent.point;
      const press = feature ? readPhotoPress(feature as never) : null;
      if (!press) return;
      const run = async () => {
        if (point && pressGuard && (await pressGuard(point))) return;
        if (press.kind === 'photo') {
          onPhotoPress?.([press.id]);
          return;
        }
        const source = sourceRef.current;
        const [expansion, zoom] = await Promise.all([
          source?.getClusterExpansionZoom(press.clusterId).catch(() => null) ?? null,
          getZoom?.().catch(() => null) ?? null,
        ]);
        const action =
          zoomTo && zoom !== null ? stackTapAction(expansion, zoom) : { kind: 'open' as const };
        if (action.kind === 'zoom') {
          zoomTo?.(press.lngLat, action.zoom);
          return;
        }
        const leaves = await source?.getClusterLeaves(press.clusterId, 500, 0).catch(() => []);
        const ids = leafIds(leaves ?? []);
        if (ids.length > 0) onPhotoPress?.(ids);
      };
      if (deferPress) {
        deferPress(() => void run());
        return;
      }
      e.stopPropagation();
      void run();
    },
    [pressGuard, onPhotoPress, getZoom, zoomTo, deferPress],
  );

  if (drawn.length === 0) return null;
  const zoomProps = minZoom > 0 ? { minzoom: minZoom } : {};
  return (
    <>
      <Images images={images} onImageMissing={onImageMissing} />
      <GeoJSONSource
        ref={sourceRef}
        id={`${id}-photos`}
        data={data}
        cluster
        clusterRadius={PHOTO_CLUSTER_RADIUS}
        clusterMaxZoom={PHOTO_CLUSTER_MAX_ZOOM}
        clusterProperties={PHOTO_CLUSTER_PROPERTIES as never}
        onPress={onPress}
      >
        <Layer
          id={`${id}-photos-img`}
          type="symbol"
          beforeId={liveLayerAnchor('trail-photos')}
          layout={spriteLayout(prefix)}
          {...zoomProps}
        />
        <Layer
          id={`${id}-photos-count`}
          type="symbol"
          beforeId={liveLayerAnchor('trail-photos-count')}
          filter={CLUSTER_FILTER}
          layout={countLayout()}
          {...zoomProps}
        />
      </GeoJSONSource>
      <GeoJSONSource id={`${id}-photos-sel`} data={selectedFeature} onPress={onPress}>
        <Layer
          id={`${id}-photos-sel-ring`}
          type="symbol"
          beforeId={liveLayerAnchor('trail-photos-selected-ring')}
          layout={selectedRingLayout()}
          {...zoomProps}
        />
        <Layer
          id={`${id}-photos-sel-img`}
          type="symbol"
          beforeId={liveLayerAnchor('trail-photos-selected')}
          layout={selectedSpriteLayout(prefix)}
          {...zoomProps}
        />
      </GeoJSONSource>
    </>
  );
}
