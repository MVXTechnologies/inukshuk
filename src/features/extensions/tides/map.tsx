/**
 * Tide stations on the live map: Canada's live CHS stations in its style,
 * its symbol images, a tap → the station card.
 */
import type { TideStation } from '@core/tides/station';
import { tideColors } from '@core/map/tideStyle';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useMemo } from 'react';

import { TideStationCard } from '../../map/components/TideStationCard';
import { useChsStations } from '../../map/hooks/useChs';
import { tideImages } from '../../map/tideImages';
import { tideStationAt } from '../../map/tideTap';
import type { ExtensionMapModule } from '../types';

export const TIDES_MAP: ExtensionMapModule<TideStation> = {
  useStyleExtras(active, { offlineOnly }) {
    // Canadian stations: fetched live from CHS by the phone and kept on it (never our tiles).
    const chs = useChsStations(active, offlineOnly);
    return useMemo(() => ({ chs }), [chs]);
  },
  images: tideImages,
  // Above the survey marks: a station wins over the marks round its harbour.
  hitTest: ({ map, px, py, lngLat }) => tideStationAt(map, px, py, lngLat),
  position: (station) => [station.lng, station.lat],
  renderSelection: (station, { dark, beforeId }) => (
    <GeoJSONSource
      id="tide-selected"
      data={{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [station.lng, station.lat] },
        properties: {},
      }}
    >
      <Layer
        id="tide-selected-ring"
        beforeId={beforeId}
        type="circle"
        paint={{
          'circle-radius': 17,
          'circle-color': tideColors(dark ? 'dark' : 'light').station,
          'circle-opacity': 0.16,
          'circle-stroke-width': 2,
          'circle-stroke-color': tideColors(dark ? 'dark' : 'light').station,
        }}
      />
    </GeoJSONSource>
  ),
  renderCard: (station, host) => (
    <TideStationCard
      station={station}
      floating={host.floating}
      offline={host.offline}
      onOpenLink={(url) => host.openLink(url, "Couldn't open the agency page")}
      onNavigate={() => host.navigateTo(station.lat, station.lng)}
      onCopy={(text) =>
        host.copy(text, `Copied: ${text.length > 80 ? `${text.slice(0, 77)}…` : text}`)
      }
      onClose={host.close}
      onConvert={host.openConvert}
    />
  ),
  cardDockTestID: 'tide-card-dock',
  recenterOnCard: false,
};
