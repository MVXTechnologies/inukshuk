import { LayerAnnotation, UserLocation } from '@maplibre/maplibre-react-native';
import { useGnssStore } from '@state/gnssStore';

import { PuckLayers } from './PuckLayers';

/**
 * The location puck. Normally MapLibre's `UserLocation`, which reads the
 * phone's GPS itself. While an external receiver is the position source
 * (#588) the same puck layers are drawn on the receiver's fix instead —
 * same annotation id, so `PuckLayers` and the heading cone are unchanged —
 * and MapLibre's location listener is unmounted, so the phone GPS can stay in
 * low-power standby.
 */
export function UserPuck({ weakAccuracyM }: { weakAccuracyM: number | null }) {
  const external = useGnssStore((s) => (s.use === 'external' ? s.map : null));
  const accuracyM = useGnssStore((s) => s.fix?.accuracy?.h95 ?? null);
  if (external !== null) {
    return (
      <LayerAnnotation id="mlrn-user-location" animated lngLat={[external.lon, external.lat]}>
        <PuckLayers weakAccuracyM={null} accuracyM={accuracyM} />
      </LayerAnnotation>
    );
  }
  return (
    <UserLocation animated>
      <PuckLayers weakAccuracyM={weakAccuracyM} />
    </UserLocation>
  );
}
