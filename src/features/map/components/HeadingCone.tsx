import { coneHalfAngleDeg, headingConeFeature } from '@core/geo/headingCone';
import type { LatLng } from '@core/models';
import { signedDeltaDeg } from '@core/signal/heading';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useEffect, useMemo, useState } from 'react';
import { subscribeHeading } from '../useCompass';

/** Ground radius of the beam, metres. Sized to read clearly at the zooms the
 * map is actually navigated at (z14–18) without dominating the screen. */
const CONE_RADIUS_M = 70;

/**
 * Minimum heading change (deg) before the sector polygon is regenerated. The
 * shared filter holds the heading exactly still at rest, so this no longer has
 * to defend against jitter — it only has to keep the beam from visibly stepping
 * while you turn, hence the sub-degree value.
 */
const MIN_UPDATE_DELTA_DEG = 0.5;

/** Matches the blue of maplibre-react-native's default user-location puck. */
const CONE_BLUE = '#33B5E5';

interface HeadingConeProps {
  /** Latest fix; the cone hides until one exists. */
  location: LatLng | null;
}

/**
 * Faint translucent direction cone ("flashlight beam", à la Google Maps)
 * anchored on the user-location dot, pointing at the smoothed compass heading.
 * Its angular width tracks the sensor's reported calibration: the worse the
 * compass accuracy, the wider (vaguer) the beam.
 *
 * Render inside <Map>. `beforeId` slots the fill beneath the puck's white
 * ring — the native side waits for that layer to exist before inserting, so
 * mount order relative to <UserLocation> doesn't matter. The translucent blue
 * stays subtle on both the light and dark basemaps (same approach Google Maps
 * uses in both themes), and it fades out below z12 where the cone would
 * collapse into the dot anyway.
 *
 * The component owns its own heading subscription (shared, see
 * `subscribeHeading`) so cone updates re-render only this subtree, gated to
 * ≥1° changes to keep GeoJSON regeneration cheap.
 */
export function HeadingCone({ location }: HeadingConeProps) {
  const [beam, setBeam] = useState<{ headingDeg: number; accuracy: number | null } | null>(null);

  useEffect(
    () =>
      subscribeHeading((next) => {
        setBeam((prev) =>
          prev !== null &&
          prev.accuracy === next.accuracy &&
          Math.abs(signedDeltaDeg(prev.headingDeg, next.headingDeg)) < MIN_UPDATE_DELTA_DEG
            ? prev
            : next,
        );
      }),
    [],
  );

  const feature = useMemo(
    () =>
      location && beam
        ? headingConeFeature({
            center: location,
            headingDeg: beam.headingDeg,
            halfAngleDeg: coneHalfAngleDeg(beam.accuracy),
            radiusM: CONE_RADIUS_M,
          })
        : null,
    [location, beam],
  );

  if (!feature) return null;
  return (
    <GeoJSONSource id="heading-cone" data={feature}>
      <Layer
        id="heading-cone-fill"
        type="fill"
        beforeId="mlrn-user-location-puck-white"
        paint={{
          'fill-color': CONE_BLUE,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 13, 0.18],
          'fill-outline-color': 'rgba(51, 181, 229, 0)',
        }}
      />
    </GeoJSONSource>
  );
}
