import { Layer, useCurrentPosition } from '@maplibre/maplibre-react-native';
import { useSchemeTokens } from '@ui/useSchemeTokens';

/** maplibre-react-native's user-location source (see its UserLocation component). */
const USER_LOCATION_SOURCE = 'mlrn-user-location';

/**
 * The revamp's location puck (board `After-Tokens.html`: "paper ring + cone"):
 * an accuracy halo, then a puck dot in a 3 dp ring, all in the scheme's puck
 * tokens (red on black in Night). Render it as the CHILDREN of
 * `<UserLocation>`: children replace MapLibre's default puck, whose fixed
 * blue-and-white dot otherwise draws over ours and ignores the display mode.
 *
 * `weakAccuracyM`, while recording on a weak signal, adds the amber
 * uncertainty ring (`After-Paused.html`) sized like MapLibre's own halo.
 * MapLibre circles can't be dashed, so the ring is solid.
 */
export function PuckLayers({ weakAccuracyM }: { weakAccuracyM: number | null }) {
  const tokens = useSchemeTokens();
  const accuracyM = useCurrentPosition()?.coords.accuracy;
  return (
    <>
      {typeof accuracyM === 'number' && (
        <Layer
          id="inukshuk-puck-halo"
          type="circle"
          source={USER_LOCATION_SOURCE}
          paint={{
            'circle-color': tokens.map.puckHalo,
            'circle-pitch-alignment': 'map',
            // MapLibre's own accuracy-halo scale (UserLocationPuck).
            'circle-radius': [
              'interpolate',
              ['exponential', 2],
              ['zoom'],
              0,
              9,
              22,
              9 + accuracyM * 100,
            ],
          }}
        />
      )}
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
