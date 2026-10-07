/**
 * Geodetic points on the live map: the filter in its style, its symbol
 * images, a tap → the survey-mark card (recentred above it).
 */
import { prefillFromMark } from '@core/convert/prefill';
import { buildGeodeticFilters } from '@core/geodetic/filter';
import { pickTappedMark, type GeodeticMark } from '@core/geodetic/record';
import { GEODETIC_TAP_LAYERS, geodeticColors } from '@core/map/geodeticStyle';
import { useSettingsStore } from '@state/settingsStore';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useMemo } from 'react';

import { GeodeticPointCard } from '../../map/components/GeodeticPointCard';
import { geodeticImages } from '../../map/geodeticImages';
import type { ExtensionMapModule } from '../types';

/** Half the side of the box a tap searches for a geodetic mark, px (DESIGN §7.2: ~12). */
const GEODETIC_HIT_PX = 12;

export const GEODETIC_MAP: ExtensionMapModule<GeodeticMark> = {
  useStyleExtras() {
    // The user's attribute filter (the overlays funnel), ANDed into every layer.
    const filter = useSettingsStore((s) => s.geodeticFilter);
    return useMemo(() => ({ filters: buildGeodeticFilters(filter) }), [filter]);
  },
  images: geodeticImages,
  // Under the waypoint pins and the chip, above the trails, heat spots and
  // the bare map: a small box round the finger, the nearest mark in it wins.
  async hitTest({ map, px, py, lngLat }) {
    try {
      const features = await map.queryRenderedFeatures(
        [
          [px - GEODETIC_HIT_PX, py - GEODETIC_HIT_PX],
          [px + GEODETIC_HIT_PX, py + GEODETIC_HIT_PX],
        ],
        { layers: [...GEODETIC_TAP_LAYERS] },
      );
      return pickTappedMark(features, lngLat);
    } catch {
      return null;
    }
  },
  position: (mark) => [mark.lng, mark.lat],
  renderSelection: (mark, { dark, beforeId }) => (
    <GeoJSONSource
      id="geodetic-selected"
      data={{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [mark.lng, mark.lat] },
        properties: {},
      }}
    >
      <Layer
        id="geodetic-selected-ring"
        beforeId={beforeId}
        type="circle"
        paint={{
          'circle-radius': 13,
          'circle-color': geodeticColors(dark ? 'dark' : 'light')[mark.type],
          'circle-opacity': 0.18,
          'circle-stroke-width': 2,
          'circle-stroke-color': geodeticColors(dark ? 'dark' : 'light')[mark.type],
        }}
      />
    </GeoJSONSource>
  ),
  renderCard: (mark, host) => (
    <GeodeticPointCard
      mark={mark}
      floating={host.floating}
      offline={host.offline}
      onOpenLink={(url) => host.openLink(url, "Couldn't open the datasheet")}
      onNavigate={() => host.navigateTo(mark.lat, mark.lng)}
      onConvert={() => host.openConvert(prefillFromMark(mark))}
      onCopy={(text, what) => host.copy(text, `Copied ${what}`)}
      onClose={host.close}
    />
  ),
  cardDockTestID: 'geodetic-card-dock',
  recenterOnCard: true,
};
