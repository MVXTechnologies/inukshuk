import { Layer } from '@maplibre/maplibre-react-native';
import { useSchemeTokens } from '@ui/useSchemeTokens';

/** maplibre-react-native's user-location source (see its UserLocation component). */
const USER_LOCATION_SOURCE = 'mlrn-user-location';

/**
 * The revamp's location puck (board `After-Tokens.html`: "paper ring + cone"):
 * a puck-blue dot in a 3 dp paper ring, drawn over MapLibre's default puck —
 * which stays underneath for its native accuracy halo — on the same source,
 * so it moves with the animated position. Render AFTER `<UserLocation>`.
 *
 * `weakAccuracyM`, while recording on a weak signal, adds the amber
 * uncertainty ring (`After-Paused.html`) sized like MapLibre's own halo.
 * MapLibre circles can't be dashed, so the ring is solid.
 */
export function PuckLayers({ weakAccuracyM }: { weakAccuracyM: number | null }) {
  const tokens = useSchemeTokens();
  return (
    <>
      {weakAccuracyM !== null && (
        <Layer
          id="inukshuk-puck-uncertainty"
          type="circle"
          source={USER_LOCATION_SOURCE}
          paint={{
            'circle-color': tokens.status.gpsWeak,
            'circle-opacity': 0.12,
            'circle-stroke-color': tokens.status.gpsWeak,
            'circle-stroke-width': 2,
            'circle-pitch-alignment': 'map',
            // MapLibre's own accuracy-halo scale (UserLocationPuck).
            'circle-radius': [
              'interpolate',
              ['exponential', 2],
              ['zoom'],
              0,
              9,
              22,
              9 + weakAccuracyM * 100,
            ],
          }}
        />
      )}
      <Layer
        id="inukshuk-puck-ring"
        type="circle"
        source={USER_LOCATION_SOURCE}
        paint={{
          'circle-radius': 9,
          'circle-color': tokens.map.puckRing,
          'circle-pitch-alignment': 'map',
        }}
      />
      <Layer
        id="inukshuk-puck-dot"
        type="circle"
        source={USER_LOCATION_SOURCE}
        paint={{
          'circle-radius': 6,
          'circle-color': tokens.map.puck,
          'circle-pitch-alignment': 'map',
        }}
      />
    </>
  );
}
