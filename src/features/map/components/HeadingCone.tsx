import { liveLayerAnchor } from '@core/map/liveLayerOrder';
import { coneHalfAngleDeg, headingConeFeature } from '@core/geo/headingCone';
import type { LatLng } from '@core/models';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useEffect, useMemo, useState } from 'react';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { subscribeHeadingMotion } from '../headingMotion';

/** Ground radius of the beam, metres. Sized to read clearly at the zooms the
 * map is actually navigated at (z14–18) without dominating the screen. */
const CONE_RADIUS_M = 70;

/**
 * Minimum heading change (deg) before the sector polygon is regenerated: well
 * under what a frame of a slow turn moves, so the beam glides; it only skips
 * the follower's last sub-pixel creep onto its target.
 */
const MIN_UPDATE_DELTA_DEG = 0.1;

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
 * Render inside <Map>. It is inserted below its own anchor in the style
 * (`@core/map/liveLayerOrder`): above the puck's halo, under the pointing
 * line, the pins and the puck's ring and dot — after every style reload. The translucent blue
 * stays subtle on both the light and dark basemaps (same approach Google Maps
 * uses in both themes), and it fades out below z12 where the cone would
 * collapse into the dot anyway.
 *
 * It turns at display rate (`subscribeHeadingMotion`: one frame per
 * animation frame while you turn, none at rest) — 2.6.0 stepped it once per
 * sensor sample, 6–25° at a time. The subscription is its own, so a frame
 * re-renders only this subtree: one 26-point polygon and one native source
 * update.
 */
export function HeadingCone({ location }: HeadingConeProps) {
  const tokens = useSchemeTokens();
  const [beam, setBeam] = useState<{ headingDeg: number; accuracy: number | null } | null>(null);

  useEffect(
    () =>
      subscribeHeadingMotion(({ headingDeg, accuracy }) => setBeam({ headingDeg, accuracy }), {
        minDeltaDeg: MIN_UPDATE_DELTA_DEG,
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
        beforeId={liveLayerAnchor('heading-cone-fill')}
        paint={{
          'fill-color': tokens.map.puck,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 13, 0.18],
          'fill-outline-color': 'transparent',
        }}
      />
    </GeoJSONSource>
  );
}
