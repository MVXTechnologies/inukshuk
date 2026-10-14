import { isWaypointSize, waypointSize } from '@core/library/waypointStyle';
import { liveLayerAnchor } from '@core/map/liveLayerOrder';
import { pinScaleFactor } from '@core/map/pinScale';
import {
  CLUSTERED_PHOTO_FILTER,
  IS_CLUSTER,
  NOT_CLUSTER,
  PIN_CLUSTER_MAX_ZOOM,
  clusterCountLayout,
  clusterDiscPaint,
  clusterGlyphLayout,
  clusterGlyphPaint,
  clusterPinCollection,
  clusteredBodyLayout,
  clusteredBodyPaint,
  clusteredGlyphLayout,
  clusteredGlyphPaint,
  clusteredPhotoLayout,
  pinClusterRadius,
  selectedPin,
} from '@core/map/waypointClusters';
import {
  PHOTO_IMAGE,
  PIN_IMAGE,
  PIN_LABEL_MIN_ZOOM,
  glyphImagesInUse,
  pinFeatureCollection,
  pinLabelFilter,
  pinLabelLayout,
  pinLabelPaint,
  pinLayoutScaled,
  pinPaint,
  pinPhotoFilter,
  pinPhotoLayoutScaled,
  type PinInput,
} from '@core/map/waypointPinStyle';
import { PHOTO_BADGE_IMAGES } from '@features/photos/photoBadgeImages';
import { teamLabelFont } from '@features/team/map/TeamMapLayers';
import {
  GeoJSONSource,
  type GeoJSONSourceRef,
  Images,
  type ImageEntry,
  Layer,
} from '@maplibre/maplibre-react-native';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { NativeSyntheticEvent } from 'react-native';

import { useWaypointClusterSheet, waypointClusterSource } from './waypointTap';
import { WAYPOINT_PIN_IMAGES } from './waypointPinImages';

/** Layer ids (stable: e2e and the tap code may name them). */
export const WAYPOINT_PIN_LAYERS = {
  /** A cluster's disc, its inukshuk and its count pill (#685). */
  cluster: 'waypoint-cluster',
  clusterGlyph: 'waypoint-cluster-glyph',
  clusterCount: 'waypoint-cluster-count',
  /** Unclustered pins: bodies, then glyphs, badges and names. */
  pin: 'waypoint-pin',
  glyph: 'waypoint-pin-glyph',
  photo: 'waypoint-pin-photo',
  label: 'waypoint-pin-label',
  /** The selected pin, on top, never clustered. */
  selected: 'waypoint-pin-selected',
  selectedPhoto: 'waypoint-pin-selected-photo',
  selectedLabel: 'waypoint-pin-selected-label',
} as const;

/** The clustered source, and the selected pin's own. */
export const WAYPOINT_PIN_SOURCE = 'waypoint-pins';
export const WAYPOINT_SELECTED_SOURCE = 'waypoint-pin-selected';

/** Count pills registered up front (the common small stacks); the rest on demand. */
const PRIMED_COUNTS = Array.from({ length: 9 }, (_, i) => `ph-count-${i + 2}`);

interface Props {
  pins: readonly PinInput[];
  /** The pin whose card is open (drawn larger, amber ring, on top). */
  selectedKey: string | null;
  /** The pin being moved (#676): drawn by the move overlay instead. */
  hiddenKey: string | null;
  /** The style's glyph host; no host = no labels (raster and satellite styles). */
  glyphs: string | undefined;
}

/**
 * The main map's waypoint pins (#675): SDF sprites tinted per pin, a fixed
 * handful of layers however many pins there are. Since #685 the pins sit in
 * ONE CLUSTERED source — pins that would overlap become a round mark with a
 * count — and the selected pin draws from its own source on top. The style
 * and the reasoning are in `@core/map/waypointClusters` and
 * `@core/map/waypointPinStyle`.
 *
 * The Pin size setting (#686) is read here, in the leaf: it is one
 * multiplier in the layers' `icon-size`, so the pin data never changes with
 * it. The cluster radius does: MapLibre reads a source's cluster options only
 * when the source is created, so the source is keyed by its radius and
 * re-created once when the setting (or the largest pin size) changes.
 * Panning and zooming run no JS here at all.
 *
 * Taps are still hit-tested at the map level (MapScreen's onMapPress, through
 * `waypointTap`); the layers are visual only.
 */
