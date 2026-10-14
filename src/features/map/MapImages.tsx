/**
 * The map's ONE registration of its shared sprites (2.5.2 QA: pin icons and
 * a cluster's count pill gone after leaving drawing mode, back on a theme
 * change). Why one, and why it never shrinks: `@core/map/mapImageSet`.
 *
 * Every map that draws waypoint pins, trail photos or team drawings mounts
 * `<MapImages />` once, unconditionally, as its first child, so it is never
 * re-mounted or moved while the map lives. The layers call `useMapImages`
 * with the names they draw; none of them renders an `<Images>` for these.
 */
import { mapImageSet, onImageMissing, withImages, type MapImageSet } from '@core/map/mapImageSet';
import { PHOTO_IMAGE, PIN_IMAGE } from '@core/map/waypointPinStyle';
import { SELECTED_RING_IMAGE } from '@core/photos/mapStyle';
import { PHOTO_BADGE_IMAGES } from '@features/photos/photoBadgeImages';
import { DRAW_IMAGES } from '@features/team/draw/drawImages';
import { Images, type ImageEntry } from '@maplibre/maplibre-react-native';
import { memo, useCallback, useEffect, useMemo } from 'react';
import type { NativeSyntheticEvent } from 'react-native';
import { create } from 'zustand';

import { WAYPOINT_PIN_IMAGES } from './waypoints/waypointPinImages';

/** Every shared sprite by name: SDF ones (tinted per feature) flagged. */
export const MAP_IMAGE_CATALOG: Readonly<Record<string, ImageEntry>> = (() => {
  const out: Record<string, ImageEntry> = {};
  for (const [name, source] of Object.entries(WAYPOINT_PIN_IMAGES)) {
    // The photo badge is drawn as is; the pin body and the glyphs are SDF.
    out[name] = name === PHOTO_IMAGE ? source : { source, sdf: true };
  }
  for (const [name, source] of Object.entries(PHOTO_BADGE_IMAGES)) out[name] = source;
  for (const [name, source] of Object.entries(DRAW_IMAGES)) out[name] = { source, sdf: true };
  return out;
})();

const known = (name: string) => MAP_IMAGE_CATALOG[name] !== undefined;

/** Registered up front: what most maps draw first (the rest on request or on demand). */
export const BASE_MAP_IMAGES: readonly string[] = [
  PIN_IMAGE,
  PHOTO_IMAGE,
  // The common small stacks' pills (pin clusters and photo stacks share them).
  ...Array.from({ length: 9 }, (_, i) => `ph-count-${i + 2}`),
  SELECTED_RING_IMAGE,
  ...Object.keys(DRAW_IMAGES),
];

const useMapImageStore = create<{ set: MapImageSet }>(() => ({
  set: mapImageSet(BASE_MAP_IMAGES),
}));

/** Ask for names (any not in the catalogue are ignored); a no-op when all are registered. */
export function requestMapImages(names: Iterable<string>): void {
  const { set } = useMapImageStore.getState();
  const next = withImages(set, names, known);
  if (next !== set) useMapImageStore.setState({ set: next });
}

/** A layer's sprites: registered on the map's one `<Images>`, never removed. */
export function useMapImages(names: readonly string[]): void {
  const key = names.join('|');
  useEffect(() => {
    if (key !== '') requestMapImages(key.split('|'));
  }, [key]);
}

/** Tests: back to the base set. */
export function resetMapImagesForTests(): void {
  useMapImageStore.setState({ set: mapImageSet(BASE_MAP_IMAGES) });
}

/** Tests and diagnostics: the names registered now. */
export function registeredMapImages(): readonly string[] {
  return useMapImageStore.getState().set.names;
}

export const MapImages = memo(function MapImages() {
  const set = useMapImageStore((s) => s.set);
  const images = useMemo(() => {
    const out: Record<string, ImageEntry> = {};
    for (const name of set.names) {
      const entry = MAP_IMAGE_CATALOG[name];
      if (entry !== undefined) out[name] = entry;
    }
    return out;
  }, [set.names]);
  const onMissing = useCallback((e: NativeSyntheticEvent<{ image: string }>) => {
    const { set: now } = useMapImageStore.getState();
    const next = onImageMissing(now, e.nativeEvent.image, known);
    if (next !== now) useMapImageStore.setState({ set: next });
  }, []);
  return <Images key={`map-images-${set.generation}`} images={images} onImageMissing={onMissing} />;
});
