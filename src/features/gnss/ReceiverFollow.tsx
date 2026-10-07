import type { CameraRef } from '@maplibre/maplibre-react-native';
import { useGnssStore } from '@state/gnssStore';
import { useEffect, type RefObject } from 'react';

/** Don't re-centre for less than this (a stationary RTK fix wanders by millimetres). */
const MIN_MOVE_DEG = 2e-6;

/**
 * Follow-my-location while the external receiver is the source (#588):
 * MapLibre's native follow tracks the phone's GPS, so the camera is eased to
 * the receiver's fix here instead. Its own component, so only it re-renders
 * at the receiver's rate, not the map screen.
 */
export function ReceiverFollow({
  cameraRef,
  enabled,
}: {
  cameraRef: RefObject<CameraRef | null>;
  enabled: boolean;
}) {
  const lat = useGnssStore((s) => (s.map === null ? null : Math.round(s.map.lat / MIN_MOVE_DEG)));
  const lon = useGnssStore((s) => (s.map === null ? null : Math.round(s.map.lon / MIN_MOVE_DEG)));
  useEffect(() => {
    if (!enabled || lat === null || lon === null) return;
    cameraRef.current?.easeTo({
      center: [lon * MIN_MOVE_DEG, lat * MIN_MOVE_DEG],
      duration: 300,
    });
  }, [enabled, lat, lon, cameraRef]);
  return null;
}