export const WaypointPinLayers = memo(function WaypointPinLayers({
  pins,
  selectedKey,
  hiddenKey,
  glyphs,
}: Props) {
  const k = pinScaleFactor(useSettingsStore((s) => s.pinScale));
  // A pin opened from a cluster's list: the list's other pins step aside
  // while its card is up (`useWaypointClusterSheet.opened`).
  const opened = useWaypointClusterSheet((s) => s.opened);
  const muted = opened !== null && opened.key === selectedKey ? opened.others : null;
  useEffect(() => {
    if (opened !== null && opened.key !== selectedKey) {
      useWaypointClusterSheet.getState().clearOpened();
    }
  }, [opened, selectedKey]);
  const clustered = useMemo(() => {
    const hidden = muted === null ? null : new Set(muted);
    const shown = hidden === null ? pins : pins.filter((p) => !hidden.has(p.key));
    return clusterPinCollection(shown, selectedKey, hiddenKey);
  }, [pins, selectedKey, hiddenKey, muted]);
  // The sizes on the map decide the radius. Over every pin, the selected and
  // moving ones included, so selecting a pin never re-creates the source. A
  // string, so the radius memo below holds while the same sizes are present.
  const sizes = useMemo(
    () => [...new Set(pins.map((p) => waypointSize(p.size)))].sort().join('|'),
    [pins],
  );
  const selected = selectedPin(pins, selectedKey, hiddenKey);
  const selectedData = useMemo(
    () => (selected ? pinFeatureCollection([selected], selectedKey) : null),
    [selected, selectedKey],
  );
  // The largest sizes present decide the radius (see pinClusterRadius).
  const radius = useMemo(
    () => pinClusterRadius(sizes.split('|').filter(isWaypointSize), k),
    [sizes, k],
  );

  const [counts, setCounts] = useState<string[]>(PRIMED_COUNTS);
  const inUse = glyphImagesInUse(pins).join('|');
  const images = useMemo(() => {
    const out: Record<string, ImageEntry> = {};
    const add = (name: string, sdf: boolean) => {
      const source = WAYPOINT_PIN_IMAGES[name];
      if (source !== undefined) out[name] = sdf ? { source, sdf: true } : source;
    };
    add(PIN_IMAGE, true);
    add(PHOTO_IMAGE, false);
    for (const name of inUse.split('|')) add(name, true);
    for (const name of counts) {
      const source = PHOTO_BADGE_IMAGES[name];
      if (source !== undefined) out[name] = source;
    }
    return out;
  }, [inUse, counts]);
  // A cluster of more than 10 asks for its pill when it first draws.
  const onImageMissing = useCallback((e: NativeSyntheticEvent<{ image: string }>) => {
    const name = e.nativeEvent.image;
    if (!name.startsWith('ph-count-') || PHOTO_BADGE_IMAGES[name] === undefined) return;
    setCounts((prev) => (prev.includes(name) ? prev : [...prev, name]));
  }, []);

  const font = teamLabelFont(glyphs);
  const { mapInk, mapHalo } = useSchemeTokens().team;

  // Memoised children: <GeoJSONSource> re-serialises its data whenever a
  // child's identity changes.
  const clusteredLayers = useMemo(
    () => [
      <Layer
        key="cluster"
        id={WAYPOINT_PIN_LAYERS.cluster}
        beforeId={liveLayerAnchor('waypoint-cluster')}
        type="circle"
        filter={IS_CLUSTER}
        paint={clusterDiscPaint(k)}
      />,
      <Layer
        key="cluster-glyph"
        id={WAYPOINT_PIN_LAYERS.clusterGlyph}
        beforeId={liveLayerAnchor('waypoint-cluster-glyph')}
        type="symbol"
        filter={IS_CLUSTER}
        layout={clusterGlyphLayout(k)}
        paint={clusterGlyphPaint}
      />,
      <Layer
        key="cluster-count"
        id={WAYPOINT_PIN_LAYERS.clusterCount}
        beforeId={liveLayerAnchor('waypoint-cluster-count')}
        type="symbol"
        filter={IS_CLUSTER}
        layout={clusterCountLayout(k)}
      />,
      <Layer
        key="pin"
        id={WAYPOINT_PIN_LAYERS.pin}
        beforeId={liveLayerAnchor('waypoint-pin')}
        type="symbol"
        filter={NOT_CLUSTER}
        layout={clusteredBodyLayout(k)}
        paint={clusteredBodyPaint}
      />,
      <Layer
        key="glyph"
        id={WAYPOINT_PIN_LAYERS.glyph}
        beforeId={liveLayerAnchor('waypoint-pin-glyph')}
        type="symbol"
        filter={NOT_CLUSTER}
        layout={clusteredGlyphLayout(k)}
        paint={clusteredGlyphPaint}
      />,
      <Layer
        key="photo"
        id={WAYPOINT_PIN_LAYERS.photo}
        beforeId={liveLayerAnchor('waypoint-pin-photo')}
        type="symbol"
        filter={CLUSTERED_PHOTO_FILTER}
        layout={clusteredPhotoLayout(k)}
      />,
      ...(font
        ? [
            <Layer
              key="label"
              id={WAYPOINT_PIN_LAYERS.label}
              beforeId={liveLayerAnchor('waypoint-pin-label')}
              type="symbol"
              minzoom={PIN_LABEL_MIN_ZOOM}
              filter={NOT_CLUSTER}
              layout={pinLabelLayout(font, k, false)}
              paint={pinLabelPaint(mapInk, mapHalo)}
            />,
          ]
        : []),
    ],
    [font, mapInk, mapHalo, k],
  );

  const selectedLayers = useMemo(
    () => [
      <Layer
        key="pin"
        id={WAYPOINT_PIN_LAYERS.selected}
        beforeId={liveLayerAnchor('waypoint-pin-selected')}
        type="symbol"
        layout={pinLayoutScaled(k)}
        paint={pinPaint}
      />,
      <Layer
        key="photo"
        id={WAYPOINT_PIN_LAYERS.selectedPhoto}
        beforeId={liveLayerAnchor('waypoint-pin-selected-photo')}
        type="symbol"
        filter={pinPhotoFilter}
        layout={pinPhotoLayoutScaled(k)}
      />,
      ...(font
        ? [
            <Layer
              key="label"
              id={WAYPOINT_PIN_LAYERS.selectedLabel}
              beforeId={liveLayerAnchor('waypoint-pin-selected-label')}
              type="symbol"
              minzoom={PIN_LABEL_MIN_ZOOM}
              filter={pinLabelFilter}
              layout={pinLabelLayout(font, k)}
              paint={pinLabelPaint(mapInk, mapHalo)}
            />,
          ]
        : []),
    ],
    [font, mapInk, mapHalo, k],
  );

  const setSourceRef = useCallback((ref: GeoJSONSourceRef | null) => {
    waypointClusterSource.current = ref;
  }, []);

  if (pins.length === 0) return null;
  const out = [<Images key="images" images={images} onImageMissing={onImageMissing} />];
  if (clustered.features.length > 0) {
    out.push(
      <GeoJSONSource
        // Cluster options are read once, at creation: a new radius is a new source.
        key={`clustered-${radius}`}
        ref={setSourceRef}
        id={WAYPOINT_PIN_SOURCE}
        data={clustered}
        cluster
        clusterRadius={radius}
        clusterMaxZoom={PIN_CLUSTER_MAX_ZOOM}
      >
        {clusteredLayers}
      </GeoJSONSource>,
    );
  }
  if (selectedData !== null) {
    out.push(
      <GeoJSONSource key="selected" id={WAYPOINT_SELECTED_SOURCE} data={selectedData}>
        {selectedLayers}
      </GeoJSONSource>,
    );
  }
  return out;
});
