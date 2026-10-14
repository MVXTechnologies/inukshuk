import { MapScreen } from '@features/map/MapScreen';
import { InfoStripInsets } from '@features/map/infoStrip/InfoStripInsets';

export default function MapTab() {
  // The info strip's top dock shifts the map's top chrome down (#673).
  return (
    <InfoStripInsets>
      <MapScreen />
    </InfoStripInsets>
  );
}
