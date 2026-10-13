import {
  PHOTO_IMAGE,
  PIN_IMAGE,
  PIN_LABEL_MIN_ZOOM,
  glyphImagesInUse,
  pinBodyLayout,
  pinBodyPaint,
  pinFeatureCollection,
  pinGlyphLayout,
  pinGlyphPaint,
  pinLabelLayout,
  pinLabelPaint,
  pinPhotoFilter,
  pinPhotoLayout,
  type PinInput,
} from '@core/map/waypointPinStyle';
import { teamLabelFont } from '@features/team/map/TeamMapLayers';
import { GeoJSONSource, Images, type ImageEntry, Layer } from '@maplibre/maplibre-react-native';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo, useMemo } from 'react';

import { WAYPOINT_PIN_IMAGES } from './waypointPinImages';

/** Layer ids (stable: e2e and the tap code may name them). */
export const WAYPOINT_PIN_LAYERS = {
  body: 'waypoint-pin-body',
  glyph: 'waypoint-pin-glyph',
  photo: 'waypoint-pin-photo',
  label: 'waypoint-pin-label',
} as const;

interface Props {
  pins: readonly PinInput[];
  /** The pin whose card is open (drawn larger, amber ring, on top). */
  selectedKey: string | null;
  /** The pin being moved (#676): drawn by the move overlay instead. */
  hiddenKey: string | null;
  /** The style's glyph host; no host = no labels (raster and satellite styles). */
  glyphs: string | undefined;
  /** The style's top-most layer: pins draw above everything, as markers did. */
  topLayerId: string | undefined;
}

const afterOf = (id: string | undefined): { afterId?: string } =>
  id === undefined ? {} : { afterId: id };

/**
 * The main map's waypoint pins (#675): one GeoJSON source, SDF sprites tinted
 * per pin, a fixed four layers however many pins there are. The style and the
 * reasoning are in `@core/map/waypointPinStyle`.
 *
 * Taps are still hit-tested at the map level (MapScreen's onMapPress), exactly
 * as for the old RN markers; the layers are visual only.
 *
 * Only the glyph sprites the pins use are registered: a handful of small
 * images, not the whole catalogue.
 */
export const WaypointPinLayers = memo(function WaypointPinLayers({
  pins,
  selectedKey,
  hiddenKey,
  glyphs,
  topLayerId,
}: Props) {
  const data = useMemo(
    () => pinFeatureCollection(pins, selectedKey, hiddenKey),
    [pins, selectedKey, hiddenKey],
  );
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
    return out;
  }, [inUse]);
  const font = teamLabelFont(glyphs);
  const { mapInk, mapHalo } = useSchemeTokens().team;

  // Memoised children: <GeoJSONSource> re-serialises its data whenever a
  // child's identity changes.
  const layers = useMemo(
    () => [
      <Layer
        key="body"
        id={WAYPOINT_PIN_LAYERS.body}
        {...afterOf(topLayerId)}
        type="symbol"
        layout={pinBodyLayout}
        paint={pinBodyPaint}
      />,
      <Layer
        key="glyph"
        id={WAYPOINT_PIN_LAYERS.glyph}
        afterId={WAYPOINT_PIN_LAYERS.body}
        type="symbol"
        layout={pinGlyphLayout}
        paint={pinGlyphPaint}
      />,
      <Layer
        key="photo"
        id={WAYPOINT_PIN_LAYERS.photo}
        afterId={WAYPOINT_PIN_LAYERS.glyph}
        type="symbol"
        filter={pinPhotoFilter}
        layout={pinPhotoLayout}
      />,
      ...(font
        ? [
            <Layer
              key="label"
              id={WAYPOINT_PIN_LAYERS.label}
              afterId={WAYPOINT_PIN_LAYERS.photo}
              type="symbol"
              minzoom={PIN_LABEL_MIN_ZOOM}
              layout={pinLabelLayout(font)}
              paint={pinLabelPaint(mapInk, mapHalo)}
            />,
          ]
        : []),
    ],
    [topLayerId, font, mapInk, mapHalo],
  );

  if (pins.length === 0) return null;
  return [
    <Images key="images" images={images} />,
    <GeoJSONSource key="source" id="waypoint-pins" data={data}>
      {layers}
    </GeoJSONSource>,
  ];
});
