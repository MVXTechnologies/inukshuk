import { TIDE_TAP_LAYERS } from '@core/map/tideStyle';
import { pickTappedStation, type TideStation } from '@core/tides/station';

/** Half the side of the box a tap searches for a tide station, px (the symbol is ~22 px). */
export const TIDE_HIT_PX = 14;

interface QueryableMap {
  queryRenderedFeatures: (
    box: [[number, number], [number, number]],
    options: { layers: string[] },
  ) => Promise<unknown[]>;
}

/**
 * The tide station under a tap (Overlays → Tide stations), or null. Stations
 * win over the geodetic marks round their harbour; nothing there, or the
 * query unavailable mid-teardown, falls through to the other tap routes.
 */
export async function tideStationAt(
  map: QueryableMap,
  px: number,
  py: number,
  lngLat: readonly [number, number],
): Promise<TideStation | null> {
  try {
    const features = await map.queryRenderedFeatures(
      [
        [px - TIDE_HIT_PX, py - TIDE_HIT_PX],
        [px + TIDE_HIT_PX, py + TIDE_HIT_PX],
      ],
      { layers: [...TIDE_TAP_LAYERS] },
    );
    return pickTappedStation(features, lngLat);
  } catch {
    return null;
  }
}
